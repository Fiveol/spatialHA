"""The spatialHA integration."""

from __future__ import annotations

import datetime
import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store

from .const import DOMAIN, LOGGER

PANEL_URL = "/api/panels/spatialHA/spatialHA-panel.js"
PANEL_NAME = "spatialHA-panel"
PANEL_TITLE = "spatialHA"
PANEL_ICON = "mdi:account"
PANEL_URL_PATH = "spatialHA"

STORAGE_KEY_SETTINGS = "spatialHA/settings"
STORAGE_KEY_BLE_DATA = "spatialHA/ble_data"
STORAGE_KEY_BLE_SIGHTINGS = "spatialHA/sightings"
STORAGE_KEY_TARGETS = "spatialHA/targets"
STORAGE_VERSION = 1
DEFAULT_UPDATE_INTERVAL = 1.0

# Legacy keys for migration (old files with dot prefix)
LEGACY_STORAGE_KEYS = {
    "spatialHA/settings": "spatialHA.settings",
    "spatialHA/ble_data": "spatialHA.ble_data",
    "spatialHA/sightings": "spatialHA.sightings",
    "spatialHA/targets": "spatialHA.targets",
}


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


def _resolve_js_path_sync() -> pathlib.Path:
    """Blocking path resolution - run in executor."""
    base = pathlib.Path(__file__).parent / "frontend"
    p1 = base / "spatialHA-panel.js"
    if p1.exists():
        return p1
    p2 = base / "spatialHA-panel.js"
    if p2.exists():
        return p2
    candidates = list(base.glob("*.js"))
    if candidates:
        return candidates[0]
    return p1


# --- Storage helpers for Settings and BLE data ( .storage/spatialHA/* ) ---
def _get_settings_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/settings (new folder) - .storage/spatialHA/settings."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_SETTINGS)


def _get_ble_data_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/ble_data."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_BLE_DATA)


def _get_ble_sightings_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/sightings (extra file for future)."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_BLE_SIGHTINGS)


def _get_targets_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/targets."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_TARGETS)


async def _async_migrate_legacy_storage(hass: HomeAssistant, new_key: str) -> None:
    """Migrate legacy dot-prefixed file to folder structure and remove old file."""
    legacy_key = LEGACY_STORAGE_KEYS.get(new_key)
    if not legacy_key:
        return
    # Check if new file already exists
    new_store = Store(hass, STORAGE_VERSION, new_key)
    new_data = await new_store.async_load()
    if new_data is not None:
        # New file exists, just remove legacy if it exists
        try:
            legacy_path = hass.config.path(".storage", legacy_key)
            def _remove():
                import os
                try:
                    if os.path.exists(legacy_path):
                        os.remove(legacy_path)
                        LOGGER.info("Removed legacy storage file %s", legacy_key)
                except Exception as err:  # noqa: BLE001
                    LOGGER.debug("Failed to remove legacy %s: %s", legacy_key, err)
            await hass.async_add_executor_job(_remove)
        except Exception:  # noqa: BLE001
            pass
        return
    # New file doesn't exist, try legacy
    legacy_store = Store(hass, STORAGE_VERSION, legacy_key)
    legacy_data = await legacy_store.async_load()
    if legacy_data is not None:
        # Migrate to new
        await new_store.async_save(legacy_data)
        LOGGER.info("Migrated %s -> %s", legacy_key, new_key)
        # Remove old file
        try:
            legacy_path = hass.config.path(".storage", legacy_key)
            def _remove2():
                import os
                try:
                    if os.path.exists(legacy_path):
                        os.remove(legacy_path)
                except Exception:  # noqa: BLE001
                    pass
            await hass.async_add_executor_job(_remove2)
        except Exception:  # noqa: BLE001
            pass


async def _async_load_with_migration(hass: HomeAssistant, new_key: str) -> dict | None:
    """Load from new folder storage, fallback to legacy dot file and migrate."""
    await _async_migrate_legacy_storage(hass, new_key)
    store = Store(hass, STORAGE_VERSION, new_key)
    return await store.async_load()


