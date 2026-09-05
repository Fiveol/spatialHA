"""Storage for spatialHA (.storage/spatialHA/*) with legacy migration."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN, LOGGER


STORAGE_KEY_SETTINGS = "spatialHA/settings"
STORAGE_KEY_BLE_DATA = "spatialHA/ble_data"
STORAGE_KEY_BLE_SIGHTINGS = "spatialHA/sightings"
STORAGE_KEY_TARGETS = "spatialHA/targets"
STORAGE_KEY_FLOORPLAN = "spatialHA/floorplan"
STORAGE_KEY_TRACKED = "spatialHA/tracked"
STORAGE_VERSION = 1
DEFAULT_UPDATE_INTERVAL = 1.0

# Legacy keys for migration (old files with dot prefix)
LEGACY_STORAGE_KEYS = {
    "spatialHA/settings": "spatialHA.settings",
    "spatialHA/ble_data": "spatialHA.ble_data",
    "spatialHA/sightings": "spatialHA.sightings",
    "spatialHA/targets": "spatialHA.targets",
    "spatialHA/floorplan": "spatialHA.floorplan",
    "spatialHA/tracked": "spatialHA.tracked",
}


def _get_settings_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/settings (new folder) - .storage/spatialHA/settings."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_SETTINGS)


def _get_ble_data_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/ble_data."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_BLE_DATA)


def _get_ble_sightings_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/sightings (extra file for future)."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_BLE_SIGHTINGS)


def _get_targets_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/targets."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_TARGETS)


def _get_tracked_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/tracked (user-tracked BLE addresses)."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_TRACKED)


async def _async_migrate_legacy_storage(hass: HomeAssistant, new_key: str) -> None:
    """Migrate legacy dot-prefixed file to folder structure and remove old file."""
    legacy_key = LEGACY_STORAGE_KEYS.get(new_key)
    if not legacy_key:
        return
    # Check if new file already exists
    new_store = Store(hass, STORAGE_VERSION, new_key)
    new_data = await new_store.async_load()
    if new_data is not None:
        # New file exists, just remove legacy if it exists
        try:
            legacy_path = hass.config.path(".storage", legacy_key)
            def _remove():
                import os
                try:
                    if os.path.exists(legacy_path):
                        os.remove(legacy_path)
                        LOGGER.info("Removed legacy storage file %s", legacy_key)
                except Exception as err:  # noqa: BLE001
                    LOGGER.debug("Failed to remove legacy %s: %s", legacy_key, err)
            await hass.async_add_executor_job(_remove)
        except Exception:  # noqa: BLE001
            pass
        return
    # New file doesn't exist, try legacy
    legacy_store = Store(hass, STORAGE_VERSION, legacy_key)
    legacy_data = await legacy_store.async_load()
    if legacy_data is not None:
        # Migrate to new
        await new_store.async_save(legacy_data)
        LOGGER.info("Migrated %s -> %s", legacy_key, new_key)
        # Remove old file
        try:
            legacy_path = hass.config.path(".storage", legacy_key)
            def _remove2():
                import os
                try:
                    if os.path.exists(legacy_path):
                        os.remove(legacy_path)
                except Exception:  # noqa: BLE001
                    pass
            await hass.async_add_executor_job(_remove2)
        except Exception:  # noqa: BLE001
            pass


async def _async_load_with_migration(hass: HomeAssistant, new_key: str) -> dict | None:
    """Load from new folder storage, fallback to legacy dot file and migrate."""
    await _async_migrate_legacy_storage(hass, new_key)
    store = Store(hass, STORAGE_VERSION, new_key)
    return await store.async_load()


async def _async_load_settings(hass: HomeAssistant) -> dict:
    """Load settings from .storage/spatialHA/settings (migrates from spatialHA.settings)."""
    data = await _async_load_with_migration(hass, STORAGE_KEY_SETTINGS)
    if not isinstance(data, dict):
        data = {}
    # Apply defaults
    if "update_interval" not in data:
        data["update_interval"] = DEFAULT_UPDATE_INTERVAL
    # Validate
    try:
        iv = float(data["update_interval"])
        if iv <= 0 or iv > 3600:
            iv = DEFAULT_UPDATE_INTERVAL
        data["update_interval"] = iv
    except Exception:  # noqa: BLE001
        data["update_interval"] = DEFAULT_UPDATE_INTERVAL
    return data


async def _async_save_settings(hass: HomeAssistant, settings: dict) -> None:
    """Save settings to .storage/spatialHA/settings."""
    store = _get_settings_store(hass)
    await store.async_save(settings)
    hass.data.setdefault(DOMAIN, {})["settings"] = settings


async def _async_load_targets(hass: HomeAssistant) -> list[dict]:
    """Load targets from .storage/spatialHA/targets (migrates from spatialHA.targets)."""
    data = await _async_load_with_migration(hass, STORAGE_KEY_TARGETS)
    if isinstance(data, dict) and "targets" in data:
        # Old format: {"targets": [...]}
        targets = data["targets"]
    elif isinstance(data, list):
        targets = data
    else:
        targets = []
    if not isinstance(targets, list):
        targets = []
    return targets


def _normalize_tracked(devices) -> list[str]:
    """Normalize tracked list to sorted uppercase address strings."""
    out: list[str] = []
    try:
        items = devices if isinstance(devices, list) else []
        for d in items:
            if not isinstance(d, str):
                continue
            s = d.strip().upper()
            if s and s not in out:
                out.append(s)
    except Exception:  # noqa: BLE001
        pass
    return sorted(out)


async def _async_load_tracked(hass: HomeAssistant) -> list[str]:
    """Load tracked BLE addresses from .storage/spatialHA/tracked."""
    try:
        data = await _async_load_with_migration(hass, STORAGE_KEY_TRACKED)
    except Exception:  # noqa: BLE001
        data = None
    if isinstance(data, dict) and "devices" in data:
        tracked = _normalize_tracked(data.get("devices"))
    elif isinstance(data, list):
        tracked = _normalize_tracked(data)
    else:
        tracked = []
    hass.data.setdefault(DOMAIN, {})["tracked"] = tracked
    return tracked


async def _async_save_tracked(hass: HomeAssistant, devices: list[str]) -> list[str]:
    """Save tracked BLE addresses to .storage/spatialHA/tracked."""
    tracked = _normalize_tracked(devices)
    store = _get_tracked_store(hass)
    await store.async_save({"devices": tracked})
    hass.data.setdefault(DOMAIN, {})["tracked"] = tracked
    return tracked


async def _async_save_targets(hass: HomeAssistant, targets: list[dict]) -> None:
    """Save targets to .storage/spatialHA/targets."""
    store = _get_targets_store(hass)
    await store.async_save({"targets": targets})
    hass.data.setdefault(DOMAIN, {})["targets"] = targets
    # Also update device_tracker entities
    try:
        from .targets import _async_update_target_trackers

        await _async_update_target_trackers(hass)
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Failed to update target trackers after save: %s", err)
