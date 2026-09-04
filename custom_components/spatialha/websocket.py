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


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_version"})
@websocket_api.async_response
async def handle_get_version(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle spatialha/get_version - return current integration version.

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


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_version"})
@websocket_api.async_response
async def handle_get_version_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for capital domain for backward compatibility."""
    await handle_get_version(hass, connection, msg)


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_info"})
@websocket_api.async_response
async def handle_get_info(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Handle spatialha/get_info - generic info passthrough."""
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


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/get_info"})
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
        for sc in scanners_raw:
            try:
                source = getattr(sc, "source", None) or getattr(sc, "adapter", None) or str(sc)
                # Try to get human name
                name = getattr(sc, "name", None)
                if not name:
                    try:
                        # Try adapter_human_name
                        from bluetooth_adapters import adapter_human_name

                        adapter = getattr(sc, "adapter", source)
                        address = getattr(sc, "source", source)
                        name = adapter_human_name(adapter, address)
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
                            # RSSI from ble_device or advertisement
                            sd_rssi = None
                            try:
                                ble_dev = getattr(sd, "ble_device", None)
                                if ble_dev and hasattr(ble_dev, "rssi"):
                                    sd_rssi = ble_dev.rssi
                                adv = getattr(sd, "advertisement", None)
                                if adv and hasattr(adv, "rssi") and adv.rssi is not None:
                                    sd_rssi = adv.rssi
                                if sd_rssi is None:
                                    sd_rssi = rssi
                            except Exception:  # noqa: BLE001
                                sd_rssi = rssi

                            per_scanner[str(sc_source)] = sd_rssi
                            sightings.append(
                                {
                                    "address": address,
                                    "name": str(name),
                                    "rssi": sd_rssi,
                                    "source": str(sc_source),
                                    "scanner_name": str(sc_source),
                                    "service_uuids": uuids,
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
                    }
                else:
                    # Merge per_scanner
                    devices_map[address]["per_scanner"].update(per_scanner)
                    # Update name if more complete
                    if name and name != address and devices_map[address]["name"] == address:
                        devices_map[address]["name"] = str(name)

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
                        }
                    )

        return {"scanners": scanners, "sightings": sightings, "devices": devices}
    except Exception as err:  # noqa: BLE001
        LOGGER.error("Failed to get BLE data: %s", err)
        return {"scanners": [], "sightings": [], "devices": [], "error": str(err)}


@websocket_api.websocket_command({vol.Required("type"): "spatialha/ble/get_data"})
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


@websocket_api.websocket_command({vol.Required("type"): "spatialha/get_ble_data"})
@websocket_api.async_response
async def handle_get_ble_data_alias(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias for get_data."""
    await handle_ble_get_data(hass, connection, msg)


@websocket_api.websocket_command({vol.Required("type"): "spatialHA/ble/get_data"})
@websocket_api.async_response
async def handle_ble_get_data_capital(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Alias capital."""
    await handle_ble_get_data(hass, connection, msg)


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
    hass.data.setdefault(DOMAIN, {})["websocket_registered"] = True
    hass.data.setdefault("spatialHA", {})["websocket_registered"] = True
    LOGGER.info(
        "Registered spatialHA WebSocket commands: spatialha/get_version, spatialha/ble/get_data"
    )
