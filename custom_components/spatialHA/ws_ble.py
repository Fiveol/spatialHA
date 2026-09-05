"""WebSocket: BLE data and subscriptions."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .ble import _get_ble_data
from .const import DOMAIN, LOGGER


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/ble/get_data"})
@websocket_api.async_response
async def handle_ble_get_data(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle BLE data request - all Bluetooth devices via proxies with per-scanner RSSI."""
    try:
        data = _get_ble_data(hass)
        connection.send_result(msg["id"], data)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("BLE get_data failed: %s", err)
        connection.send_error(msg["id"], "ble_get_data_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_ble_data"})
@websocket_api.async_response
async def handle_get_ble_data_alias(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for get_data."""
    await handle_ble_get_data(hass, connection, msg)


@websocket_api.websocket_command({vol.Required("type"): "spatialha/ble/get_data"})
@websocket_api.async_response
async def handle_ble_get_data_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias capital."""
    await handle_ble_get_data(hass, connection, msg)


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/ble/subscribe"})
@websocket_api.async_response
async def handle_ble_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to BLE data pushes every Update Interval (no manual refresh)."""
    try:
        # Ensure BLE data is available
        # Make sure polling is started
        if "ble_unsub_interval" not in hass.data.get(DOMAIN, {}):
            try:
                from . import _async_start_ble_polling

                await _async_start_ble_polling(hass)
            except Exception:  # noqa: BLE001
                pass

        # Send initial data immediately
        data = hass.data.get(DOMAIN, {}).get("ble_data")
        if not data:
            data = _get_ble_data(hass)
            # Cache it
            hass.data.setdefault(DOMAIN, {})["ble_data"] = data

        # Register subscriber
        subscribers = hass.data.setdefault(DOMAIN, {}).setdefault("ble_subscribers", set())
        subscribers.add((connection, msg["id"]))

        # Handle unsubscribe on connection close
        def _unsub():
            try:
                subscribers.discard((connection, msg["id"]))
            except Exception:  # noqa: BLE001
                pass

        connection.subscriptions[msg["id"]] = _unsub

        # Send initial result as event (subscribe pattern)
        connection.send_result(msg["id"])
        # Immediately push current data as event
        connection.send_message(websocket_api.event_message(msg["id"], {"type": "ble_update", "data": data}))
    except Exception as err:  # noqa: BLE001
        LOGGER.error("BLE subscribe failed: %s", err)
        try:
            connection.send_error(msg["id"], "ble_subscribe_failed", str(err))
        except Exception:  # noqa: BLE001
            pass


# --- Targets CRUD ---
