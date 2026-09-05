"""GPS Device Tracker listing."""

from __future__ import annotations

from homeassistant.core import HomeAssistant

from .const import LOGGER


def _get_gps_data(hass: HomeAssistant) -> dict:
    """Get GPS device_tracker entities from HASS, optimized."""
    try:
        # Use entity registry and state machine, cached
        from homeassistant.helpers import entity_registry as er
        from homeassistant.helpers import device_registry as dr

        # Fast path: get all device_tracker states
        states = hass.states.async_all("device_tracker")  # type: ignore[attr-defined]
        # Alternative: hass.states.async_all() and filter?
        if not states:
            # Fallback
            states = [s for s in hass.states.async_all() if s.entity_id.startswith("device_tracker.")]

        gps_entities: list[dict] = []
        # Cache entity registry
        ent_reg = None
        dev_reg = None
        try:
            ent_reg = er.async_get(hass)
            dev_reg = dr.async_get(hass)
        except Exception:
            pass

        for state in states:
            try:
                entity_id = state.entity_id
                # Get entity entry for icon/device
                icon = None
                device_name = None
                try:
                    if ent_reg:
                        ent_entry = ent_reg.async_get(entity_id)
                        if ent_entry:
                            icon = getattr(ent_entry, "icon", None) or getattr(ent_entry, "original_icon", None)
                            device_name = ent_entry.device_id
                            if dev_reg and device_name:
                                dev_entry = dev_reg.async_get(device_name)
                                if dev_entry and dev_entry.name:
                                    device_name = dev_entry.name
                except Exception:
                    pass

                attrs = dict(state.attributes) if hasattr(state, "attributes") else {}
                gps_entities.append(
                    {
                        "entity_id": entity_id,
                        "state": state.state,
                        "name": state.name or attrs.get("friendly_name") or entity_id,
                        "icon": icon or attrs.get("icon") or "mdi:crosshairs-gps",
                        "latitude": attrs.get("latitude"),
                        "longitude": attrs.get("longitude"),
                        "gps_accuracy": attrs.get("gps_accuracy"),
                        "battery": attrs.get("battery"),
                        "source_type": attrs.get("source_type"),
                        "friendly_name": attrs.get("friendly_name"),
                    }
                )
            except Exception:
                continue

        # Sort by entity_id for stable UI
        gps_entities.sort(key=lambda x: x["entity_id"])
        return {"entities": gps_entities, "count": len(gps_entities)}
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Failed to get GPS data: %s", err)
        return {"entities": [], "count": 0, "error": str(err)}