async def _async_load_settings(hass: HomeAssistant) -> dict:
    """Load settings from .storage/spatialHA/settings (migrates from spatialHA.settings)."""
    data = await _async_load_with_migration(hass, STORAGE_KEY_SETTINGS)
    if not isinstance(data, dict):
        data = {}
    # Apply defaults
    if "update_interval" not in data:
        data["update_interval"] = DEFAULT_UPDATE_INTERVAL
    # Validate
    try:
        iv = float(data["update_interval"])
        if iv <= 0 or iv > 3600:
            iv = DEFAULT_UPDATE_INTERVAL
        data["update_interval"] = iv
    except Exception:  # noqa: BLE001
        data["update_interval"] = DEFAULT_UPDATE_INTERVAL
    return data


async def _async_save_settings(hass: HomeAssistant, settings: dict) -> None:
    """Save settings to .storage/spatialHA/settings."""
    store = _get_settings_store(hass)
    await store.async_save(settings)
    hass.data.setdefault(DOMAIN, {})["settings"] = settings


async def _async_load_targets(hass: HomeAssistant) -> list[dict]:
    """Load targets from .storage/spatialHA/targets (migrates from spatialHA.targets)."""
    data = await _async_load_with_migration(hass, STORAGE_KEY_TARGETS)
    if isinstance(data, dict) and "targets" in data:
        # Old format: {"targets": [...]}
        targets = data["targets"]
    elif isinstance(data, list):
        targets = data
    else:
        targets = []
    if not isinstance(targets, list):
        targets = []
    return targets


async def _async_save_targets(hass: HomeAssistant, targets: list[dict]) -> None:
    """Save targets to .storage/spatialHA/targets."""
    store = _get_targets_store(hass)
    await store.async_save({"targets": targets})
    hass.data.setdefault(DOMAIN, {})["targets"] = targets
    # Also update device_tracker entities
    try:
        await _async_update_target_trackers(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Failed to update target trackers after save: %s", err)


def _compute_target_state(target: dict, ble_data: dict | None, hass: HomeAssistant | None = None) -> str:
    """Compute target state from assigned BLE + GPS devices. If any Away -> away else home.

    BLE: if any assigned MAC not seen by any scanner (RSSI None) => away
    GPS: if any assigned device_tracker entity state != home => away
    If target has no devices at all => not_home
    """
    ble_devices = target.get("ble_devices") or target.get("devices") or []
    gps_entities = target.get("gps_entities") or target.get("gps_devices") or target.get("device_trackers") or []
    # Normalize
    if isinstance(gps_entities, str):
        gps_entities = [gps_entities]
    if isinstance(ble_devices, str):
        ble_devices = [ble_devices]
    if not ble_devices and not gps_entities:
        return "not_home"

    # Check BLE part
    if ble_devices:
        if not ble_data:
            return "not_home"
        # Build set of seen addresses (upper) - optimized
        seen: set[str] = set()
        for dev in ble_data.get("devices", []):
            per = dev.get("per_scanner") or {}
            # Fast check: any RSSI not None
            for rssi in per.values():
                if rssi is not None:
                    seen.add(str(dev.get("address", "")).upper())
                    break
            else:
                if dev.get("address") and not per:
                    seen.add(str(dev["address"]).upper())
        for sight in ble_data.get("sightings", []):
            if sight.get("rssi") is not None:
                seen.add(str(sight.get("address", "")).upper())

        for addr in ble_devices:
            addr_upper = str(addr).upper()
            if addr_upper not in seen:
                return "not_home"
            # Verify per_scanner has at least one seen
            found = False
            for dev in ble_data.get("devices", []):
                if str(dev.get("address", "")).upper() == addr_upper:
                    per = dev.get("per_scanner") or {}
                    has_seen = any(v is not None for v in per.values())
                    if not has_seen:
                        has_seen = any(str(s.get("address", "")).upper() == addr_upper and s.get("rssi") is not None for s in ble_data.get("sightings", []))
                    if not has_seen:
                        return "not_home"
                    found = True
                    break
            if not found:
                return "not_home"

    # Check GPS part - requires hass to read states
    if gps_entities and hass is not None:
        for entity_id in gps_entities:
            try:
                state = hass.states.get(entity_id)  # type: ignore[attr-defined]
                if state is None:
                    # If entity not found, treat as away
                    return "not_home"
                s = str(state.state).lower()
                if s not in ("home", "not_home"):
                    # For device_tracker, home is home, else away
                    # If state is not home, treat as away
                    if s != "home":
                        return "not_home"
                elif s == "not_home":
                    return "not_home"
            except Exception:
                continue
    elif gps_entities and hass is None:
        # If we don't have hass, we can't check GPS, assume home for now
        # The caller with hass will do proper check in _async_update_target_trackers
        pass

    return "home"


async def _async_update_target_trackers(hass: HomeAssistant) -> None:
    """Update all target device_tracker entities with current BLE state."""
    try:
        # Get current BLE data
        ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
        if not ble_data:
            # Try to load from store
            try:
                ble_store = _get_ble_data_store(hass)
                cached = await ble_store.async_load()
                if isinstance(cached, dict) and cached:
                    ble_data = cached
            except Exception:  # noqa: BLE001
                ble_data = None
        targets = hass.data.get(DOMAIN, {}).get("targets")
        if targets is None:
            targets = await _async_load_targets(hass)
            hass.data.setdefault(DOMAIN, {})["targets"] = targets

        # Update each tracker's state via hass.data[DOMAIN]["trackers"]
        trackers: dict[str, Any] = hass.data.get(DOMAIN, {}).get("trackers", {})
        for target in targets:
            tid = target.get("id")
            if not tid:
                continue
            tracker = trackers.get(tid)
            # If no tracker exists (e.g., target created after setup), skip - it will be created via websocket create
            if not tracker:
                continue
            try:
                # Update target data (name, icon, type) on tracker
                if hasattr(tracker, "update_target"):
                    tracker.update_target(target)  # type: ignore[attr-defined]
                new_state = _compute_target_state(target, ble_data, hass)
                # Update tracker state
                if hasattr(tracker, "async_update_state"):
                    await tracker.async_update_state(new_state)
                else:
                    # Fallback: set state and async_write_ha_state
                    tracker._state = new_state  # type: ignore[attr-defined]
                    if hasattr(tracker, "async_write_ha_state"):
                        tracker.async_write_ha_state()
            except Exception as err:  # noqa: BLE001
                LOGGER.debug("Failed to update tracker %s: %s", tid, err)

        # Push target updates to frontend subscribers
        target_subs = hass.data.get(DOMAIN, {}).get("target_subscribers", set())
        if target_subs:
            try:
                from homeassistant.components import websocket_api as ws_api

                # Build enriched targets with computed state
                enriched = []
                for t in targets:
                    enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or t.get("devices") or []})
                for conn, msg_id in list(target_subs):
                    try:
                        conn.send_message(ws_api.event_message(msg_id, {"type": "targets_update", "targets": enriched}))
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Failed to update target trackers: %s", err)


