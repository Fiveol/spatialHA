"""Bluetooth scanning data (including iBeacon parsing)."""

from __future__ import annotations

from homeassistant.core import HomeAssistant

from .const import DOMAIN, LOGGER


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


def _get_ble_data(hass: HomeAssistant) -> dict:
    """Get BLE data from HA bluetooth - scanners, sightings, and per-device RSSI.

    Uses HA bluetooth APIs without blocking. Returns dict with:
    - scanners: list of {source, name, adapter}
    - sightings: list of per-scanner sightings (device x scanner)
    - devices: list of unique devices with per_scanner RSSI map
    - devices_matrix: for device subview
    """
    import time as _time

    try:
        from bluetooth_data_tools import monotonic_time_coarse as _monotonic
    except Exception:  # noqa: BLE001
        _monotonic = _time.monotonic
    try:
        from homeassistant.components import bluetooth as bt
    except Exception as err:  # noqa: BLE001
        LOGGER.debug("Bluetooth not available: %s", err)
        return {"scanners": [], "sightings": [], "devices": [], "positions": [], "error": "bluetooth not available"}

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
        # Device/area registries + helpers, resolved once (not per scanner)
        dev_reg = None
        area_reg = None
        adapter_human_name = None
        try:
            from homeassistant.helpers import device_registry as dr

            dev_reg = dr.async_get(hass)
        except Exception:  # noqa: BLE001
            dev_reg = None
        try:
            from homeassistant.helpers import area_registry as ar

            area_reg = ar.async_get(hass)
        except Exception:  # noqa: BLE001
            area_reg = None
        try:
            from bluetooth_adapters import adapter_human_name as _ahn

            adapter_human_name = _ahn
        except Exception:  # noqa: BLE001
            adapter_human_name = None
        # address (lower) -> (device name, area name), built once
        addr_index: dict[str, tuple[str | None, str | None]] = {}
        if dev_reg:
            try:
                for device in dev_reg.devices.values():
                    area_name = None
                    if device.area_id and area_reg:
                        try:
                            area = area_reg.async_get_area(device.area_id)
                            area_name = area.name if area and area.name else None
                        except Exception:
                            area_name = None
                    for conn in device.connections:
                        try:
                            addr_index.setdefault(str(conn[1]).lower(), (device.name, area_name))
                        except Exception:
                            continue
                    for ident in device.identifiers:
                        try:
                            addr_index.setdefault(str(ident[1]).lower(), (device.name, area_name))
                        except Exception:
                            continue
            except Exception:  # noqa: BLE001
                pass

        for sc in scanners_raw:
            try:
                source = getattr(sc, "source", None) or getattr(sc, "adapter", None) or str(sc)
                # Try to get human name via device registry first (for Bluetooth proxies)
                name = getattr(sc, "name", None)
                if not name:
                    entry = addr_index.get(str(source).lower())
                    if entry and entry[0]:
                        name = entry[0]
                if not name:
                    try:
                        if adapter_human_name is None:
                            raise ImportError("no adapter_human_name")
                        adapter = getattr(sc, "adapter", source)
                        address = getattr(sc, "source", source)
                        name = adapter_human_name(adapter, address)
                        # Append area name as well
                        entry = addr_index.get(str(source).lower())
                        if entry and entry[1]:
                            name = f"{name} ({entry[1]})"
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
                                now_monotonic = _monotonic()
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

        # Rough trilateration from placed floor scanners (needs 3+ per floor)
        positions: list[dict] = []
        try:
            from .positioning import estimate_positions

            floorplan = hass.data.get(DOMAIN, {}).get("floorplan") if hasattr(hass, "data") else None
            positions = estimate_positions({"devices": devices}, floorplan)
            by_addr = {p["address"]: p for p in positions}
            for dev in devices:
                pos = by_addr.get(str(dev.get("address", "")).upper())
                if pos:
                    dev["position"] = pos
        except Exception:  # noqa: BLE001
            positions = []

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

        return {"scanners": scanners, "sightings": sightings, "devices": devices, "positions": positions}
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get BLE data: %s", err)
        return {"scanners": [], "sightings": [], "devices": [], "positions": [], "error": str(err)}
