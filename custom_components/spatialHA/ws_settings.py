"""WebSocket: settings get/set."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from . import _async_start_ble_polling
from .const import DOMAIN, LOGGER
from .storage import (
    _async_load_settings,
    _async_load_tracked,
    _async_save_settings,
    _async_save_tracked,
)


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/settings/get"})
@websocket_api.async_response
async def handle_settings_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get settings (update_interval) - via backend -> HA storage."""
    try:
        from .storage import _async_load_settings as _load_settings

        settings = await _load_settings(hass)
        # Also ensure hass.data cache is updated
        hass.data.setdefault(DOMAIN, {})["settings"] = settings
        connection.send_result(msg["id"], settings)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("settings get failed: %s", err)
        connection.send_error(msg["id"], "settings_get_failed", str(err))


@websocket_api.websocket_command(
    {vol.Required("type"): "spatialHA/settings/set", vol.Optional("update_interval"): vol.Coerce(float)}
)
@websocket_api.async_response
async def handle_settings_set(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Set settings (update_interval) and persist to .storage/spatialHA.settings."""
    try:
        from .storage import _async_load_settings as _load_s, _async_save_settings as _save_s

        # Load current to merge
        current = await _load_s(hass)
        if "update_interval" in msg:
            try:
                iv = float(msg["update_interval"])
                if iv < 0.01:
                    iv = 0.01
                if iv > 3600:
                    iv = 3600
                current["update_interval"] = iv
            except Exception:  # noqa: BLE001
                pass
        # Allow other settings in future (merge any provided keys except type/id)
        for k, v in msg.items():
            if k not in ("type", "id", "update_interval"):
                current[k] = v

        await _save_s(hass, current)
        # Restart polling with new interval
        await _async_start_ble_polling(hass)
        connection.send_result(msg["id"], current)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("settings set failed: %s", err)
        connection.send_error(msg["id"], "settings_set_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/tracked/get"})
@websocket_api.async_response
async def handle_tracked_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get user-tracked BLE addresses - via backend -> HA storage."""
    try:
        tracked = await _async_load_tracked(hass)
        connection.send_result(msg["id"], {"devices": tracked})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("tracked get failed: %s", err)
        connection.send_error(msg["id"], "tracked_get_failed", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatialHA/tracked/set",
        vol.Required("address"): str,
        vol.Required("tracked"): bool,
    }
)
@websocket_api.async_response
async def handle_tracked_set(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Track or untrack a single BLE address and persist."""
    try:
        addr = str(msg.get("address", "")).strip().upper()
        on = bool(msg.get("tracked"))
        current = await _async_load_tracked(hass)
        if on and addr and addr not in current:
            current.append(addr)
        elif not on and addr in current:
            current.remove(addr)
        tracked = await _async_save_tracked(hass, current)
        connection.send_result(msg["id"], {"devices": tracked})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("tracked set failed: %s", err)
        connection.send_error(msg["id"], "tracked_set_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/tracked/clear"})
@websocket_api.async_response
async def handle_tracked_clear(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Clear all tracked BLE addresses."""
    try:
        tracked = await _async_save_tracked(hass, [])
        connection.send_result(msg["id"], {"devices": tracked})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("tracked clear failed: %s", err)
        connection.send_error(msg["id"], "tracked_clear_failed", str(err))