async def _async_update_ble_data_and_push(hass: HomeAssistant, *_args) -> None:
    """Fetch BLE data, store to .storage/spatialHA.* and push to subscribers."""
    try:
        # Import here to avoid circular import
        from .websocket import _get_ble_data

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

    # Prepare data holders and load persisted settings/ble data/targets
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN].setdefault("ble_subscribers", set())
    hass.data[DOMAIN].setdefault("target_subscribers", set())
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

    # Resolve JS path without blocking event loop
    js_path: pathlib.Path = await hass.async_add_executor_job(_resolve_js_path_sync)

    version_str = await _get_version(hass)
    static_url = PANEL_URL
    legacy_static = "/api/panels/spatialHA/spatialHA-panel.js"
    js_url = f"{static_url}?v={version_str}"

    # Use new async API to avoid blocking I/O
    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(static_url, str(js_path), False),
            ]
        )
        # Register legacy capital URL as well
        if legacy_static != static_url:
            try:
                await hass.http.async_register_static_paths(
                    [StaticPathConfig(legacy_static, str(js_path), False)]
                )
            except Exception:  # noqa: BLE001
                pass
    except AttributeError:
        # Fallback for older HA where async_register_static_paths not available
        try:
            hass.http.register_static_path(static_url, str(js_path), cache_headers=False)  # type: ignore[attr-defined]
            if legacy_static != static_url:
                hass.http.register_static_path(legacy_static, str(js_path), cache_headers=False)  # type: ignore[attr-defined]
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
    remaining_entries = [k for k in hass.data.get(DOMAIN, {}).keys() if k not in ("version", "websocket_registered", "settings", "ble_data", "ble_subscribers", "target_subscribers", "trackers", "ble_unsub_interval", "update_interval", "targets")]
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
