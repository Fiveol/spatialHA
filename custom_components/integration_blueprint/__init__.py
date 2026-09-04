"""The integration_blueprint integration."""

from __future__ import annotations

import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER

PANEL_URL = "/api/panels/integration_blueprint/integration_blueprint-panel.js"
PANEL_NAME = "integration_blueprint-panel"
PANEL_TITLE = "integration_blueprint"
PANEL_ICON = "mdi:account"
PANEL_URL_PATH = "integration_blueprint"


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
    """Set up the integration_blueprint integration."""
    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Could not register WebSocket in async_setup: %s", err)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up integration_blueprint from a config entry and register sidebar panel."""
    LOGGER.debug("Setting up integration_blueprint entry %s", entry.entry_id)

    try:
        from .websocket import async_register_websocket

        async_register_websocket(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to register WebSocket: %s", err)

    js_path = pathlib.Path(__file__).parent / "frontend" / "integration_blueprint-panel.js"
    # Fallback to spatialHA panel if specific file not found
    if not js_path.exists():
        js_path = pathlib.Path(__file__).parent / "frontend" / "spatialHA-panel.js"
        PANEL_URL_FALLBACK = "/api/panels/spatialHA/spatialHA-panel.js"
        static_url = PANEL_URL_FALLBACK
    else:
        static_url = PANEL_URL

    version_str = _get_version(hass)
    js_url = f"{static_url}?v={version_str}"

    hass.http.register_static_path(static_url, str(js_path), cache_headers=False)

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

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {"panel_registered": True}

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry and remove panel."""
    try:
        hass.components.frontend.async_remove_panel(PANEL_URL_PATH)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Could not remove panel: %s", err)

    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return True
