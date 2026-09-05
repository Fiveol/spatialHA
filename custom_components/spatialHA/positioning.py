"""Rough BLE trilateration from placed floor scanners.

Not perfect or even accurate on purpose: a simple log-distance path-loss
model (RSSI -> meters) plus linearized least-squares trilateration.
Needs at least 3 placed scanners that see a device.
"""

from __future__ import annotations

import math

DEFAULT_TX_POWER = -59.0
DEFAULT_PATH_LOSS_N = 2.0
MIN_DISTANCE = 0.2
MAX_DISTANCE = 50.0


def rssi_to_distance(rssi: float | int | None, tx_power: float = DEFAULT_TX_POWER, n: float = DEFAULT_PATH_LOSS_N) -> float | None:
    """Convert RSSI to rough meters. None if unusable."""
    try:
        r = float(rssi)
    except (TypeError, ValueError):
        return None
    try:
        d = 10.0 ** ((float(tx_power) - r) / (10.0 * float(n)))
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(d):
        return None
    return min(max(d, MIN_DISTANCE), MAX_DISTANCE)


def trilaterate(pts: list[tuple[float, float, float]]) -> tuple[float, float, float] | None:
    """Weighted linearized least squares for [(x, y, distance)].

    Returns (x, y, residual_rmse) or None if degenerate.
    Falls back to inverse-distance weighted centroid.
    """
    use = [(float(x), float(y), float(d)) for x, y, d in pts if d and d > 0]
    if len(use) < 3:
        return None

    def centroid() -> tuple[float, float, float]:
        ws, sx, sy = 0.0, 0.0, 0.0
        for x, y, d in use:
            w = 1.0 / max(d, 0.5) ** 2
            ws += w
            sx += x * w
            sy += y * w
        if ws <= 0:
            return use[0][0], use[0][1], 0.0
        cx, cy = sx / ws, sy / ws
        res = math.sqrt(sum((math.hypot(cx - x, cy - y) - d) ** 2 for x, y, d in use) / len(use))
        return cx, cy, res

    x0, y0, d0 = use[0]
    # Weighted linear system A*[x y] = b, weights 1/d
    s_xx = s_xy = s_yy = s_xb = s_yb = 0.0
    for x, y, d in use[1:]:
        w = 1.0 / max(d, 0.5)
        ax = 2.0 * (x - x0)
        ay = 2.0 * (y - y0)
        b = (d0 * d0 - d * d) + (x * x - x0 * x0) + (y * y - y0 * y0)
        s_xx += w * ax * ax
        s_xy += w * ax * ay
        s_yy += w * ay * ay
        s_xb += w * ax * b
        s_yb += w * ay * b
    det = s_xx * s_yy - s_xy * s_xy
    if abs(det) < 1e-9:
        return centroid()
    cx = (s_xb * s_yy - s_xy * s_yb) / det
    cy = (s_xx * s_yb - s_xb * s_xy) / det
    if not (math.isfinite(cx) and math.isfinite(cy)):
        return centroid()
    res = math.sqrt(sum((math.hypot(cx - x, cy - y) - d) ** 2 for x, y, d in use) / len(use))
    return cx, cy, res


def estimate_positions(ble_data: dict | None, floorplan: dict | None) -> list[dict]:
    """Estimate device positions per floor. Rough by design.

    Returns [{address, name, floor_id, x, y, error, scanners}].
    """
    if not ble_data or not floorplan:
        return []
    devices = ble_data.get("devices") or []
    floors = floorplan.get("floors") or []
    if not devices or not floors:
        return []

    out: list[dict] = []
    for dev in devices:
        try:
            address = str(dev.get("address", "")).upper()
            per = dev.get("per_scanner") or {}
            if not per:
                continue
            # iBeacon TX power when available, else default
            tx = DEFAULT_TX_POWER
            try:
                ib = dev.get("ibeacon") or {}
                if ib.get("tx_power") is not None:
                    tx = float(ib["tx_power"])
            except (TypeError, ValueError):
                pass
            best = None
            for floor in floors:
                fid = floor.get("id")
                pts: list[tuple[float, float, float]] = []
                for sc in floor.get("scanners") or []:
                    try:
                        # Match placed scanner source to sighting sources (case-insensitive)
                        src = str(sc.get("source", "") or "").strip().upper()
                        if not src:
                            continue
                        rssi = per.get(src)
                        if rssi is None:
                            # case-insensitive fallback
                            for k, v in per.items():
                                if str(k).upper() == src:
                                    rssi = v
                                    break
                        d = rssi_to_distance(rssi, tx)
                        if d is None:
                            continue
                        pts.append((float(sc.get("x", 0) or 0), float(sc.get("y", 0) or 0), d))
                    except (TypeError, ValueError):
                        continue
                if len(pts) < 3:
                    continue
                solved = trilaterate(pts)
                if not solved:
                    continue
                cx, cy, res = solved
                # Clamp into floor bounds
                try:
                    fw = float(floor.get("width", 10.0) or 10.0)
                    fd = float(floor.get("depth", 8.0) or 8.0)
                except (TypeError, ValueError):
                    fw, fd = 10.0, 8.0
                cx = min(max(cx, 0.0), fw if fw > 0 else 10.0)
                cy = min(max(cy, 0.0), fd if fd > 0 else 8.0)
                cand = {
                    "address": address,
                    "name": str(dev.get("name") or address),
                    "floor_id": fid,
                    "x": cx,
                    "y": cy,
                    "error": res,
                    "scanners": len(pts),
                }
                # Prefer more scanners, then lower residual
                if best is None or (len(pts), -res) > (best["scanners"], -best["error"]):
                    best = cand
            if best:
                out.append(best)
        except Exception:
            continue
    return out
