export const Home3DMixin = {
  _homeViews() {
    // Yaw convention: plan +x right, +y down (matches 2D editor); house front is the y=max edge.
    // Screen X is mirrored so plan top-left stays top-left.
    return [
      { id: "iso", label: "Isometric", yaw: 225, pitch: 35.264 },
      { id: "top", label: "Top Down", yaw: 180, pitch: 89.9 },
      { id: "front", label: "Front", yaw: 180, pitch: 8 },
      { id: "back", label: "Back", yaw: 0, pitch: 8 },
      { id: "left", label: "Left Side", yaw: 90, pitch: 8 },
      { id: "right", label: "Right Side", yaw: -90, pitch: 8 },
    ];
  },
  _homeCam() {
    const views = this._homeViews();
    const base = views.find((v) => v.id === (this._homeView || "iso")) || views[0];
    return {
      yaw: (base.yaw + (this._homeYawOff || 0)) * Math.PI / 180,
      pitch: Math.max(-80, Math.min(89.9, base.pitch + (this._homePitchOff || 0))) * Math.PI / 180,
    };
  },
  _homeSetView(id) {
    this._homeView = id;
    this._homeYawOff = 0;
    this._homePitchOff = 0;
    this._render();
  },
  _fpSetView(id) {
    this._fpView = id;
    this._fpYawOff = 0;
    this._fpPitchOff = 0;
    this._render();
  },
  _fpPickFit() {
    // Fit + floor for picking on the editor 3D preview. Null when unavailable.
    const floor = this._getActiveFloor();
    if (!floor || !this.shadowRoot) return null;
    const canvas = this.shadowRoot.getElementById("floorplan-3d-canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(300, Math.round(rect.width || 800));
    const cssH = 380;
    const views = this._homeViews();
    const base = views.find((v) => v.id === (this._fpView || "iso")) || views[0];
    const view = {
      yaw: (base.yaw + (this._fpYawOff || 0)) * Math.PI / 180,
      pitch: Math.max(-80, Math.min(89.9, base.pitch + (this._fpPitchOff || 0))) * Math.PI / 180,
    };
    return { fit: this._compute3DFit(cssW, cssH, [floor], view, this._fpZoom || 1), floor, slabZ: 0.25 };
  },
  _renderFloorPreview3D() {
    const canvas = this.shadowRoot ? this.shadowRoot.getElementById("floorplan-3d-canvas") : null;
    if (!canvas) return;
    const floor = this._getActiveFloor();
    if (!floor) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(300, Math.round(rect.width || 800));
    const cssH = 380;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.height = cssH + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.fillStyle = "#14161a";
    ctx.fillRect(0, 0, cssW, cssH);
    const views = this._homeViews();
    const base = views.find((v) => v.id === (this._fpView || "iso")) || views[0];
    const view = {
      yaw: (base.yaw + (this._fpYawOff || 0)) * Math.PI / 180,
      pitch: Math.max(-80, Math.min(89.9, base.pitch + (this._fpPitchOff || 0))) * Math.PI / 180,
    };
    this._draw3DScene(canvas, cssW, cssH, [floor], view, this._fpZoom || 1);
    // Editing overlays (selection, arrows, drag previews) in screen space
    const fit = this._compute3DFit(cssW, cssH, [floor], view, this._fpZoom || 1);
    const proj = (x, y, z) => this._project3DFit(fit, x, y, z);
    const zSlab = 0.25;
    const ring = (x, y, z, color, r) => {
      const q = proj(x, y, z);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, r || 10, 0, Math.PI * 2); ctx.stroke();
    };
    for (const pt of (floor.points || [])) {
      if (pt.id === this._selectedPointId) ring(pt.x, pt.y, zSlab + 0.45, "#ff9800", 11);
    }
    if (this._selectedWallId) {
      const wall = (floor.walls || []).find((w) => w.id === this._selectedWallId);
      if (wall) {
        const p1 = floor.points.find((p) => p.id === wall.p1), p2 = floor.points.find((p) => p.id === wall.p2);
        if (p1 && p2) {
          const q1 = proj(p1.x, p1.y, zSlab), q2 = proj(p2.x, p2.y, zSlab);
          ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 4;
          ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
        }
      }
    }
    const selDoor = this._selectedDoorId ? (floor.doors || []).find((d) => d.id === this._selectedDoorId) : null;
    if (selDoor) {
      const rad = (parseFloat(selDoor.rotation) || 0) * Math.PI / 180;
      const w = parseFloat(selDoor.width) || 0.9;
      const q = proj(parseFloat(selDoor.x) || 0, parseFloat(selDoor.y) || 0, zSlab + 0.75);
      void rad; void w;
      ring(parseFloat(selDoor.x) || 0, parseFloat(selDoor.y) || 0, zSlab + 0.75, "#ff9800", 12);
      void q;
    }
    const selWin = this._selectedWindowId ? (floor.windows || []).find((w) => w.id === this._selectedWindowId) : null;
    if (selWin) ring(parseFloat(selWin.x) || 0, parseFloat(selWin.y) || 0, zSlab + 0.65, "#ff9800", 12);
    if (this._contextMenu && this._contextMenu.pointId) {
      const pt = floor.points.find((p) => p.id === this._contextMenu.pointId);
      if (pt) {
        const s = proj(pt.x, pt.y, zSlab);
        const dirs = [{ dx: 0, dy: -1, arrow: "↑" }, { dx: 1, dy: 0, arrow: "→" }, { dx: 0, dy: 1, arrow: "↓" }, { dx: -1, dy: 0, arrow: "←" }];
        dirs.forEach((d) => {
          const ax = s.x + d.dx * 40, ay = s.y + d.dy * 40;
          ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.strokeStyle = "#03a9f4"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(ax, ay, 14, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = "#03a9f4"; ctx.font = "bold 16px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(d.arrow, ax, ay);
          ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        });
      }
    }
    if (this._wallDrag && this._wallDrag.moved) {
      const from = floor.points.find((p) => p.id === this._wallDrag.fromId);
      if (from) {
        const s1 = proj(from.x, from.y, zSlab);
        ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 3; ctx.setLineDash([8, 5]);
        ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(this._wallDrag.curX, this._wallDrag.curY); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (this._roomDrag && this._roomDrag.pointIds.length) {
      for (const pid of this._roomDrag.pointIds) {
        const pt = floor.points.find((p) => p.id === pid);
        if (!pt) continue;
        const s = proj(pt.x, pt.y, zSlab);
        ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, Math.PI * 2); ctx.stroke();
      }
    }
  },
  _fpPreviewFit() {
    // Fit + floor for picking on the editor 3D preview. Null when unavailable.
    const floor = this._getActiveFloor();
    if (!floor) return null;
    const canvas = this.shadowRoot ? this.shadowRoot.getElementById("floorplan-3d-canvas") : null;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(300, Math.round(rect.width || 800));
    const cssH = 380;
    const views = this._homeViews();
    const base = views.find((v) => v.id === (this._fpView || "iso")) || views[0];
    const view = {
      yaw: (base.yaw + (this._fpYawOff || 0)) * Math.PI / 180,
      pitch: Math.max(-80, Math.min(89.9, base.pitch + (this._fpPitchOff || 0))) * Math.PI / 180,
    };
    return { fit: this._compute3DFit(cssW, cssH, [floor], view, this._fpZoom || 1), floor, slabZ: 0.25 };
  },
  _homeProject(x, y, z, cx, cy, s, cosY, sinY, cosP, sinP) {
    // Orbit camera: yaw around Z, pitch around X, orthographic.
    // Screen X is mirrored so plan top-left stays top-left.
    const x1 = x * cosY - y * sinY;
    const y1 = x * sinY + y * cosY;
    const z1 = z;
    const y2 = y1 * cosP - z1 * sinP;
    const z2 = y1 * sinP + z1 * cosP;
    return { x: cx - x1 * s, y: cy - z2 * s, depth: y2 };
  },
  _build3DFaces(floors, bases) {
    const faces = [];
    const lines = [];
    const dots = [];
    floors.forEach((floor, fi) => {
      const z0 = bases[fi];
      const h = parseFloat(floor.height) || 3;
      const w = parseFloat(floor.width) || 10, d = parseFloat(floor.depth) || 8;
      const corners = [[0, 0], [w, 0], [w, d], [0, d]];
      // Slab top + sides
      faces.push({ pts: corners.map(([x, y]) => [x, y, z0 + 0.25]), fill: "rgba(255,255,255,0.05)", stroke: "#4a5568", width: 1.5 });
      const sidePairs = [[[0, 0], [w, 0]], [[w, 0], [w, d]], [[w, d], [0, d]], [[0, d], [0, 0]]];
      for (const [[ax, ay], [bx, by]] of sidePairs) {
        faces.push({ pts: [[ax, ay, z0], [bx, by, z0], [bx, by, z0 + 0.25], [ax, ay, z0 + 0.25]], fill: "rgba(255,255,255,0.02)", stroke: "#333c48", width: 1 });
      }
      // Rooms (floor polygons slightly above slab)
      for (const room of (floor.rooms || [])) {
        if (!room.point_ids || room.point_ids.length < 3) continue;
        const pts = room.point_ids.map((id) => floor.points.find((p) => p.id === id)).filter(Boolean);
        if (pts.length < 3) continue;
        faces.push({ pts: pts.map((p) => [p.x, p.y, z0 + 0.27]), fill: (room.color || "#6496ff") + "44", stroke: room.color || "#7aa2ff", width: 1.5 });
      }
      // Walls as vertical quads
      for (const wall of (floor.walls || [])) {
        const p1 = floor.points.find((p) => p.id === wall.p1), p2 = floor.points.find((p) => p.id === wall.p2);
        if (!p1 || !p2) continue;
        faces.push({ pts: [[p1.x, p1.y, z0 + 0.25], [p2.x, p2.y, z0 + 0.25], [p2.x, p2.y, z0 + h], [p1.x, p1.y, z0 + h]], fill: "rgba(232,234,240,0.10)", stroke: "#e8eaf0", width: 1.5 });
      }
      // Doors/windows as wall-height markers
      for (const door of (floor.doors || [])) {
        const rad = (parseFloat(door.rotation) || 0) * Math.PI / 180;
        const dw = parseFloat(door.width) || 0.9;
        const dx = Math.cos(rad), dy = Math.sin(rad);
        const x = parseFloat(door.x) || 0, y = parseFloat(door.y) || 0;
        lines.push({ a: [x - dx * dw / 2, y - dy * dw / 2, z0 + 1.0], b: [x + dx * dw / 2, y + dy * dw / 2, z0 + 1.0], stroke: "#fbbf24", width: 2.5 });
      }
      for (const win of (floor.windows || [])) {
        const rad = (parseFloat(win.rotation) || 0) * Math.PI / 180;
        const ww = parseFloat(win.width) || 1.2;
        const dx = Math.cos(rad), dy = Math.sin(rad);
        const x = parseFloat(win.x) || 0, y = parseFloat(win.y) || 0;
        const sill = z0 + (parseFloat(win.height_from_floor) || 0.9);
        lines.push({ a: [x, y, sill], b: [x + dx * ww, y + dy * ww, sill], stroke: "#22d3ee", width: 2 });
      }
      // Points as short posts
      for (const pt of (floor.points || [])) {
        lines.push({ a: [pt.x, pt.y, z0 + 0.25], b: [pt.x, pt.y, z0 + 0.7], stroke: "#03a9f4", width: 3 });
        dots.push({ p: [pt.x, pt.y, z0 + 0.7] });
      }
      faces.push({ label: (floor.name || "") + " (L" + (floor.level || 0) + ")", at: [0, 0, z0], isLabel: true });
    });
    return { faces, lines, dots };
  },
  _compute3DFit(cssW, cssH, floors, view, zoom) {
    const cosY = Math.cos(view.yaw), sinY = Math.sin(view.yaw);
    const cosP = Math.cos(view.pitch), sinP = Math.sin(view.pitch);
    const GAP = 1.5;
    let zb = 0;
    const bases = floors.map((f) => {
      const z = zb;
      zb += (parseFloat(f.height) || 3) + GAP;
      return z;
    });
    const totalH = zb;
    let maxDim = 10, maxZ = totalH || 6;
    for (const f of floors) maxDim = Math.max(maxDim, parseFloat(f.width) || 10, parseFloat(f.depth) || 8);
    const s = Math.min(cssW / (maxDim * 2.1), cssH / (maxDim * 1.1 + maxZ * 0.9)) * (zoom || 1);
    const cc = { x: 0, y: 0, z: 0 };
    let n = 0;
    for (const f of floors) {
      cc.x += (parseFloat(f.width) || 10) / 2; cc.y += (parseFloat(f.depth) || 8) / 2; n++;
    }
    cc.x /= n || 1; cc.y /= n || 1; cc.z = maxZ / 2;
    // Note mirrored X to match plan orientation.
    const cx = cssW / 2 + (cc.x * cosY - cc.y * sinY) * s;
    const y1c = cc.x * sinY + cc.y * cosY;
    const cy = cssH / 2 + (y1c * sinP + cc.z * cosP) * s;
    return { s, cx, cy, cosY, sinY, cosP, sinP, bases };
  },
  _project3DFit(fit, x, y, z) {
    return this._homeProject(x, y, z, fit.cx, fit.cy, fit.s, fit.cosY, fit.sinY, fit.cosP, fit.sinP);
  },
  _unproject3DFit(fit, sx, sy, z) {
    // Invert mirrored orthographic projection at height z. Null when degenerate.
    const ax = (fit.cx - sx) / fit.s;
    const bz = (fit.cy - sy) / fit.s;
    if (Math.abs(fit.sinP) < 1e-6) return null;
    const y1 = (bz - z * fit.cosP) / fit.sinP;
    return {
      x: ax * fit.cosY + y1 * fit.sinY,
      y: -ax * fit.sinY + y1 * fit.cosY,
    };
  },
  _draw3DScene(canvas, cssW, cssH, floors, view, zoom) {
    const ctx = canvas.getContext("2d");
    const fit = this._compute3DFit(cssW, cssH, floors, view, zoom);
    const proj = (x, y, z) => this._project3DFit(fit, x, y, z);
    const scene = this._build3DFaces(floors, fit.bases);
    const depthOf = (pts) => pts.reduce((a, p) => a + proj(p[0], p[1], p[2]).depth, 0) / pts.length;
    scene.faces.sort((a, b) => {
      if (a.isLabel) return 1;
      if (b.isLabel) return -1;
      return depthOf(b.pts) - depthOf(a.pts);
    });
    for (const f of scene.faces) {
      if (f.isLabel) {
        const q = proj(f.at[0], f.at[1], f.at[2]);
        ctx.font = "12px sans-serif";
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(f.label, q.x - 30, q.y - 10);
        ctx.fillStyle = "#f1f3f5"; ctx.fillText(f.label, q.x - 30, q.y - 10);
        continue;
      }
      ctx.fillStyle = f.fill;
      ctx.strokeStyle = f.stroke; ctx.lineWidth = f.width;
      ctx.beginPath();
      f.pts.forEach(([x, y, z], i) => {
        const q = proj(x, y, z);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    const allLines = scene.lines.map((l) => ({ ...l, depth: (proj(...l.a).depth + proj(...l.b).depth) / 2 }));
    allLines.sort((a, b) => b.depth - a.depth);
    for (const l of allLines) {
      const q1 = proj(...l.a), q2 = proj(...l.b);
      ctx.strokeStyle = l.stroke; ctx.lineWidth = l.width;
      ctx.beginPath(); ctx.moveTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.stroke();
    }
    const allDots = scene.dots.map((d) => ({ ...d, depth: proj(...d.p).depth }));
    allDots.sort((a, b) => b.depth - a.depth);
    for (const d of allDots) {
      const q = proj(...d.p);
      ctx.fillStyle = "#03a9f4";
      ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  },
  _renderHome3D() {
    const canvas = this.shadowRoot ? this.shadowRoot.getElementById("home-iso-canvas") : null;
    if (!canvas) return;
    if (!this._floorplan || !this._floorplan.floors || !this._floorplan.floors.length) {
      if (this._hass && !this._floorplan && !this._floorplanLoading) this._fetchFloorplanOnce();
      if (this._floorplan && this._floorplan.floors && !this._floorplan.floors.length) {
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const rect = canvas.getBoundingClientRect();
        const cssW = Math.max(300, Math.round(rect.width || 800));
        const cssH = 420;
        if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
          canvas.width = Math.floor(cssW * dpr);
          canvas.height = Math.floor(cssH * dpr);
          canvas.style.height = cssH + "px";
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = "#14161a";
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.fillStyle = "#8b95a5";
        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("No floors. Add one in Floor Plan.", cssW / 2, cssH / 2);
      }
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(300, Math.round(rect.width || 800));
    const cssH = 420;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.height = cssH + "px";
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.fillStyle = "#14161a";
    ctx.fillRect(0, 0, cssW, cssH);
    const floors = [...this._floorplan.floors].sort((a, b) => (a.level || 0) - (b.level || 0));
    const cam = this._homeCam();
    this._draw3DScene(canvas, cssW, cssH, floors, cam, this._homeZoom || 1);
  },
};
