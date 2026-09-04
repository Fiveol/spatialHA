"""Device tracker platform for spatialHA Targets."""

from __future__ import annotations

from typing import Any

from homeassistant.components.device_tracker import SourceType
from homeassistant.components.device_tracker.config_entry import TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, LOGGER

try:
    from homeassistant.components.device_tracker import TrackerEntity as _TrackerEntity  # type: ignore[attr-defined]
except ImportError:
    _TrackerEntity = TrackerEntity  # type: ignore[assignment]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up device_tracker entities for each Target."""
    # Load targets
    try:
        from . import _async_load_targets, _compute_target_state
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to import target helpers: %s", err)
        return

    try:
        targets = hass.data.get(DOMAIN, {}).get("targets")
        if targets is None:
            targets = await _async_load_targets(hass)
            hass.data.setdefault(DOMAIN, {})["targets"] = targets
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to load targets for device_tracker: %s", err)
        targets = []

    # Ensure device registry entries
    dev_reg = dr.async_get(hass)
    entities: list[SpatialHATargetTracker] = []

    for target in targets:
        tid = target.get("id")
        if not tid:
            continue
        # Create device
        try:
            device = dev_reg.async_get_or_create(
                config_entry_id=entry.entry_id,
                identifiers={(DOMAIN, tid)},
                name=target.get("name") or f"Target {tid[:8]}",
                manufacturer="spatialHA",
                model=target.get("type") or "Other",
                sw_version="0.2.1",
                via_device_id=None,
            )
            # Set icon via device? Not directly, but entity will have icon
        except Exception as err:  # noqa: BLE001
            LOGGER.debug("Failed to create device for %s: %s", tid, err)

        # Compute initial state
        try:
            ble_data = hass.data.get(DOMAIN, {}).get("ble_data")
            state = _compute_target_state(target, ble_data)
        except Exception:  # noqa: BLE001
            state = "not_home"

        entity = SpatialHATargetTracker(hass, target, state)
        entities.append(entity)

    # Store trackers in hass.data for updates
    trackers: dict[str, SpatialHATargetTracker] = hass.data.setdefault(DOMAIN, {}).setdefault("trackers", {})
    for ent in entities:
        trackers[ent.target_id] = ent

    if entities:
        async_add_entities(entities)

    # Listen for future targets changes via hass.data update? The _async_save_targets will handle via _async_update_target_trackers
    # But we also need to handle new targets added after setup: they will be added via websocket create which tries to forward setup again
    # For simplicity, we don't handle dynamic addition here; the websocket create will need to add entity via async_add_entities
    # We store async_add_entities for later use
    hass.data[DOMAIN]["add_tracker_entities"] = async_add_entities


class SpatialHATargetTracker(TrackerEntity):
    """Representation of a spatialHA Target as Device Tracker."""

    def __init__(self, hass: HomeAssistant, target: dict, initial_state: str) -> None:
        """Initialize tracker."""
        self.hass = hass
        self._target = target
        self.target_id: str = target.get("id")
        self._attr_unique_id = f"{DOMAIN}_{self.target_id}"
        self._attr_name = target.get("name") or f"Target {self.target_id[:8]}"
        self._attr_icon = target.get("icon") or ("mdi:account" if target.get("type") == "Person" else "mdi:help-circle")
        self._state = initial_state  # "home" or "not_home"
        self._attr_source_type = SourceType.BLUETOOTH
        # Device info
        self._attr_device_info = {
            "identifiers": {(DOMAIN, self.target_id)},
            "name": self._attr_name,
            "manufacturer": "spatialHA",
            "model": target.get("type") or "Other",
        }

    @property
    def state(self) -> str | None:
        """Return state."""
        return self._state

    @property
    def location_name(self) -> str | None:
        """Return location name."""
        return self._state

    @property
    def icon(self) -> str | None:
        """Return icon."""
        # Allow per-target icon override
        try:
            # Check if target was updated
            for t in self.hass.data.get(DOMAIN, {}).get("targets", []):
                if t.get("id") == self.target_id and t.get("icon"):
                    return t["icon"]
        except Exception:  # noqa: BLE001
            pass
        return self._attr_icon

    @callback
    def update_target(self, target: dict) -> None:
        """Update target data (name, type, icon, ble_devices)."""
        self._target = target
        self._attr_name = target.get("name") or self._attr_name
        self._attr_icon = target.get("icon") or self._attr_icon
        self._attr_device_info = {
            "identifiers": {(DOMAIN, self.target_id)},
            "name": self._attr_name,
            "manufacturer": "spatialHA",
            "model": target.get("type") or "Other",
        }

    async def async_update_state(self, new_state: str) -> None:
        """Update state from coordinator."""
        if new_state not in ("home", "not_home"):
            # Normalize
            if new_state == "away":
                new_state = "not_home"
        if self._state != new_state:
            self._state = new_state
            self.async_write_ha_state()
        else:
            # Still update name/icon if changed
            # Check if target name/icon changed
            try:
                for t in self.hass.data.get(DOMAIN, {}).get("targets", []):
                    if t.get("id") == self.target_id:
                        if t.get("name") != self._attr_name or t.get("icon") != self._attr_icon:
                            self._attr_name = t.get("name") or self._attr_name
                            self._attr_icon = t.get("icon") or self._attr_icon
                            self.async_write_ha_state()
                        break
            except Exception:  # noqa: BLE001
                pass

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Return extra attributes."""
        try:
            target = next((t for t in self.hass.data.get(DOMAIN, {}).get("targets", []) if t.get("id") == self.target_id), self._target)
            ble_devices = target.get("ble_devices") or target.get("devices") or []
            return {
                "target_type": target.get("type"),
                "ble_devices": ble_devices,
                "target_id": self.target_id,
            }
        except Exception:  # noqa: BLE001
            return {}
