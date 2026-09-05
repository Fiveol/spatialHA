"""Rough BLE trilateration from placed floor scanners.

Not perfect or even accurate on purpose: a simple log-distance path-loss
model (RSSI -> meters) plus linearized least-squares trilateration.
Works in 3D across floors: anchors from every placed scanner on every
floor are combined, so e.g. 2 scanners downstairs + 1 upstairs still
solves (x, y, z).
"""

from __future__ import annotations

import math

DEFAULT_TX_POWER = -59.0
DEFAULT_PATH_LOSS_N = 2.0
MIN_DISTANCE = 0.2
MAX_DISTANCE = 50.0
SCANNER_HEIGHT = 1.0
# Must match the GAP in frontend/modules/home3d.js stacking so z lines up.
FLOOR_GAP = 1.5
# Anchors spanning less than this in z are treated as coplanar: z is
# unobservable from RSSI at that point, so solve x/y in 2D and hold z.
COPLANAR_Z_EPS = 0.5


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


def floor_bases(floors: list[dict]) -> list[float]:
    """Stacked base heights in level order using real floor heights."""
    ordered = sorted(enumerate(floors), key=lambda t: (t[1].get("level", 0), t[0]))
    bases = [0.0] * len(floors)
    zb = 0.0
    for idx, floor in ordered:
        bases[idx] = zb
        try:
            zb += float(floor.get("height", 3.0) or 3.0) + FLOOR_GAP
        except (TypeError, ValueError):
            zb += 3.0
    return bases


