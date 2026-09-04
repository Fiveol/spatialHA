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


def _get_version(hass: HomeAssistant | None = None) -> str:
    """Get version for cache breaking."""
    try:
        return version(DOMAIN)
    except PackageNotFoundError:
        pass
    try:
        manifest_path = pathlib.Path(__file__).parent / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest.get("version", "0.1.0")
    except Exception:  # noqa: BLE001
        return "0.1.0"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the spatialHA integration (YAML not supported)."""
    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Could not register WebSocket in async_setup: %s", err)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up spatialHA from a config entry and register sidebar panel."""
    LOGGER.debug("Setting up spatialHA entry %s", entry.entry_id)

    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to register WebSocket: %s", err)

    js_path = pathlib.Path(__file__).parent / "frontend" / "spatialha-panel.js"
    # Fallback to old capital filename for backward compat (case-sensitive FS)
    if not js_path.exists():
        js_path = pathlib.Path(__file__).parent / "frontend" / "spatialHA-panel.js"
    # Final fallback: try any panel file
    if not js_path.exists():
        # Search for any js file in frontend
        candidates = list((pathlib.Path(__file__).parent / "frontend").glob("*.js"))
        if candidates:
            js_path = candidates[0]

    static_url = PANEL_URL
    legacy_static = "/api/panels/spatialHA/spatialHA-panel.js"
    version_str = _get_version(hass)
    js_url = f"{static_url}?v={version_str}"

    hass.http.register_static_path(static_url, str(js_path), cache_headers=False)
    # Register legacy capital URL as well to same file for backward compat (supports both casings)
    if legacy_static != static_url:
        try:
            hass.http.register_static_path(legacy_static, str(js_path), cache_headers=False)
        except Exception:  # noqa: BLE001
            pass

    await hass.components.frontend.async_register_built_in_panel(
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

    # Also register capital URL path as alias for backward compat (case-sensitive FS)
    try:
        await hass.components.frontend.async_register_built_in_panel(
            component_name="custom",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            frontend_url_path="spatialHA",
            config={
                "_panel_custom": {
                    "name": "spatialHA-panel",
                    "js_url": js_url,
                    "embed_iframe": False,
                    "trust_external": False,
                }
            },
            require_admin=False,
        )
    except Exception:  # noqa: BLE001
        pass

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {"panel_registered": True}
    # Also alias for capital domain for compatibility
    hass.data.setdefault("spatialHA", {})
    hass.data["spatialHA"][entry.entry_id] = {"panel_registered": True}

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry and remove panel."""
    try:
        hass.components.frontend.async_remove_panel(PANEL_URL_PATH)
        LOGGER.debug("Removed spatialHA panel")
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Could not remove panel: %s", err)
    try:
        hass.components.frontend.async_remove_panel("spatialHA")
    except Exception:  # noqa: BLE001
        pass

    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    hass.data.get("spatialHA", {}).pop(entry.entry_id, None)

    return True
