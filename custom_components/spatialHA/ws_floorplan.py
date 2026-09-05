"""WebSocket: floorplan get/set/subscribe."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER
from .floorplan import _async_load_floorplan, _async_save_floorplan


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/floorplan/get"})
@websocket_api.async_response
async def handle_floorplan_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get floorplan."""
    try:
        from .floorplan import _async_load_floorplan

        fp = hass.data.get(DOMAIN, {}).get("floorplan")
        if fp is None:
            fp = await _async_load_floorplan(hass)
            hass.data.setdefault(DOMAIN, {})["floorplan"] = fp
        connection.send_result(msg["id"], fp)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("floorplan get failed: %s", err)
        connection.send_error(msg["id"], "floorplan_get_failed", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatialHA/floorplan/set",
        vol.Optional("floorplan"): dict,
        vol.Optional("floors"): list,
        vol.Optional("units"): str,
        vol.Optional("active_floor_id"): str,
    }
)
@websocket_api.async_response
async def handle_floorplan_set(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Set floorplan (full object)."""
    try:
        from .floorplan import _async_save_floorplan

        # Expect msg contains floorplan dict or fields
        fp = msg.get("floorplan")
        if fp is None:
            # Build from individual fields if provided
            fp = {k: v for k, v in msg.items() if k not in ("type", "id")}
            if not fp:
                raise ValueError("No floorplan data")
        # Basic validation
        if not isinstance(fp, dict) or "floors" not in fp:
            raise ValueError("Invalid floorplan")
        await _async_save_floorplan(hass, fp)
        connection.send_result(msg["id"], fp)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("floorplan set failed: %s", err)
        connection.send_error(msg["id"], "floorplan_set_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/floorplan/subscribe"})
@websocket_api.async_response
async def handle_floorplan_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to floorplan updates."""
    try:
        from .floorplan import _async_load_floorplan

        fp = hass.data.get(DOMAIN, {}).get("floorplan")
        if fp is None:
            fp = await _async_load_floorplan(hass)
            hass.data.setdefault(DOMAIN, {})["floorplan"] = fp

        subs = hass.data.setdefault(DOMAIN, {}).setdefault("floorplan_subscribers", set())
        subs.add((connection, msg["id"]))

        def _unsub():
            try:
                subs.discard((connection, msg["id"]))
            except Exception:
                pass

        connection.subscriptions[msg["id"]] = _unsub
        connection.send_result(msg["id"])
        connection.send_message(websocket_api.event_message(msg["id"], {"type": "floorplan_update", "floorplan": fp}))
    except Exception as err:  # noqa: BLE001
        LOGGER.error("floorplan subscribe failed: %s", err)
        try:
            connection.send_error(msg["id"], "floorplan_subscribe_failed", str(err))
        except Exception:
            pass
