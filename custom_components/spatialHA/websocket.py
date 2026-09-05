"""WebSocket API for spatialHA - all frontend queries go through backend."""

from __future__ import annotations

import json
import pathlib
from importlib.metadata import PackageNotFoundError, version

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER


def _get_version_sync() -> str:
    """Blocking version lookup - run in executor."""
    try:
        return version(DOMAIN)
    except PackageNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        pass
    try:
        return version("spatialHA")
    except Exception:  # noqa: BLE001
        pass
    try:
        manifest_path = pathlib.Path(__file__).parent / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest.get("version", "0.1.0")
    except Exception:  # noqa: BLE001
        return "0.1.0"


async def _get_version(hass: HomeAssistant) -> str:
    """Non-blocking version lookup."""
    # Check cache first
    cached = hass.data.get(DOMAIN, {}).get("version")
    if cached:
        return cached
    cached = hass.data.get("spatialHA", {}).get("version")
    if cached:
        return cached
    ver = await hass.async_add_executor_job(_get_version_sync)
    hass.data.setdefault(DOMAIN, {})["version"] = ver
    hass.data.setdefault("spatialHA", {})["version"] = ver
    return ver


def _parse_ibeacon(manufacturer_data: dict | None, service_data: dict | None = None) -> dict | None:
    """Parse iBeacon from manufacturer_data. Optimized, no blocking.

    iBeacon is Apple 0x004C: 02 15 + UUID(16) + Major(2) + Minor(2) + TxPower(1)
    Returns {uuid, major, minor, tx_power} or None.
    Handles both int keys and str keys, bytes/bytearray.
    """
    if not manufacturer_data:
        return None
    # Fast path: look for Apple key 76 (0x004C)
    data = None
    # Try common key types
    if isinstance(manufacturer_data, dict):
        data = manufacturer_data.get(0x004C)
        if data is None:
            data = manufacturer_data.get(76)
        if data is None:
            data = manufacturer_data.get("76")
            if data is None:
                data = manufacturer_data.get("0x004C")
        # Fallback scan
        if data is None:
            for k, v in manufacturer_data.items():
                try:
                    if int(k) == 0x004C:
                        data = v
                        break
                except Exception:
                    continue
    if not data or len(data) < 23:
        return None
    # Data should start with 02 15 for iBeacon
    # Some implementations include extra prefix, search for 02 15
    b = bytes(data) if not isinstance(data, (bytes, bytearray)) else data
    # Find iBeacon marker
    idx = -1
    # Optimized search for 0x02 0x15
    for i in range(len(b) - 22):
        if b[i] == 0x02 and b[i + 1] == 0x15:
            idx = i
            break
    if idx == -1:
        # Also check if data directly is iBeacon without prefix (some stacks strip 02 15)
        if len(b) >= 21 and b[0] != 0x02:
            # Try to interpret as raw UUID
            pass
        return None
    if idx + 23 > len(b):
        return None
    try:
        uuid_bytes = b[idx + 2 : idx + 18]
        major = int.from_bytes(b[idx + 18 : idx + 20], "big")
        minor = int.from_bytes(b[idx + 20 : idx + 22], "big")
        tx_power = int.from_bytes(b[idx + 22 : idx + 23], "big", signed=True)
        # Format UUID 8-4-4-4-12
        hex_str = uuid_bytes.hex()
        uuid = f"{hex_str[0:8]}-{hex_str[8:12]}-{hex_str[12:16]}-{hex_str[16:20]}-{hex_str[20:32]}".upper()
        return {"uuid": uuid, "major": major, "minor": minor, "tx_power": tx_power}
    except Exception:
        return None


