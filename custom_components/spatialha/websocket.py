"""WebSocket API for spatialHA - all frontend queries go through backend."""

from __future__ import annotations

import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER


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
    """Non-blocking version lookup."""
    # Check cache first
    cached = hass.data.get(DOMAIN, {}).get("version")
    if cached:
        return cached
    cached = hass.data.get("spatialHA", {}).get("version")
    if cached:
        return cached
    ver = await hass.async_add_executor_job(_get_version_sync)
    hass.data.setdefault(DOMAIN, {})["version"] = ver
    hass.data.setdefault("spatialHA", {})["version"] = ver
    return ver


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_version"})
@websocket_api.async_response
async def handle_get_version(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle spatialha/get_version - return current integration version.

    Frontend must NEVER query version directly (no fetch), everything passes through here.
    Backend in turn reads from Home Assistant (manifest / package metadata).
    """
    LOGGER.debug("WebSocket get_version called: %s", msg)
    try:
        ver = await _get_version(hass)
        connection.send_result(msg["id"], {"version": ver})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get version: %s", err)
        connection.send_error(msg["id"], "get_version_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_version"})
@websocket_api.async_response
async def handle_get_version_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for capital domain for backward compatibility."""
    await handle_get_version(hass, connection, msg)


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_info"})
@websocket_api.async_response
async def handle_get_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle spatialha/get_info - generic info passthrough."""
    LOGGER.debug("WebSocket get_info called: %s", msg)
    try:
        ver = await _get_version(hass)
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


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_info"})
@websocket_api.async_response
async def handle_get_info_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for capital domain."""
    await handle_get_info(hass, connection, msg)


def async_register_websocket(hass: HomeAssistant) -> None:
    """Register spatialHA WebSocket commands."""
    if hass.data.get(DOMAIN, {}).get("websocket_registered") or hass.data.get("spatialHA", {}).get(
        "websocket_registered"
    ):
        LOGGER.debug("WebSocket already registered, skipping")
        return

    websocket_api.async_register_command(hass, handle_get_version)
    websocket_api.async_register_command(hass, handle_get_version_capital)
    websocket_api.async_register_command(hass, handle_get_info)
    websocket_api.async_register_command(hass, handle_get_info_capital)
    hass.data.setdefault(DOMAIN, {})["websocket_registered"] = True
    hass.data.setdefault("spatialHA", {})["websocket_registered"] = True
    LOGGER.info(
        "Registered spatialHA WebSocket commands: spatialha/get_version, spatialHA/get_version"
    )
