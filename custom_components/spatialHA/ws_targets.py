"""WebSocket: targets CRUD and subscriptions."""

from __future__ import annotations

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER
from .storage import _async_load_targets, _async_save_targets
from .targets import _compute_target_state


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/targets/list"})
@websocket_api.async_response
async def handle_targets_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """List all targets with computed state."""
    try:
        from .storage import _async_load_targets
        from .targets import _compute_target_state

        targets = hass.data.get(DOMAIN, {}).get("targets")
        if targets is None:
            targets = await _async_load_targets(hass)
            hass.data.setdefault(DOMAIN, {})["targets"] = targets
        ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
        enriched = []
        for t in targets:
            enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or t.get("devices") or [], "gps_entities": t.get("gps_entities") or []})
        connection.send_result(msg["id"], {"targets": enriched})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("targets list failed: %s", err)
        connection.send_error(msg["id"], "targets_list_failed", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatialHA/targets/create",
        vol.Required("name"): str,
        vol.Optional("target_type", default="Other"): str,
        vol.Optional("icon"): str,
        vol.Optional("ble_devices"): [str],
        vol.Optional("devices"): [str],
    }
)
@websocket_api.async_response
async def handle_targets_create(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Create a new target."""
    try:
        import uuid

        from .storage import _async_load_targets, _async_save_targets
        from .targets import _compute_target_state

        targets = await _async_load_targets(hass)
        # Validate type
        ttype = msg.get("target_type") or msg.get("type") or "Other"
        if ttype not in ("Person", "Other"):
            ttype = "Other"
        icon = msg.get("icon") or ("mdi:account" if ttype == "Person" else "mdi:help-circle")
        ble_devices = msg.get("ble_devices") or msg.get("devices") or []
        ble_devices = [str(a).upper() for a in ble_devices if a]
        gps_entities = msg.get("gps_entities") or msg.get("gps_devices") or msg.get("device_trackers") or []
        if isinstance(gps_entities, str):
            gps_entities = [gps_entities]
        gps_entities = [str(e).strip() for e in gps_entities if e]

        new_target = {
            "id": str(uuid.uuid4()),
            "name": str(msg["name"]).strip() or "Unnamed",
            "type": ttype,
            "icon": icon,
            "ble_devices": ble_devices,
            "gps_entities": gps_entities,
        }
        targets.append(new_target)
        await _async_save_targets(hass, targets)

        # Create device and tracker entity for new target
        try:
            import homeassistant.helpers.device_registry as dr

            # Find a config entry to associate device with
            entry_id = None
            for k in hass.data.get(DOMAIN, {}).keys():
                if k not in ("version", "websocket_registered", "settings", "ble_data", "ble_subscribers", "target_subscribers", "trackers", "ble_unsub_interval", "targets"):
                    # Assume this is a config entry id
                    try:
                        # Verify it's a real entry
                        if hass.config_entries.async_get_entry(k):  # type: ignore[attr-defined]
                            entry_id = k
                            break
                    except Exception:
                        continue
            if entry_id is None:
                # Fallback: get first entry for domain
                entries = hass.config_entries.async_entries(DOMAIN)  # type: ignore[attr-defined]
                if entries:
                    entry_id = entries[0].entry_id

            if entry_id:
                dev_reg = dr.async_get(hass)
                dev_reg.async_get_or_create(
                    config_entry_id=entry_id,
                    identifiers={(DOMAIN, new_target["id"])},
                    name=new_target["name"],
                    manufacturer="spatialHA",
                    model=new_target["type"],
                )
                # Create tracker entity
                try:
                    from .device_tracker import SpatialHATargetTracker

                    ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
                    from .targets import _compute_target_state as _cts

                    state = _cts(new_target, ble_data)
                    tracker = SpatialHATargetTracker(hass, new_target, state)
                    hass.data.setdefault(DOMAIN, {}).setdefault("trackers", {})[new_target["id"]] = tracker
                    add_entities = hass.data.get(DOMAIN, {}).get("add_tracker_entities")
                    if add_entities:
                        # add_entities is async_add_entities callback
                        add_entities([tracker])
                    else:
                        # Fallback: try to get platform and add
                        LOGGER.debug("No add_tracker_entities, tracker will be added on next setup")
                except Exception as err2:  # noqa: BLE001
                    LOGGER.debug("Failed to create tracker entity for %s: %s", new_target["id"], err2)
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Failed to create device for new target: %s", err)

        # Push to subscribers
        try:
            from homeassistant.components import websocket_api as ws_api

            subs = hass.data.get(DOMAIN, {}).get("target_subscribers", set())
            ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
            enriched = []
            for t in targets:
                enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or [], "gps_entities": t.get("gps_entities") or []})
            for conn, mid in list(subs):
                try:
                    conn.send_message(ws_api.event_message(mid, {"type": "targets_update", "targets": enriched}))
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

        connection.send_result(msg["id"], {**new_target, "state": _compute_target_state(new_target, hass.data.get(DOMAIN, {}).get("ble_data"), hass), "gps_entities": new_target.get("gps_entities") or []})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("targets create failed: %s", err)
        connection.send_error(msg["id"], "targets_create_failed", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "spatialHA/targets/update",
        vol.Required("target_id"): str,
        vol.Optional("name"): str,
        vol.Optional("target_type"): str,
        vol.Optional("type"): str,
        vol.Optional("icon"): str,
        vol.Optional("ble_devices"): [str],
        vol.Optional("devices"): [str],
    }
)
@websocket_api.async_response
async def handle_targets_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Update an existing target."""
    try:
        from .storage import _async_load_targets, _async_save_targets
        from .targets import _compute_target_state

        targets = await _async_load_targets(hass)
        tid = msg["target_id"]
        found = None
        for t in targets:
            if t.get("id") == tid:
                found = t
                break
        if not found:
            connection.send_error(msg["id"], "not_found", f"Target {tid} not found")
            return
        if "name" in msg and msg["name"] is not None:
            found["name"] = str(msg["name"]).strip() or found["name"]
        ttype = msg.get("target_type") or msg.get("type")
        if ttype in ("Person", "Other"):
            found["type"] = ttype
            # Update icon default if not explicitly set
            if "icon" not in msg:
                found["icon"] = "mdi:account" if ttype == "Person" else "mdi:help-circle"
        if "icon" in msg and msg["icon"] is not None:
            found["icon"] = str(msg["icon"])
        if "ble_devices" in msg or "devices" in msg:
            ble_devices = msg.get("ble_devices") or msg.get("devices") or []
            found["ble_devices"] = [str(a).upper() for a in ble_devices if a]
        if "gps_entities" in msg or "gps_devices" in msg or "device_trackers" in msg:
            gps_entities = msg.get("gps_entities") or msg.get("gps_devices") or msg.get("device_trackers") or []
            if isinstance(gps_entities, str):
                gps_entities = [gps_entities]
            found["gps_entities"] = [str(e).strip() for e in gps_entities if e]

        await _async_save_targets(hass, targets)

        # Push update
        try:
            from homeassistant.components import websocket_api as ws_api

            subs = hass.data.get(DOMAIN, {}).get("target_subscribers", set())
            ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
            enriched = []
            for t in targets:
                enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or [], "gps_entities": t.get("gps_entities") or []})
            for conn, mid in list(subs):
                try:
                    conn.send_message(ws_api.event_message(mid, {"type": "targets_update", "targets": enriched}))
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

        connection.send_result(msg["id"], {**found, "state": _compute_target_state(found, hass.data.get(DOMAIN, {}).get("ble_data"), hass), "gps_entities": found.get("gps_entities") or []})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("targets update failed: %s", err)
        connection.send_error(msg["id"], "targets_update_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/targets/delete", vol.Required("target_id"): str})
