"""The spatialHA integration."""

from __future__ import annotations

import datetime
import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval

from .ble import _get_ble_data
from .const import DOMAIN, LOGGER
from .positioning import estimate_positions, rssi_to_distance, trilaterate
from .floorplan import (
    DEFAULT_DOOR_DEFAULTS,
    DEFAULT_WINDOW,
    DOOR_TYPES,
    STORAGE_KEY_FLOORPLAN,
    _async_load_floorplan,
    _async_save_floorplan,
    _clamp_point_to_floor,
    _default_floorplan,
    _get_floorplan_store,
)
from .storage import (
    DEFAULT_UPDATE_INTERVAL,
    STORAGE_KEY_BLE_DATA,
    STORAGE_KEY_BLE_SIGHTINGS,
    STORAGE_KEY_SETTINGS,
    STORAGE_KEY_TARGETS,
    STORAGE_VERSION,
    _async_load_settings,
    _async_load_targets,
    _async_save_settings,
    _async_save_targets,
    _get_ble_data_store,
    _get_ble_sightings_store,
    _get_settings_store,
    _get_targets_store,
)
from .targets import _async_update_target_trackers, _compute_target_state

__all__ = [
    "DEFAULT_DOOR_DEFAULTS",
    "DEFAULT_UPDATE_INTERVAL",
    "DEFAULT_WINDOW",
    "DOMAIN",
    "DOOR_TYPES",
    "PANEL_ICON",
    "PANEL_NAME",
    "PANEL_TITLE",
    "PANEL_URL",
    "PANEL_URL_PATH",
    "STORAGE_KEY_BLE_DATA",
    "STORAGE_KEY_BLE_SIGHTINGS",
    "STORAGE_KEY_FLOORPLAN",
    "STORAGE_KEY_SETTINGS",
    "STORAGE_KEY_TARGETS",
    "STORAGE_VERSION",
    "_async_load_floorplan",
    "_async_load_settings",
    "_async_load_targets",
    "_async_save_floorplan",
    "_async_save_settings",
    "_async_save_targets",
    "_async_start_ble_polling",
    "_async_update_ble_data_and_push",
    "_async_update_target_trackers",
    "_clamp_point_to_floor",
    "_compute_target_state",
    "_default_floorplan",
    "_get_ble_data",
    "estimate_positions",
    "rssi_to_distance",
    "trilaterate",
    "_get_version",
    "async_setup",
    "async_setup_entry",
    "async_unload_entry",
]


PANEL_URL = "/api/panels/spatialHA/spatialHA-panel.js"
PANEL_NAME = "spatialHA-panel"
PANEL_TITLE = "spatialHA"
PANEL_ICON = "mdi:account"
PANEL_URL_PATH = "spatialHA"


def _get_version_sync() -> str:
    """Blocking version lookup - run in executor."""
    try:
        return version(DOMAIN)
    except PackageNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass
    try:
        return version("spatialHA")
    except Exception:  # noqa: BLE001
        pass
    try:
        manifest_path = pathlib.Path(__file__).parent / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest.get("version", "0.1.0")
    except Exception:  # noqa: BLE001
        return "0.1.0"


async def _get_version(hass: HomeAssistant) -> str:
    """Get version without blocking event loop."""
    # Use cached version if available
    cached = hass.data.get(DOMAIN, {}).get("version")
    if cached:
        return cached
    # Also check capital alias cache
    cached = hass.data.get("spatialHA", {}).get("version")
    if cached:
        return cached
    version_str = await hass.async_add_executor_job(_get_version_sync)
    # Cache for future calls
    hass.data.setdefault(DOMAIN, {})["version"] = version_str
    hass.data.setdefault("spatialHA", {})["version"] = version_str
    return version_str


# --- Storage helpers for Settings and BLE data ( .storage/spatialHA/* ) ---


