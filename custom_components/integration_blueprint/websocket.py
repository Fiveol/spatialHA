"""WebSocket API for integration_blueprint - all frontend queries go through backend."""

from __future__ import annotations

import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER


def _get_version(hass: HomeAssistant | None = None) -> str:
    """Get current version of integration for cache breaking and About tab.

    Tries installed package metadata, falls back to manifest.json.
    """
    try:
        return version(DOMAIN)
    except PackageNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass

    try:
        manifest_path = pathlib.Path(__file__).parent / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest.get("version", "0.1.0")
    except Exception:  # noqa: BLE001
        return "0.1.0"


@websocket_api.websocket_command({vol.Required("type"): "integration_blueprint/get_version"})
@websocket_api.async_response
async def handle_get_version(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle integration_blueprint/get_version - return current integration version.

    This is the backend conduit for the About tab. Frontend must NEVER
    query version directly (no fetch), everything passes through here.
    Backend in turn reads from Home Assistant (manifest / package metadata).
    """
    LOGGER.debug("WebSocket get_version called: %s", msg)
    try:
        ver = _get_version(hass)
        connection.send_result(msg["id"], {"version": ver})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get version: %s", err)
        connection.send_error(msg["id"], "get_version_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "integration_blueprint/get_info"})
@websocket_api.async_response
async def handle_get_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle integration_blueprint/get_info - generic info passthrough example.

    Demonstrates architecture where every frontend request goes through
    backend to Home Assistant. Could be extended to proxy any HA data.
    """
    LOGGER.debug("WebSocket get_info called: %s", msg)
    try:
        ver = _get_version(hass)
        # Example of querying HA core directly - backend to HA
        ha_version = hass.config.version if hasattr(hass.config, "version") else "unknown"
        connection.send_result(
            msg["id"],
            {
                "version": ver,
                "domain": DOMAIN,
                "ha_version": ha_version,
            },
        )
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get info: %s", err)
        connection.send_error(msg["id"], "get_info_failed", str(err))


def async_register_websocket(hass: HomeAssistant) -> None:
    """Register integration_blueprint WebSocket commands.

    Called from async_setup / async_setup_entry. Ensures idempotent registration.
    """
    # Use hass.data to avoid double registration on reload
    if hass.data.get(DOMAIN, {}).get("websocket_registered"):
        LOGGER.debug("WebSocket already registered, skipping")
        return

    websocket_api.async_register_command(hass, handle_get_version)
    websocket_api.async_register_command(hass, handle_get_info)
    hass.data.setdefault(DOMAIN, {})["websocket_registered"] = True
    LOGGER.info(
        "Registered integration_blueprint WebSocket commands: integration_blueprint/get_version, integration_blueprint/get_info"
    )
