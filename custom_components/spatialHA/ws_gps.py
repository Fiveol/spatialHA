"""WebSocket: GPS listing and subscriptions."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER
from .gps import _get_gps_data


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/gps/list"})
@websocket_api.async_response
async def handle_gps_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """List all device_tracker entities (GPS) from HASS."""
    try:
        data = _get_gps_data(hass)
        connection.send_result(msg["id"], data)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("GPS list failed: %s", err)
        connection.send_error(msg["id"], "gps_list_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/gps/subscribe"})
@websocket_api.async_response
async def handle_gps_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to GPS updates (push when device_tracker changes)."""
    try:
        # Use same pattern as BLE subscribe but for GPS
        data = _get_gps_data(hass)
        subscribers = hass.data.setdefault(DOMAIN, {}).setdefault("gps_subscribers", set())
        subscribers.add((connection, msg["id"]))

        def _unsub():
            try:
                subscribers.discard((connection, msg["id"]))
            except Exception:
                pass

        connection.subscriptions[msg["id"]] = _unsub
        connection.send_result(msg["id"])
        connection.send_message(websocket_api.event_message(msg["id"], {"type": "gps_update", "data": data}))

        # Also listen to state changes for device_tracker
        from homeassistant.helpers.event import async_track_state_change_event

        def _state_listener(event):
            try:
                # Only push if device_tracker changed
                if event and event.data and event.data.get("entity_id", "").startswith("device_tracker."):
                    new_data = _get_gps_data(hass)
                    for conn, mid in list(subscribers):
                        try:
                            conn.send_message(websocket_api.event_message(mid, {"type": "gps_update", "data": new_data}))
                        except Exception:
                            pass
            except Exception:
                pass

        unsub = async_track_state_change_event(hass, "device_tracker", _state_listener)  # type: ignore[attr-defined]
        # Store unsub for cleanup
        orig_unsub = connection.subscriptions[msg["id"]]

        def _combined_unsub():
            try:
                orig_unsub()
            except Exception:
                pass
            try:
                unsub()
            except Exception:
                pass

        connection.subscriptions[msg["id"]] = _combined_unsub
    except Exception as err:  # noqa: BLE001
        LOGGER.error("GPS subscribe failed: %s", err)
        try:
            connection.send_error(msg["id"], "gps_subscribe_failed", str(err))
        except Exception:
            pass