async def _async_update_ble_data_and_push(hass: HomeAssistant, *_args) -> None:
    """Fetch BLE data, store to .storage/spatialHA.* and push to subscribers."""
    try:
        data = _get_ble_data(hass)
        # Add timestamp
        import time

        data["last_updated"] = time.time()
        data["update_interval"] = hass.data.get(DOMAIN, {}).get("settings", {}).get("update_interval", DEFAULT_UPDATE_INTERVAL)

        # Cache in hass.data
        hass.data.setdefault(DOMAIN, {})["ble_data"] = data

        # Persist to storage (non-blocking via Store which uses executor)
        try:
            # Split into two files for future extensibility: ble_data and sightings
            ble_store = _get_ble_data_store(hass)
            sightings_store = _get_ble_sightings_store(hass)
            # Store full data in ble_data, and sightings separately
            await ble_store.async_save({"devices": data.get("devices", []), "scanners": data.get("scanners", []), "last_updated": data["last_updated"]})
            await sightings_store.async_save({"sightings": data.get("sightings", []), "last_updated": data["last_updated"]})
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Failed to save BLE data to storage: %s", err)

        # Push to all BLE subscribers
        subscribers = hass.data.get(DOMAIN, {}).get("ble_subscribers", set())
        if subscribers:
            try:
                from homeassistant.components import websocket_api as ws_api

                for conn, msg_id in list(subscribers):
                    try:
                        conn.send_message(ws_api.event_message(msg_id, {"type": "ble_update", "data": data}))
                    except Exception as err:  # noqa: BLE001
                        LOGGER.debug("Failed to push BLE to %s: %s", conn, err)
            except Exception as err:  # noqa: BLE001
                LOGGER.debug("BLE push failed: %s", err)

        # Also update target trackers based on new BLE data
        try:
            await _async_update_target_trackers(hass)
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Failed to update targets after BLE: %s", err)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("BLE update failed: %s", err)


async def _async_start_ble_polling(hass: HomeAssistant) -> None:
    """Start or restart BLE polling with current update_interval."""
    # Cancel existing
    old_unsub = hass.data.get(DOMAIN, {}).pop("ble_unsub_interval", None)
    if old_unsub:
        try:
            old_unsub()
        except Exception:  # noqa: BLE001
            pass

    # Load settings to get interval
    settings = hass.data.get(DOMAIN, {}).get("settings")
    if not settings:
        settings = await _async_load_settings(hass)
        hass.data.setdefault(DOMAIN, {})["settings"] = settings
        # Also store ble_data if not yet loaded
        try:
            ble_store = _get_ble_data_store(hass)
            cached = await ble_store.async_load()
            if isinstance(cached, dict):
                hass.data.setdefault(DOMAIN, {})["ble_data"] = cached
        except Exception:  # noqa: BLE001
            pass

    interval = float(settings.get("update_interval", DEFAULT_UPDATE_INTERVAL))

    # Immediate first update (even if no frontend)
    await _async_update_ble_data_and_push(hass)

    # Schedule interval - wrap to capture hass, interval callback receives datetime not hass
    try:
        async def _interval_callback(now: datetime.datetime) -> None:
            await _async_update_ble_data_and_push(hass)

        unsub = async_track_time_interval(
            hass, _interval_callback, datetime.timedelta(seconds=interval)
        )
        hass.data.setdefault(DOMAIN, {})["ble_unsub_interval"] = unsub
        LOGGER.info("Started BLE polling every %s seconds", interval)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to start BLE polling: %s", err)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the spatialHA integration (YAML not supported)."""
    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Could not register WebSocket in async_setup: %s", err)

    # Prepare data holders and load persisted settings/ble data/targets/floorplan
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN].setdefault("ble_subscribers", set())
    hass.data[DOMAIN].setdefault("target_subscribers", set())
    hass.data[DOMAIN].setdefault("floorplan_subscribers", set())
    hass.data[DOMAIN].setdefault("trackers", {})
    try:
        settings = await _async_load_settings(hass)
        hass.data[DOMAIN]["settings"] = settings
        # Load targets
        try:
            targets = await _async_load_targets(hass)
            hass.data[DOMAIN]["targets"] = targets
        except Exception:  # noqa: BLE001
            hass.data[DOMAIN]["targets"] = []
        # Load floorplan
        try:
            floorplan = await _async_load_floorplan(hass)
            hass.data[DOMAIN]["floorplan"] = floorplan
        except Exception:  # noqa: BLE001
            hass.data[DOMAIN]["floorplan"] = _default_floorplan()
        # Load cached BLE data if exists
        try:
            ble_store = _get_ble_data_store(hass)
            cached = await ble_store.async_load()
            if isinstance(cached, dict) and cached:
                hass.data[DOMAIN]["ble_data"] = cached
        except Exception:  # noqa: BLE001
            pass
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Failed to load settings: %s", err)
        hass.data[DOMAIN]["settings"] = {"update_interval": DEFAULT_UPDATE_INTERVAL}
        hass.data[DOMAIN]["targets"] = []
        hass.data[DOMAIN]["floorplan"] = _default_floorplan()

    return True


