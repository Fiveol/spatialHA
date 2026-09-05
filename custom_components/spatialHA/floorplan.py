"""Floorplan model, defaults, clamping, and storage."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN, LOGGER
from .storage import (
    LEGACY_STORAGE_KEYS,
    STORAGE_KEY_FLOORPLAN,
    STORAGE_VERSION,
    _async_load_with_migration,
)


def _get_floorplan_store(hass: HomeAssistant) -> Store:
    """Get Store for spatialHA/floorplan."""
    return Store(hass, STORAGE_VERSION, STORAGE_KEY_FLOORPLAN)


DOOR_TYPES = ("Door", "Double Door", "Garage Door")
DEFAULT_DOOR_DEFAULTS = {"Door": 0.9, "Double Door": 1.6, "Garage Door": 2.4}
DEFAULT_WINDOW = {"width": 1.2, "height": 1.2, "height_from_floor": 0.9}


def _default_floorplan() -> dict:
    """Return default floorplan with one floor and one point at 0,0 (meters internally)."""
    return {
        "units": "meters",  # display units, internal is meters
        "active_floor_id": "floor_1",
        "door_defaults": dict(DEFAULT_DOOR_DEFAULTS),
        "window_defaults": dict(DEFAULT_WINDOW),
        "floors": [
            {
                "id": "floor_1",
                "name": "Floor 1",
                "level": 0,
                "offset_x": 0.0,
                "offset_y": 0.0,
                "scale": 1.0,
                "rotation": 0.0,
                "width": 10.0,
                "depth": 8.0,
                "height": 3.0,
                "points": [{"id": "point_1", "x": 0.0, "y": 0.0, "label": ""}],
                "walls": [],
                "rooms": [],
                "doors": [],
                "windows": [],
                "receivers": [],
            }
        ],
    }


def _clamp_point_to_floor(floor: dict, x: float, y: float) -> tuple[float, float]:
    """Constrain point to floor dimensions (meters, origin 0,0 corner)."""
    try:
        w = float(floor.get("width", 10.0) or 10.0)
        d = float(floor.get("depth", 8.0) or 8.0)
    except Exception:
        w, d = 10.0, 8.0
    if w <= 0:
        w = 10.0
    if d <= 0:
        d = 8.0
    cx = min(max(float(x), 0.0), w)
    cy = min(max(float(y), 0.0), d)
    return cx, cy


async def _async_load_floorplan(hass: HomeAssistant) -> dict:
    """Load floorplan from .storage/spatialHA/floorplan (migrates)."""
    data = await _async_load_with_migration(hass, STORAGE_KEY_FLOORPLAN)
    if not isinstance(data, dict) or "floors" not in data:
        # Check if old flat structure
        if isinstance(data, dict) and "points" in data:
            return _default_floorplan()
        return _default_floorplan()
    # Ensure defaults
    if "units" not in data:
        data["units"] = "meters"
    if "active_floor_id" not in data or not any(f["id"] == data["active_floor_id"] for f in data.get("floors", [])):
        data["active_floor_id"] = data["floors"][0]["id"] if data.get("floors") else "floor_1"
    data.setdefault("door_defaults", dict(DEFAULT_DOOR_DEFAULTS))
    for k, v in DEFAULT_DOOR_DEFAULTS.items():
        data["door_defaults"].setdefault(k, v)
    data.setdefault("window_defaults", dict(DEFAULT_WINDOW))
    for k, v in DEFAULT_WINDOW.items():
        data["window_defaults"].setdefault(k, v)
    # Ensure each floor has required fields
    for floor in data.get("floors", []):
        floor.setdefault("offset_x", 0.0)
        floor.setdefault("offset_y", 0.0)
        floor.setdefault("scale", 1.0)
        floor.setdefault("rotation", 0.0)
        floor.setdefault("width", 10.0)
        floor.setdefault("depth", 8.0)
        floor.setdefault("height", 3.0)
        floor.setdefault("points", [])
        floor.setdefault("walls", [])
        floor.setdefault("rooms", [])
        floor.setdefault("doors", [])
        floor.setdefault("windows", [])
        floor.setdefault("receivers", [])
        floor.setdefault("scanners", [])
        # Normalize receivers (BLE receiver markers; placement only for now)
        for rx in floor["receivers"]:
            try:
                rx["x"] = float(rx.get("x", 0) or 0)
                rx["y"] = float(rx.get("y", 0) or 0)
            except Exception:
                rx["x"] = 0.0
                rx["y"] = 0.0
            if not rx.get("name"):
                rx["name"] = "Receiver"
        # Normalize scanners (Bluetooth scanner markers; placement only for now)
        for sc in floor["scanners"]:
            try:
                sc["x"] = float(sc.get("x", 0) or 0)
                sc["y"] = float(sc.get("y", 0) or 0)
            except Exception:
                sc["x"] = 0.0
                sc["y"] = 0.0
            if not sc.get("source"):
                sc["source"] = ""
            if not sc.get("name"):
                sc["name"] = sc["source"] or "Scanner"
        # Normalize doors
        for door in floor["doors"]:
            door.setdefault("type", "Door")
            if door["type"] not in DOOR_TYPES:
                door["type"] = "Door"
            door.setdefault("rotation", 0.0)
            door.setdefault("swing", "right" if door["type"] == "Door" else ("left" if door["type"] == "Double Door" else "up"))
            if "width" not in door or not isinstance(door["width"], (int, float)) or door["width"] <= 0:
                door["width"] = data["door_defaults"].get(door["type"], 0.9)
        # Normalize windows (origin = lower left corner, meters internally)
        for win in floor["windows"]:
            win.setdefault("rotation", 0.0)
            for kk in ("width", "height", "height_from_floor"):
                try:
                    vv = float(win.get(kk, 0) or 0)
                except Exception:
                    vv = 0
                if vv <= 0:
                    vv = data["window_defaults"].get(kk, DEFAULT_WINDOW[kk])
                win[kk] = vv
            try:
                win["x"] = float(win.get("x", 0) or 0)
                win["y"] = float(win.get("y", 0) or 0)
            except Exception:
                win["x"] = 0.0
                win["y"] = 0.0
        if not floor["points"]:
            floor["points"] = [{"id": "point_1", "x": 0.0, "y": 0.0, "label": ""}]
        # Clamp existing points into dimensions
        for pt in floor["points"]:
            try:
                cx, cy = _clamp_point_to_floor(floor, float(pt.get("x", 0.0)), float(pt.get("y", 0.0)))
                pt["x"] = cx
                pt["y"] = cy
            except Exception:
                pass
    return data


async def _async_save_floorplan(hass: HomeAssistant, floorplan: dict) -> None:
    """Save floorplan to .storage/spatialHA/floorplan."""
    store = _get_floorplan_store(hass)
    await store.async_save(floorplan)
    hass.data.setdefault(DOMAIN, {})["floorplan"] = floorplan
    # Push to subscribers
    subs = hass.data.get(DOMAIN, {}).get("floorplan_subscribers", set())
    if subs:
        try:
            from homeassistant.components import websocket_api as ws_api

            for conn, msg_id in list(subs):
                try:
                    conn.send_message(ws_api.event_message(msg_id, {"type": "floorplan_update", "floorplan": floorplan}))
                except Exception:
                    pass
        except Exception:
            pass
