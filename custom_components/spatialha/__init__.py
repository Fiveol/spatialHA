"""The spatialHA integration."""

from __future__ import annotations

import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER

PANEL_URL = "/api/panels/spatialha/spatialha-panel.js"
PANEL_NAME = "spatialha-panel"
PANEL_TITLE = "spatialHA"
PANEL_ICON = "mdi:account"
PANEL_URL_PATH = "spatialha"


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
    p1 = base / "spatialha-panel.js"
    if p1.exists():
        return p1
    p2 = base / "spatialHA-panel.js"
    if p2.exists():
        return p2
    candidates = list(base.glob("*.js"))
    if candidates:
        return candidates[0]
    return p1


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the spatialHA integration (YAML not supported)."""
    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Could not register WebSocket in async_setup: %s", err)
    return True


async def _async_remove_all_spatialha_panels(hass: HomeAssistant) -> None:
    """Remove every spatialha panel that may exist (handles duplicates)."""
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
    # Check all registered panels
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
    # Always try known variants
    for variant in ("spatialha", "spatialHA", "spatialha-panel", "spatialHA-panel"):
        if variant not in to_remove:
            to_remove.append(variant)

    for url in set(to_remove):
        try:
            res = _frontend_remove(hass, url)  # type: ignore[call-arg]
            if inspect.isawaitable(res):
                await res
            LOGGER.debug("Removed existing spatialha panel %s", url)
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Could not remove panel %s: %s", url, err)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up spatialHA from a config entry and register sidebar panel."""
    LOGGER.debug("Setting up spatialHA entry %s", entry.entry_id)

    # Remove any lingering panels from previous installs/duplicates before registering
    await _async_remove_all_spatialha_panels(hass)

    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to register WebSocket: %s", err)

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
    await _async_remove_all_spatialha_panels(hass)

    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    hass.data.get("spatialHA", {}).pop(entry.entry_id, None)

    # If no more entries, clean up version cache
    if not hass.data.get(DOMAIN) or not any(k != "version" and k != "websocket_registered" for k in hass.data.get(DOMAIN, {})):
        hass.data.get(DOMAIN, {}).pop("version", None)
    if not hass.data.get("spatialHA") or not any(k != "version" and k != "websocket_registered" for k in hass.data.get("spatialHA", {})):
        hass.data.get("spatialHA", {}).pop("version", None)

    return True