async def _async_remove_all_spatialHA_panels(hass: HomeAssistant) -> None:
    """Remove every spatialHA panel that may exist (handles duplicates)."""
    import inspect

    try:
        from homeassistant.components.frontend import async_remove_panel as _frontend_remove
    except ImportError:
        _frontend_remove = getattr(hass.components.frontend, "async_remove_panel", None)  # type: ignore[attr-defined]
    if _frontend_remove is None:
        return

    # Try to get frontend panels registry
    panels = {}
    try:
        from homeassistant.components.frontend import DATA_PANELS as _DATA_PANELS

        panels = hass.data.get(_DATA_PANELS, {})  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001
        panels = {}
    if not panels:
        panels = hass.data.get("frontend_panels", {})  # fallback

    to_remove: list[str] = []
    # Check all registered panels - case-insensitive for spatialHA
    for url, panel in list(panels.items()):
        try:
            title = getattr(panel, "sidebar_title", None) or getattr(panel, "title", None) or ""
            comp = getattr(panel, "component_name", "") or ""
            furl = getattr(panel, "frontend_url_path", url) or url
            if (
                url.lower() in ("spatialha", "spatialha-panel")
                or furl.lower() in ("spatialha", "spatialha-panel")
                or title == PANEL_TITLE
                or "spatialha" in comp.lower()
                or "spatialha" in url.lower()
            ):
                to_remove.append(url)
        except Exception:  # noqa: BLE001
            continue
    # Always try known variants (both capital and lower for robustness, spatialHA is canonical)
    for variant in ("spatialHA", "spatialha", "spatialHA-panel", "spatialha-panel"):
        if variant not in to_remove:
            to_remove.append(variant)

    for url in set(to_remove):
        try:
            # Use warn_if_unknown=False to avoid log spam for unknown panels
            try:
                res = _frontend_remove(hass, url, warn_if_unknown=False)  # type: ignore[call-arg]
            except TypeError:
                # Fallback for older signature without warn_if_unknown
                res = _frontend_remove(hass, url)  # type: ignore[call-arg]
            if inspect.isawaitable(res):
                await res
            LOGGER.debug("Removed existing spatialHA panel %s", url)
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Could not remove panel %s: %s", url, err)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up spatialHA from a config entry and register sidebar panel."""
    LOGGER.debug("Setting up spatialHA entry %s", entry.entry_id)

    # Remove any lingering panels from previous installs/duplicates before registering
    await _async_remove_all_spatialHA_panels(hass)

    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to register WebSocket: %s", err)

    # Load settings and start BLE polling (every Update Interval, even without frontend)
    try:
        # Ensure settings loaded
        if "settings" not in hass.data.get(DOMAIN, {}):
            settings = await _async_load_settings(hass)
            hass.data.setdefault(DOMAIN, {})["settings"] = settings
        # Ensure targets loaded
        if "targets" not in hass.data.get(DOMAIN, {}):
            try:
                targets = await _async_load_targets(hass)
                hass.data.setdefault(DOMAIN, {})["targets"] = targets
            except Exception:  # noqa: BLE001
                hass.data.setdefault(DOMAIN, {})["targets"] = []
        hass.data.setdefault(DOMAIN, {}).setdefault("target_subscribers", set())
        hass.data.setdefault(DOMAIN, {}).setdefault("trackers", {})
        await _async_start_ble_polling(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to start BLE polling: %s", err)

    # Forward to device_tracker platform to create/update tracker entities
    try:
        await hass.config_entries.async_forward_entry_setups(entry, ["device_tracker"])
    except Exception as err:  # noqa: BLE001
        # Fallback for older HA
        try:
            await hass.config_entries.async_forward_entry_setup(entry, "device_tracker")  # type: ignore[attr-defined]
        except Exception as err2:  # noqa: BLE001
            LOGGER.debug("Failed to forward device_tracker: %s / %s", err, err2)

    # Serve the whole frontend directory (panel + feature modules), no blocking I/O
    frontend_dir = pathlib.Path(__file__).parent / "frontend"
    version_str = await _get_version(hass)
    static_dir = "/api/panels/spatialHA"
    legacy_dir = "/api/panels/spatialha"
    js_url = f"{PANEL_URL}?v={version_str}"

    # Use new async API to avoid blocking I/O
    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(static_dir, str(frontend_dir), False),
            ]
        )
        # Register legacy capital URL as well
        if legacy_dir != static_dir:
            try:
                await hass.http.async_register_static_paths(
                    [StaticPathConfig(legacy_dir, str(frontend_dir), False)]
                )
            except Exception:  # noqa: BLE001
                pass
    except AttributeError:
        # Fallback for older HA where async_register_static_paths not available
        try:
            hass.http.register_static_path(static_dir, str(frontend_dir), cache_headers=False)  # type: ignore[attr-defined]
            if legacy_dir != static_dir:
                hass.http.register_static_path(legacy_dir, str(frontend_dir), cache_headers=False)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass

    # Use direct import for frontend to avoid deprecated hass.components.frontend
    try:
        from homeassistant.components.frontend import async_register_built_in_panel as _frontend_register
    except ImportError:
        _frontend_register = getattr(hass.components.frontend, "async_register_built_in_panel", None)  # type: ignore[attr-defined]

    # Helper to handle both async and sync variants
    import inspect

    async def _register_panel(**kwargs):
        if _frontend_register is None:
            return
        res = _frontend_register(hass, **kwargs)
        if inspect.isawaitable(res):
            await res

    await _register_panel(
        component_name="custom",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        frontend_url_path=PANEL_URL_PATH,
        config={
            "_panel_custom": {
                "name": PANEL_NAME,
                "js_url": js_url,
                "embed_iframe": False,
                "trust_external": False,
            }
        },
        require_admin=False,
    )

    LOGGER.info("Registered spatialHA panel at /%s with js_url %s", PANEL_URL_PATH, js_url)

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {"panel_registered": True}
    # Keep alias for backwards compat where old entries used capital domain
    hass.data.setdefault("spatialHA", {})
    hass.data["spatialHA"][entry.entry_id] = {"panel_registered": True}

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry and remove panel."""
    try:
        await hass.config_entries.async_forward_entry_unload(entry, "device_tracker")
    except Exception:
        try:
            await hass.config_entries.async_forward_entry_unloads(entry, ["device_tracker"])  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass

    await _async_remove_all_spatialHA_panels(hass)

    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    hass.data.get("spatialHA", {}).pop(entry.entry_id, None)

    # If no more entries, clean up version cache and stop BLE polling
    # Check if any config entries remain for this domain
    remaining_entries = [k for k in hass.data.get(DOMAIN, {}).keys() if k not in ("version", "websocket_registered", "settings", "ble_data", "ble_subscribers", "target_subscribers", "gps_subscribers", "floorplan_subscribers", "trackers", "ble_unsub_interval", "update_interval", "targets", "floorplan")]
    if not remaining_entries:
        # Cancel BLE polling
        unsub = hass.data.get(DOMAIN, {}).pop("ble_unsub_interval", None)
        if unsub:
            try:
                unsub()
                LOGGER.info("Stopped BLE polling - no entries remaining")
            except Exception:  # noqa: BLE001
                pass
        hass.data.get(DOMAIN, {}).pop("version", None)
        hass.data.get(DOMAIN, {}).pop("ble_data", None)
        # Keep settings/targets/ble_subscribers for next setup but clean up
    if not hass.data.get("spatialHA") or not any(k != "version" and k != "websocket_registered" for k in hass.data.get("spatialHA", {})):
        hass.data.get("spatialHA", {}).pop("version", None)

    return True