@websocket_api.async_response
async def handle_targets_delete(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Delete a target."""
    try:
        from .storage import _async_load_targets, _async_save_targets
        from .targets import _compute_target_state
        import homeassistant.helpers.device_registry as dr

        targets = await _async_load_targets(hass)
        tid = msg["target_id"]
        new_targets = [t for t in targets if t.get("id") != tid]
        if len(new_targets) == len(targets):
            connection.send_error(msg["id"], "not_found", f"Target {tid} not found")
            return
        await _async_save_targets(hass, new_targets)

        # Remove device from HA device registry
        try:
            dev_reg = dr.async_get(hass)
            device = dev_reg.async_get_device(identifiers={(DOMAIN, tid)})
            if device:
                dev_reg.async_remove_device(device.id)
        except Exception:  # noqa: BLE001
            pass

        # Remove tracker from hass.data
        try:
            hass.data.get(DOMAIN, {}).get("trackers", {}).pop(tid, None)
        except Exception:  # noqa: BLE001
            pass

        # Push update
        try:
            from homeassistant.components import websocket_api as ws_api

            subs = hass.data.get(DOMAIN, {}).get("target_subscribers", set())
            ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
            enriched = []
            for t in new_targets:
                enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or [], "gps_entities": t.get("gps_entities") or []})
            for conn, mid in list(subs):
                try:
                    conn.send_message(ws_api.event_message(mid, {"type": "targets_update", "targets": enriched}))
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass

        connection.send_result(msg["id"], {"deleted": tid})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("targets delete failed: %s", err)
        connection.send_error(msg["id"], "targets_delete_failed", str(err))


# --- Floorplan ---


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/targets/subscribe"})
@websocket_api.async_response
async def handle_targets_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to targets updates (pushed on create/update/delete and BLE polling)."""
    try:
        from .storage import _async_load_targets
        from .targets import _compute_target_state

        targets = hass.data.get(DOMAIN, {}).get("targets")
        if targets is None:
            targets = await _async_load_targets(hass)
            hass.data.setdefault(DOMAIN, {})["targets"] = targets
        ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
        enriched = []
        for t in targets:
            enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or [], "gps_entities": t.get("gps_entities") or []})

        subs = hass.data.setdefault(DOMAIN, {}).setdefault("target_subscribers", set())
        subs.add((connection, msg["id"]))

        def _unsub():
            try:
                subs.discard((connection, msg["id"]))
            except Exception:  # noqa: BLE001
                pass

        connection.subscriptions[msg["id"]] = _unsub
        connection.send_result(msg["id"])
        connection.send_message(websocket_api.event_message(msg["id"], {"type": "targets_update", "targets": enriched}))
    except Exception as err:  # noqa: BLE001
        LOGGER.error("targets subscribe failed: %s", err)
        try:
            connection.send_error(msg["id"], "targets_subscribe_failed", str(err))
        except Exception:  # noqa: BLE001
            pass
