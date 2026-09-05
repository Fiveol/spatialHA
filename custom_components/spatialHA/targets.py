"""Targets: home/away state and device_tracker updates."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER
from .storage import _async_load_targets, _get_ble_data_store


def _compute_target_state(target: dict, ble_data: dict | None, hass: HomeAssistant | None = None) -> str:
    """Compute target state from assigned BLE + GPS devices. If any Away -> away else home.

    BLE: if any assigned MAC not seen by any scanner (RSSI None) => away
    GPS: if any assigned device_tracker entity state != home => away
    If target has no devices at all => not_home
    """
    ble_devices = target.get("ble_devices") or target.get("devices") or []
    gps_entities = target.get("gps_entities") or target.get("gps_devices") or target.get("device_trackers") or []
    # Normalize
    if isinstance(gps_entities, str):
        gps_entities = [gps_entities]
    if isinstance(ble_devices, str):
        ble_devices = [ble_devices]
    if not ble_devices and not gps_entities:
        return "not_home"

    # Check BLE part
    if ble_devices:
        if not ble_data:
            return "not_home"
        # Build set of seen addresses (upper) - optimized
        seen: set[str] = set()
        for dev in ble_data.get("devices", []):
            per = dev.get("per_scanner") or {}
            # Fast check: any RSSI not None
            for rssi in per.values():
                if rssi is not None:
                    seen.add(str(dev.get("address", "")).upper())
                    break
            else:
                if dev.get("address") and not per:
                    seen.add(str(dev["address"]).upper())
        for sight in ble_data.get("sightings", []):
            if sight.get("rssi") is not None:
                seen.add(str(sight.get("address", "")).upper())

        for addr in ble_devices:
            addr_upper = str(addr).upper()
            if addr_upper not in seen:
                return "not_home"
            # Verify per_scanner has at least one seen
            found = False
            for dev in ble_data.get("devices", []):
                if str(dev.get("address", "")).upper() == addr_upper:
                    per = dev.get("per_scanner") or {}
                    has_seen = any(v is not None for v in per.values())
                    if not has_seen:
                        has_seen = any(str(s.get("address", "")).upper() == addr_upper and s.get("rssi") is not None for s in ble_data.get("sightings", []))
                    if not has_seen:
                        return "not_home"
                    found = True
                    break
            if not found:
                return "not_home"

    # Check GPS part - requires hass to read states
    if gps_entities and hass is not None:
        for entity_id in gps_entities:
            try:
                state = hass.states.get(entity_id)  # type: ignore[attr-defined]
                if state is None:
                    # If entity not found, treat as away
                    return "not_home"
                s = str(state.state).lower()
                if s not in ("home", "not_home"):
                    # For device_tracker, home is home, else away
                    # If state is not home, treat as away
                    if s != "home":
                        return "not_home"
                elif s == "not_home":
                    return "not_home"
            except Exception:
                continue
    elif gps_entities and hass is None:
        # If we don't have hass, we can't check GPS, assume home for now
        # The caller with hass will do proper check in _async_update_target_trackers
        pass

    return "home"


async def _async_update_target_trackers(hass: HomeAssistant) -> None:
    """Update all target device_tracker entities with current BLE state."""
    try:
        # Get current BLE data
        ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
        if not ble_data:
            # Try to load from store
            try:
                ble_store = _get_ble_data_store(hass)
                cached = await ble_store.async_load()
                if isinstance(cached, dict) and cached:
                    ble_data = cached
            except Exception:  # noqa: BLE001
                ble_data = None
        targets = hass.data.get(DOMAIN, {}).get("targets")
        if targets is None:
            targets = await _async_load_targets(hass)
            hass.data.setdefault(DOMAIN, {})["targets"] = targets

        # Update each tracker's state via hass.data[DOMAIN]["trackers"]
        trackers: dict[str, Any] = hass.data.get(DOMAIN, {}).get("trackers", {})
        for target in targets:
            tid = target.get("id")
            if not tid:
                continue
            tracker = trackers.get(tid)
            # If no tracker exists (e.g., target created after setup), skip - it will be created via websocket create
            if not tracker:
                continue
            try:
                # Update target data (name, icon, type) on tracker
                if hasattr(tracker, "update_target"):
                    tracker.update_target(target)  # type: ignore[attr-defined]
                new_state = _compute_target_state(target, ble_data, hass)
                # Update tracker state
                if hasattr(tracker, "async_update_state"):
                    await tracker.async_update_state(new_state)
                else:
                    # Fallback: set state and async_write_ha_state
                    tracker._state = new_state  # type: ignore[attr-defined]
                    if hasattr(tracker, "async_write_ha_state"):
                        tracker.async_write_ha_state()
            except Exception as err:  # noqa: BLE001
                LOGGER.debug("Failed to update tracker %s: %s", tid, err)

        # Push target updates to frontend subscribers
        target_subs = hass.data.get(DOMAIN, {}).get("target_subscribers", set())
        if target_subs:
            try:
                from homeassistant.components import websocket_api as ws_api

                # Build enriched targets with computed state
                enriched = []
                for t in targets:
                    enriched.append({**t, "state": _compute_target_state(t, ble_data, hass), "ble_devices": t.get("ble_devices") or t.get("devices") or []})
                for conn, msg_id in list(target_subs):
                    try:
                        conn.send_message(ws_api.event_message(msg_id, {"type": "targets_update", "targets": enriched}))
                    except Exception:  # noqa: BLE001
                        pass
            except Exception:  # noqa: BLE001
                pass
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Failed to update target trackers: %s", err)