def _solve_3x3(m: list[list[float]], v: list[float]) -> list[float] | None:
    """Solve 3x3 M x = v via Cramer. None if singular/non-finite."""
    try:
        det = (
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        )
        if abs(det) < 1e-12 or not math.isfinite(det):
            return None
        inv = [
            [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det,
             (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det,
             (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
            [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det,
             (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det,
             (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
            [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det,
             (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det,
             (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det],
        ]
        return [
            inv[0][0] * v[0] + inv[0][1] * v[1] + inv[0][2] * v[2],
            inv[1][0] * v[0] + inv[1][1] * v[1] + inv[1][2] * v[2],
            inv[2][0] * v[0] + inv[2][1] * v[1] + inv[2][2] * v[2],
        ]
    except (ArithmeticError, ValueError, IndexError):
        return None


def _three_sphere_candidates(
    p1: tuple[float, float, float, float],
    p2: tuple[float, float, float, float],
    p3: tuple[float, float, float, float],
) -> list[tuple[float, float, float]]:
    """Analytic intersection of 3 spheres (trilateration basis).

    Returns 0, 1, or 2 points (mirrored across the anchor plane).
    With noisy RSSI distances the spheres may not intersect exactly;
    then returns the single projection onto the anchor plane.
    """
    try:
        x1, y1, z1, d1 = p1
        x2, y2, z2, d2 = p2
        x3, y3, z3, d3 = p3
        # ex = (p2-p1)/|p2-p1|
        dx, dy, dz = x2 - x1, y2 - y1, z2 - z1
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if d < 1e-9 or not math.isfinite(d):
            return []
        ex = (dx / d, dy / d, dz / d)
        # i = ex . (p3-p1)
        ax, ay, az = x3 - x1, y3 - y1, z3 - z1
        i = ex[0] * ax + ex[1] * ay + ex[2] * az
        # ey = (p3-p1 - ex*i)/|..|
        tx, ty, tz = ax - ex[0] * i, ay - ex[1] * i, az - ex[2] * i
        j = math.sqrt(tx * tx + ty * ty + tz * tz)
        if j < 1e-9 or not math.isfinite(j):
            return []  # collinear
        ey = (tx / j, ty / j, tz / j)
        ez = (
            ex[1] * ey[2] - ex[2] * ey[1],
            ex[2] * ey[0] - ex[0] * ey[2],
            ex[0] * ey[1] - ex[1] * ey[0],
        )
        x = (d1 * d1 - d2 * d2 + d * d) / (2.0 * d)
        y = (d1 * d1 - d3 * d3 + i * i + j * j) / (2.0 * j) - (i / j) * x
        z2 = d1 * d1 - x * x - y * y
        if not math.isfinite(x) or not math.isfinite(y) or not math.isfinite(z2):
            return []
        base = (
            x1 + ex[0] * x + ey[0] * y,
            y1 + ex[1] * x + ey[1] * y,
            z1 + ex[2] * x + ey[2] * y,
        )
        if z2 < 0:
            # No exact intersection (noisy ranges): closest point on plane.
            if all(math.isfinite(c) for c in base):
                return [base]
            return []
        z = math.sqrt(z2)
        p_plus = (base[0] + ez[0] * z, base[1] + ez[1] * z, base[2] + ez[2] * z)
        if z < 1e-6:
            return [p_plus] if all(math.isfinite(c) for c in p_plus) else []
        p_minus = (base[0] - ez[0] * z, base[1] - ez[1] * z, base[2] - ez[2] * z)
        out = [p for p in (p_plus, p_minus) if all(math.isfinite(c) for c in p)]
        return out
    except (ArithmeticError, ValueError):
        return []


def solve_3d(anchors: list[tuple[float, float, float, float]]) -> tuple[float, float, float, float] | None:
    """Rough 3D solve for [(x, y, z, distance)].

    Combines anchors from all floors, so a split like 2 scanners on one
    floor + 1 on another still solves. Needs 3+ non-collinear anchors
    for a full 3D fix; with exactly 3 the sphere intersection has two
    mirror solutions and the one nearer the strongest (closest) anchor
    wins. Coplanar anchors (all same height) degrade to a 2D fix with z
    held at the anchor mean. Falls back to a weighted centroid with 2
    anchors. Returns (x, y, z, residual_rmse).
    """
    pts = [(float(x), float(y), float(z), float(d)) for x, y, z, d in anchors if d and d > 0]
    if len(pts) < 2:
        return None
    if len(pts) == 2:
        (x1, y1, z1, d1), (x2, y2, z2, d2) = pts
        w1, w2 = 1.0 / max(d1, 0.5) ** 2, 1.0 / max(d2, 0.5) ** 2
        ws = w1 + w2
        cx, cy, cz = (x1 * w1 + x2 * w2) / ws, (y1 * w1 + y2 * w2) / ws, (z1 * w1 + z2 * w2) / ws
        res = math.sqrt(((math.sqrt((cx - x1) ** 2 + (cy - y1) ** 2 + (cz - z1) ** 2) - d1) ** 2
                         + (math.sqrt((cx - x2) ** 2 + (cy - y2) ** 2 + (cz - z2) ** 2) - d2) ** 2) / 2.0)
        return cx, cy, cz, res

    def weight(d: float) -> float:
        return 1.0 / max(d, 0.5)

    def centroid() -> tuple[float, float, float, float]:
        ws, sx, sy, sz = 0.0, 0.0, 0.0, 0.0
        for x, y, z, d in pts:
            w = 1.0 / max(d, 0.5) ** 2
            ws += w
            sx += x * w
            sy += y * w
            sz += z * w
        cx, cy, cz = sx / ws, sy / ws, sz / ws
        res = math.sqrt(sum((math.sqrt((cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2) - d) ** 2
                            for x, y, z, d in pts) / len(pts))
        return cx, cy, cz, res

    def residual(x: float, y: float, z: float) -> float:
        return math.sqrt(sum((math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2) - pd) ** 2
                             for px, py, pz, pd in pts) / len(pts))

    def weighted_cost(x: float, y: float, z: float) -> float:
        tot, ws = 0.0, 0.0
        for px, py, pz, pd in pts:
            w = weight(pd)
            r = math.sqrt((x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2) - pd
            tot += w * r * r
            ws += w
        return tot / ws if ws > 0 else float("inf")

    # Coplanar (typically single-floor, all scanners at same height):
    # z is unobservable -> solve x/y in 2D, hold z at weighted mean.
    zs = [p[2] for p in pts]
    if max(zs) - min(zs) < COPLANAR_Z_EPS:
        flat = [(x, y, d) for x, y, _z, d in pts]
        got = trilaterate(flat)  # type: ignore[arg-type]
        if got is None:
            return centroid()
        cx, cy, _r2 = got
        ws, sz = 0.0, 0.0
        for x, y, z, d in pts:
            w = 1.0 / max(d, 0.5) ** 2
            ws += w
            sz += z * w
        cz = sz / ws if ws > 0 else zs[0]
        if not (math.isfinite(cx) and math.isfinite(cy) and math.isfinite(cz)):
            return centroid()
        return cx, cy, cz, residual(cx, cy, cz)

    # Weighted centroid start + strongest anchor (for mirror tie-breaks).
    ws, sx, sy, sz = 0.0, 0.0, 0.0, 0.0
    for x, y, z, d in pts:
        w = 1.0 / max(d, 0.5) ** 2
        ws += w
        sx += x * w
        sy += y * w
        sz += z * w
    cx0, cy0, cz0 = sx / ws, sy / ws, sz / ws
    by_dist = sorted(pts, key=lambda p: p[3])
    nearest = by_dist[0]

    def refine(scx: float, scy: float, scz: float) -> tuple[float, float, float, float]:
        """Weighted Gauss-Newton with light damping; returns best seen."""
        cx, cy, cz = scx, scy, scz
        best = (cx, cy, cz, weighted_cost(cx, cy, cz))
        damp = 1e-4
        for _ in range(60):
            m = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
            v = [0.0, 0.0, 0.0]
            for x, y, z, d in pts:
                dx, dy, dz = cx - x, cy - y, cz - z
                pred = math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9
                r = pred - d
                w = weight(d)
                jx, jy, jz = dx / pred, dy / pred, dz / pred
                m[0][0] += w * jx * jx
                m[0][1] += w * jx * jy
                m[0][2] += w * jx * jz
                m[1][1] += w * jy * jy
                m[1][2] += w * jy * jz
                m[2][2] += w * jz * jz
                v[0] += w * jx * r
                v[1] += w * jy * r
                v[2] += w * jz * r
            m[1][0] = m[0][1]
            m[2][0] = m[0][2]
            m[2][1] = m[1][2]
            # Levenberg-Marquardt damping for ill-conditioned geometry.
            m[0][0] += damp
            m[1][1] += damp
            m[2][2] += damp
            step = _solve_3x3(m, v)
            if step is None or not all(math.isfinite(s) for s in step):
                damp *= 10.0
                if damp > 1e6:
                    break
                continue
            cap = 5.0
            nx = cx - max(-cap, min(cap, step[0]))
            ny = cy - max(-cap, min(cap, step[1]))
            nz = cz - max(-cap, min(cap, step[2]))
            if not (math.isfinite(nx) and math.isfinite(ny) and math.isfinite(nz)):
                damp *= 10.0
                continue
            new_cost = weighted_cost(nx, ny, nz)
            if new_cost < best[3] and math.isfinite(new_cost):
                best = (nx, ny, nz, new_cost)
                cx, cy, cz = nx, ny, nz
                damp = max(1e-7, damp / 5.0)
                if abs(step[0]) + abs(step[1]) + abs(step[2]) < 1e-4:
                    break
            else:
                damp *= 5.0
                if damp > 1e6:
                    break
                # Keep current point on rejection; shrink step implicitly
                # via increased damping next round.
                if abs(step[0]) + abs(step[1]) + abs(step[2]) < 1e-6:
                    break
        return best

    # Diverse starts so both mirrors of a 3-anchor fix are explored.
    starts: list[tuple[float, float, float]] = [(cx0, cy0, cz0)]
    z_lo, z_hi = min(zs), max(zs)
    starts.append((cx0, cy0, z_lo))
    starts.append((cx0, cy0, z_hi))
    starts.append((nearest[0], nearest[1], nearest[2]))
    for p in by_dist[:4]:
        starts.append((p[0], p[1], p[2]))
    # Analytic mirrors from the 3 strongest anchors (exact for ==3).
    if len(by_dist) >= 3:
        for c in _three_sphere_candidates(by_dist[0], by_dist[1], by_dist[2]):
            starts.append(c)
    # Linearized least-squares init as one more seed (needs 4+ anchors).
    if len(pts) >= 4:
        try:
            x0, y0, z0, d0 = pts[0]
            nxx = nxy = nxz = nyy = nyz = nzz = bx = by = bz = 0.0
            for x, y, z, d in pts[1:]:
                w = weight(d)
                ax, ay, az = 2.0 * (x - x0), 2.0 * (y - y0), 2.0 * (z - z0)
                b = (d0 * d0 - d * d) + (x * x - x0 * x0) + (y * y - y0 * y0) + (z * z - z0 * z0)
                nxx += w * ax * ax
                nxy += w * ax * ay
                nxz += w * ax * az
                nyy += w * ay * ay
                nyz += w * ay * az
                nzz += w * az * az
                bx += w * ax * b
                by += w * ay * b
                bz += w * az * b
            lin = _solve_3x3(
                [[nxx, nxy, nxz], [nxy, nyy, nyz], [nxz, nyz, nzz]],
                [bx, by, bz],
            )
            if lin and all(math.isfinite(c) for c in lin):
                starts.append((lin[0], lin[1], lin[2]))
        except (ArithmeticError, ValueError):
            pass

    best: tuple[float, float, float, float] | None = None
    try:
        for scx, scy, scz in starts:
            if not (math.isfinite(scx) and math.isfinite(scy) and math.isfinite(scz)):
                continue
            rx, ry, rz, cost = refine(scx, scy, scz)
            if not (math.isfinite(rx) and math.isfinite(ry) and math.isfinite(rz) and math.isfinite(cost)):
                continue
            if best is None or cost < best[3] - 1e-9:
                best = (rx, ry, rz, cost)
            elif abs(cost - best[3]) <= 1e-9:
                # Mirror tie: prefer the fix nearer the strongest anchor
                # (same floor as the closest scanner).
                if abs(rz - nearest[2]) < abs(best[2] - nearest[2]):
                    best = (rx, ry, rz, cost)
        if best is None:
            return centroid()
        cx, cy, cz, _cost = best
        return cx, cy, cz, residual(cx, cy, cz)
    except (ArithmeticError, ValueError):
        return centroid()


def _floor_frame(floor: dict) -> tuple[float, float, float, float, float]:
    """Return (scale, offset_x, offset_y, cos_rot, sin_rot) for a floor.

    Mirrors frontend/modules/fp-data.js _worldToScreen so backend anchors
    share one world XY frame even when floors are offset/scaled/rotated.
    Floor rotation is stored in radians (frontend writes radians); values
    that look like degrees are tolerated.
    """
    try:
        scale = float(floor.get("scale", 1.0) or 1.0)
    except (TypeError, ValueError):
        scale = 1.0
    if not math.isfinite(scale) or scale == 0:
        scale = 1.0
    try:
        ox = float(floor.get("offset_x", 0.0) or 0.0)
    except (TypeError, ValueError):
        ox = 0.0
    try:
        oy = float(floor.get("offset_y", 0.0) or 0.0)
    except (TypeError, ValueError):
        oy = 0.0
    try:
        rot = float(floor.get("rotation", 0.0) or 0.0)
    except (TypeError, ValueError):
        rot = 0.0
    if math.isfinite(rot) and abs(rot) > 2 * math.pi and abs(rot) <= 360.0:
        rot = math.radians(rot)
    if not math.isfinite(rot):
        rot = 0.0
    if not math.isfinite(ox):
        ox = 0.0
    if not math.isfinite(oy):
        oy = 0.0
    return scale, ox, oy, math.cos(rot), math.sin(rot)


def _to_world(floor: dict, x: float, y: float) -> tuple[float, float]:
    """Floor-local (x, y) -> shared world XY."""
    scale, ox, oy, cos_r, sin_r = _floor_frame(floor)
    sx = x * scale + ox
    sy = y * scale + oy
    return sx * cos_r - sy * sin_r, sx * sin_r + sy * cos_r


def _to_local(floor: dict, wx: float, wy: float) -> tuple[float, float]:
    """Shared world XY -> floor-local (x, y)."""
    scale, ox, oy, cos_r, sin_r = _floor_frame(floor)
    # Inverse rotation, then inverse scale/offset.
    rx = wx * cos_r + wy * sin_r
    ry = -wx * sin_r + wy * cos_r
    return (rx - ox) / scale, (ry - oy) / scale


def estimate_positions(ble_data: dict | None, floorplan: dict | None) -> list[dict]:
    """Estimate device positions in 3D, across floors. Rough by design.

    Anchors come from every placed scanner on every floor (world XY via
    floor alignment, z = floor base + scanner height), so 2 downstairs +
    1 upstairs still solves. Returns
    [{address, name, floor_id, x, y, z, error, scanners}] where x/y are
    floor-local coordinates of the assigned floor and z is absolute.
    """
    if not ble_data or not floorplan:
        return []
    devices = ble_data.get("devices") or []
    floors = floorplan.get("floors") or []
    if not devices or not floors:
        return []

    bases = floor_bases(floors)
    total_h = 0.0
    for f, b in zip(floors, bases):
        try:
            total_h = max(total_h, b + float(f.get("height", 3.0) or 3.0))
        except (TypeError, ValueError):
            total_h = max(total_h, b + 3.0)

    def floor_for_z(z: float) -> tuple[dict, float]:
        """Floor whose [base, base+height] contains z, else nearest base."""
        best_f, best_key = floors[0], None
        for f, b in zip(floors, bases):
            try:
                h = float(f.get("height", 3.0) or 3.0)
            except (TypeError, ValueError):
                h = 3.0
            if b <= z <= b + h:
                return f, b
            dist = abs(z - (b + h)) if z > b + h else (b - z)
            if best_key is None or dist < best_key:
                best_key = dist
                best_f = f
        # nearest base fallback
        base_of = {id(f): b for f, b in zip(floors, bases)}
        return best_f, base_of[id(best_f)]

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
            anchors: list[tuple[float, float, float, float]] = []
            for floor, base in zip(floors, bases):
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
                        lx = float(sc.get("x", 0) or 0)
                        ly = float(sc.get("y", 0) or 0)
                        wx, wy = _to_world(floor, lx, ly)
                        anchors.append((wx, wy, base + SCANNER_HEIGHT, d))
                    except (TypeError, ValueError):
                        continue
            if len(anchors) < 2:
                continue
            solved = solve_3d(anchors)
            if not solved:
                continue
            wx, wy, cz, res = solved
            cz = min(max(cz, 0.0), total_h if total_h > 0 else 6.0)
            floor, base = floor_for_z(cz)
            # Back to the assigned floor's local frame for display.
            try:
                cx, cy = _to_local(floor, wx, wy)
            except (TypeError, ValueError):
                cx, cy = wx, wy
            # Clamp into assigned floor bounds
            try:
                fw = float(floor.get("width", 10.0) or 10.0)
                fd = float(floor.get("depth", 8.0) or 8.0)
            except (TypeError, ValueError):
                fw, fd = 10.0, 8.0
            if not math.isfinite(cx):
                cx = 0.0
            if not math.isfinite(cy):
                cy = 0.0
            cx = min(max(cx, 0.0), fw if fw > 0 else 10.0)
            cy = min(max(cy, 0.0), fd if fd > 0 else 8.0)
            out.append({
                "address": address,
                "name": str(dev.get("name") or address),
                "floor_id": floor.get("id"),
                "x": cx,
                "y": cy,
                "z": cz,
                "error": res,
                "scanners": len(anchors),
            })
        except Exception:
            continue
    return out
