"""WebSocket: settings get/set."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from . import _async_start_ble_polling
from .const import DOMAIN, LOGGER
from .storage import _async_load_settings, _async_save_settings


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
                if iv < 0.5:
                    iv = 0.5
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