def _get_ibeacon_from_info(info) -> dict | None:
    """Extract iBeacon from BluetoothServiceInfoBleak info, optimized."""
    try:
        # Try manufacturer_data directly
        mfg = getattr(info, "manufacturer_data", None)
        if mfg:
            parsed = _parse_ibeacon(mfg, None)
            if parsed:
                return parsed
        # Try advertisement
        adv = getattr(info, "advertisement", None)
        if adv:
            mfg2 = getattr(adv, "manufacturer_data", None)
            if mfg2:
                parsed = _parse_ibeacon(mfg2, None)
                if parsed:
                    return parsed
            # Also try service_data for iBeacon UUID
            svc = getattr(adv, "service_data", None) or getattr(info, "service_data", None)
            if svc and isinstance(svc, dict):
                for v in svc.values():
                    try:
                        if isinstance(v, (bytes, bytearray)) and len(v) >= 16:
                            # Try to parse as UUID
                            pass
                    except Exception:
                        continue
        # Try device
        dev = getattr(info, "device", None)
        if dev and hasattr(dev, "details"):
            details = getattr(dev, "details", None)
            if isinstance(details, dict):
                props = details.get("props") or details.get("manufacturer_data")
                if props:
                    parsed = _parse_ibeacon(props, None)
                    if parsed:
                        return parsed
    except Exception:
        pass
    return None


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_version"})
@websocket_api.async_response
async def handle_get_version(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle spatialHA/get_version - return current integration version.

    Frontend must NEVER query version directly (no fetch), everything passes through here.
    Backend in turn reads from Home Assistant (manifest / package metadata).
    """
    LOGGER.debug("WebSocket get_version called: %s", msg)
    try:
        ver = await _get_version(hass)
        connection.send_result(msg["id"], {"version": ver})
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get version: %s", err)
        connection.send_error(msg["id"], "get_version_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_version"})
@websocket_api.async_response
async def handle_get_version_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for capital domain for backward compatibility."""
    await handle_get_version(hass, connection, msg)


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_info"})
@websocket_api.async_response
async def handle_get_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle spatialHA/get_info - generic info passthrough."""
    LOGGER.debug("WebSocket get_info called: %s", msg)
    try:
        ver = await _get_version(hass)
        ha_version = hass.config.version if hasattr(hass.config, "version") else "unknown"
        connection.send_result(
            msg["id"],
            {
                "version": ver,
                "domain": DOMAIN,
                "ha_version": ha_version,
            },
        )
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get info: %s", err)
        connection.send_error(msg["id"], "get_info_failed", str(err))


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_info"})
@websocket_api.async_response
async def handle_get_info_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for capital domain."""
    await handle_get_info(hass, connection, msg)


def _get_ble_data(hass: HomeAssistant) -> dict:
    """Get BLE data from HA bluetooth - scanners, sightings, and per-device RSSI.

    Uses HA bluetooth APIs without blocking. Returns dict with:
    - scanners: list of {source, name, adapter}
    - sightings: list of per-scanner sightings (device x scanner)
    - devices: list of unique devices with per_scanner RSSI map
    - devices_matrix: for device subview
    """
    try:
        from homeassistant.components import bluetooth as bt
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Bluetooth not available: %s", err)
        return {"scanners": [], "sightings": [], "devices": [], "error": "bluetooth not available"}

    try:
        # Get scanners
        scanners_raw = []
        try:
            scanners_raw = bt.async_current_scanners(hass)  # type: ignore[attr-defined]
        except Exception:
            try:
                from homeassistant.components.bluetooth import _get_manager

                mgr = _get_manager(hass)
                scanners_raw = list(getattr(mgr, "_scanners", {}).values()) if hasattr(mgr, "_scanners") else []
                if not scanners_raw:
                    scanners_raw = mgr.async_current_scanners() if hasattr(mgr, "async_current_scanners") else []
            except Exception:  # noqa: BLE001
                scanners_raw = []

        scanners: list[dict] = []
        # Try to get device registry for friendly scanner names
        dev_reg = None
        try:
            from homeassistant.helpers import device_registry as dr

            dev_reg = dr.async_get(hass)
        except Exception:  # noqa: BLE001
            dev_reg = None

        for sc in scanners_raw:
            try:
                source = getattr(sc, "source", None) or getattr(sc, "adapter", None) or str(sc)
                # Try to get human name via device registry first (for Bluetooth proxies)
                name = getattr(sc, "name", None)
                if not name and dev_reg:
                    try:
                        # Find device by bluetooth address
                        for device in dev_reg.devices.values():
                            for conn in device.connections:
                                if conn[0] == "bluetooth" and conn[1].lower() == str(source).lower():
                                    if device.name:
                                        name = device.name
                                        break
                            if name:
                                break
                            # Also check via identifiers
                            for ident in device.identifiers:
                                if ident[1].lower() == str(source).lower():
                                    if device.name:
                                        name = device.name
                                        break
                            if name:
                                break
                    except Exception:  # noqa: BLE001
                        pass
                if not name:
                    try:
                        from bluetooth_adapters import adapter_human_name

                        adapter = getattr(sc, "adapter", source)
                        address = getattr(sc, "source", source)
                        name = adapter_human_name(adapter, address)
                        # Try to get area name as well
                        if dev_reg:
                            try:
                                for device in dev_reg.devices.values():
                                    for conn in device.connections:
                                        if conn[1].lower() == str(source).lower() and device.area_id:
                                            from homeassistant.helpers import area_registry as ar

                                            area_reg = ar.async_get(hass)
                                            area = area_reg.async_get_area(device.area_id)
                                            if area and area.name:
                                                name = f"{name} ({area.name})"
                                                break
                            except Exception:
                                pass
                    except Exception:  # noqa: BLE001
                        name = source
                adapter = getattr(sc, "adapter", source)
                scanners.append(
                    {
                        "source": str(source),
                        "name": str(name),
                        "adapter": str(adapter),
                        "type": sc.__class__.__name__,
                    }
                )
            except Exception:  # noqa: BLE001
                continue

        # If no scanners found, try to get from device registry for proxies
        if not scanners:
            try:
                # Fallback: try to get bluetooth adapters via bluetooth_adapters
                from bluetooth_adapters import get_adapters

                adapters = get_adapters()
                for adapter, details in adapters.items():
                    scanners.append(
                        {
                            "source": str(details.get("address", adapter)),
                            "name": str(adapter),
                            "adapter": str(adapter),
                            "type": "Adapter",
                        }
                    )
            except Exception:  # noqa: BLE001
                pass

        # Get discovered devices
        discovered: list = []
        try:
            discovered = list(bt.async_discovered_service_info(hass, False))  # type: ignore[attr-defined]
        except Exception:
            try:
                discovered = list(bt.async_discovered_service_info(hass))  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                discovered = []

        sightings: list[dict] = []
        devices_map: dict[str, dict] = {}

        for info in discovered:
            try:
                address = getattr(info, "address", None) or getattr(info, "device", None) and getattr(info.device, "address", None)
                if not address:
                    continue
                address = str(address).upper()
                name = getattr(info, "name", None) or getattr(info, "device", None) and getattr(getattr(info, "device"), "name", None) or address
                rssi = getattr(info, "rssi", None)
                source = getattr(info, "source", None) or "unknown"
                # Service UUIDs
                uuids = []
                try:
                    adv = getattr(info, "service_uuids", None)
                    if adv:
                        uuids = list(adv)
                    else:
                        adv_data = getattr(info, "advertisement", None)
                        if adv_data and hasattr(adv_data, "service_uuids"):
                            uuids = list(adv_data.service_uuids)
                except Exception:  # noqa: BLE001
                    uuids = []

                # iBeacon parsing - optimized, handles devices without Names
                ibeacon = _get_ibeacon_from_info(info)
                # If iBeacon found and name is generic (address), use iBeacon UUID as name fallback
                if ibeacon and (not name or name == address or name.strip() == ""):
                    # Use short UUID + major/minor for display, keep full UUID in data
                    try:
                        name = f"iBeacon {ibeacon['uuid'][:8]} ({ibeacon['major']}/{ibeacon['minor']})"
                    except Exception:
                        name = f"iBeacon {ibeacon.get('uuid','')[:8]}"
                # Ensure iBeacon UUID is also in uuids for filtering
                if ibeacon and ibeacon.get("uuid"):
                    try:
                        if ibeacon["uuid"] not in uuids:
                            uuids.append(ibeacon["uuid"])
                    except Exception:
                        pass

                # Per-scanner devices for this address
                per_scanner: dict[str, int | None] = {}
                scanner_devices = []
                try:
                    scanner_devices = bt.async_scanner_devices_by_address(hass, address, False)  # type: ignore[attr-defined]
                except Exception:
                    try:
                        scanner_devices = bt.async_scanner_devices_by_address(hass, address)  # type: ignore[attr-defined]
                    except Exception:  # noqa: BLE001
                        scanner_devices = []

                if scanner_devices:
                    for sd in scanner_devices:
                        try:
                            sc = getattr(sd, "scanner", None)
                            sc_source = getattr(sc, "source", None) if sc else None
                            if not sc_source:
                                sc_source = getattr(sd, "source", source)
                            sc_source = str(sc_source) if sc_source else str(source)
                            # RSSI from ble_device or advertisement with staleness check
                            sd_rssi = None
                            sd_time = None
                            try:
                                ble_dev = getattr(sd, "ble_device", None)
                                if ble_dev and hasattr(ble_dev, "rssi"):
                                    sd_rssi = ble_dev.rssi
                                adv = getattr(sd, "advertisement", None)
                                if adv and hasattr(adv, "rssi") and adv.rssi is not None:
                                    sd_rssi = adv.rssi
                                if sd_rssi is None:
                                    sd_rssi = rssi
                                # Get time for staleness check (monotonic or wall time)
                                if adv and hasattr(adv, "time"):
                                    sd_time = getattr(adv, "time", None)
                                elif ble_dev and hasattr(ble_dev, "details"):
                                    # Try to get time from details
                                    sd_time = getattr(ble_dev, "time", None)
                                # Fallback to info.time
                                if sd_time is None:
                                    sd_time = getattr(info, "time", None)
                            except Exception:  # noqa: BLE001
                                sd_rssi = rssi

                            # Staleness filter: only include if seen within last 180s or update_interval*3
                            # Use monotonic time if available, else wall time
                            try:
                                import time as _time

                                now_monotonic = None
                                try:
                                    from bluetooth_data_tools import monotonic_time_coarse

                                    now_monotonic = monotonic_time_coarse()
                                except Exception:
                                    now_monotonic = _time.monotonic()
                                # sd_time is monotonic if from advertisement, else wall time
                                # If sd_time looks like wall time (>1e9), compare with time.time()
                                # If it looks like monotonic (<1e9), compare with monotonic
                                is_stale = False
                                if sd_time is not None:
                                    try:
                                        # Heuristic: monotonic is < 1e7, wall is >1e9
                                        if sd_time > 1e9:  # wall time
                                            is_stale = (_time.time() - float(sd_time)) > 180
                                        else:  # monotonic
                                            is_stale = (now_monotonic - float(sd_time)) > 180
                                    except Exception:
                                        is_stale = False
                                # If stale, skip this scanner for this device (will be N/A)
                                if is_stale:
                                    continue
                            except Exception:  # noqa: BLE001
                                pass

                            per_scanner[str(sc_source)] = sd_rssi
                            sightings.append(
                                {
                                    "address": address,
                                    "name": str(name),
                                    "rssi": sd_rssi,
                                    "source": str(sc_source),
                                    "scanner_name": str(sc_source),
                                    "service_uuids": uuids,
                                    "ibeacon": ibeacon,
                                }
                            )
                        except Exception:  # noqa: BLE001
                            continue
                else:
                    # Fallback: use single source from info
                    per_scanner[str(source)] = rssi
                    sightings.append(
                        {
                            "address": address,
                            "name": str(name),
                            "rssi": rssi,
                            "source": str(source),
                            "scanner_name": str(source),
                            "service_uuids": uuids,
                            "ibeacon": ibeacon,
                        }
                    )

                # Build device entry
                if address not in devices_map:
                    devices_map[address] = {
                        "address": address,
                        "name": str(name),
                        "rssi": rssi,
                        "service_uuids": uuids,
                        "per_scanner": per_scanner,
                        "ibeacon": ibeacon,
                    }
                else:
                    # Merge per_scanner
                    devices_map[address]["per_scanner"].update(per_scanner)
                    # Update name if more complete
                    if name and name != address and devices_map[address]["name"] == address:
                        devices_map[address]["name"] = str(name)
                    # Update iBeacon if newly discovered
                    if ibeacon and not devices_map[address].get("ibeacon"):
                        devices_map[address]["ibeacon"] = ibeacon
                    # Merge service_uuids
                    try:
                        existing_uuids = set(devices_map[address].get("service_uuids", []))
                        for u in uuids:
                            if u not in existing_uuids:
                                devices_map[address].setdefault("service_uuids", []).append(u)
                    except Exception:
                        pass

            except Exception as err:  # noqa: BLE001
                LOGGER.debug("Error processing discovered info %s: %s", info, err)
                continue

        devices = list(devices_map.values())

        # If no sightings but we have devices, create sightings from devices
        if not sightings and devices:
            for dev in devices:
                for src, rssi_val in dev.get("per_scanner", {}).items():
                    sightings.append(
                        {
                            "address": dev["address"],
                            "name": dev["name"],
                            "rssi": rssi_val,
                            "source": src,
                            "scanner_name": src,
                            "service_uuids": dev.get("service_uuids", []),
                            "ibeacon": dev.get("ibeacon"),
                        }
                    )

        return {"scanners": scanners, "sightings": sightings, "devices": devices}
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get BLE data: %s", err)
        return {"scanners": [], "sightings": [], "devices": [], "error": str(err)}


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


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/settings/get"})
@websocket_api.async_response
async def handle_settings_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get settings (update_interval) - via backend -> HA storage."""
    try:
        from . import _async_load_settings

        settings = await _async_load_settings(hass)
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
        from . import _async_load_settings, _async_save_settings, _async_start_ble_polling

        # Load current to merge
        current = await _async_load_settings(hass)
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

        await _async_save_settings(hass, current)
        # Restart polling with new interval
        await _async_start_ble_polling(hass)
        connection.send_result(msg["id"], current)
    except Exception as err:  # noqa: BLE001
        LOGGER.error("settings set failed: %s", err)
        connection.send_error(msg["id"], "settings_set_failed", str(err))


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
        from . import _async_load_settings

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
@websocket_api.websocket_command({vol.Required("type"): "spatialHA/targets/list"})
@websocket_api.async_response
async def handle_targets_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """List all targets with computed state."""
    try:
        from . import _async_load_targets, _compute_target_state

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

        from . import _async_load_targets, _async_save_targets, _compute_target_state

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
                    from . import _compute_target_state

                    state = _compute_target_state(new_target, ble_data)
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
        from . import _async_load_targets, _async_save_targets, _compute_target_state

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
        from . import _async_load_targets, _async_save_targets, _compute_target_state
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
@websocket_api.websocket_command({vol.Required("type"): "spatialHA/floorplan/get"})
@websocket_api.async_response
async def handle_floorplan_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get floorplan."""
    try:
        from . import _async_load_floorplan

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
        from . import _async_save_floorplan

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
        from . import _async_load_floorplan

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


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/targets/subscribe"})
@websocket_api.async_response
async def handle_targets_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Subscribe to targets updates (pushed on create/update/delete and BLE polling)."""
    try:
        from . import _async_load_targets, _compute_target_state

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


def async_register_websocket(hass: HomeAssistant) -> None:
    """Register spatialHA WebSocket commands."""
    if hass.data.get(DOMAIN, {}).get("websocket_registered") or hass.data.get("spatialHA", {}).get(
        "websocket_registered"
    ):
        LOGGER.debug("WebSocket already registered, skipping")
        return

    websocket_api.async_register_command(hass, handle_get_version)
    websocket_api.async_register_command(hass, handle_get_version_capital)
    websocket_api.async_register_command(hass, handle_get_info)
    websocket_api.async_register_command(hass, handle_get_info_capital)
    websocket_api.async_register_command(hass, handle_ble_get_data)
    websocket_api.async_register_command(hass, handle_get_ble_data_alias)
    websocket_api.async_register_command(hass, handle_ble_get_data_capital)
    websocket_api.async_register_command(hass, handle_settings_get)
    websocket_api.async_register_command(hass, handle_settings_set)
    websocket_api.async_register_command(hass, handle_ble_subscribe)
    websocket_api.async_register_command(hass, handle_gps_list)
    websocket_api.async_register_command(hass, handle_gps_subscribe)
    websocket_api.async_register_command(hass, handle_floorplan_get)
    websocket_api.async_register_command(hass, handle_floorplan_set)
    websocket_api.async_register_command(hass, handle_floorplan_subscribe)
    websocket_api.async_register_command(hass, handle_targets_list)
    websocket_api.async_register_command(hass, handle_targets_create)
    websocket_api.async_register_command(hass, handle_targets_update)
    websocket_api.async_register_command(hass, handle_targets_delete)
    websocket_api.async_register_command(hass, handle_targets_subscribe)
    hass.data.setdefault(DOMAIN, {})["websocket_registered"] = True
    hass.data.setdefault("spatialHA", {})["websocket_registered"] = True
    LOGGER.info(
        "Registered spatialHA WebSocket commands: spatialHA/get_version, spatialHA/ble/*, spatialHA/settings/*, spatialHA/targets/*"
    )
