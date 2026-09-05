export const FloorplanCanvasMixin = {
    _renderFloorplanCanvas() {
      const canvas = this.shadowRoot ? this.shadowRoot.getElementById("floorplan-canvas") : null;
      if (!canvas || !this._floorplan) return;
      // Crisp canvas: backing store matches displayed size * DPR, no aspect distortion.
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(300, Math.round(rect.width || canvas.clientWidth || 800));
      const cssH = Math.max(250, Math.round(rect.height || (cssW * 5 / 8)));
      const wantW = Math.floor(cssW * dpr), wantH = Math.floor(cssH * dpr);
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
        canvas.style.height = cssH + "px";
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      const floor = this._getActiveFloor();
      if (!floor) return;
      const w = cssW, h = cssH;
      // Dark mode editor background (not the terrible light one)
      ctx.fillStyle = "#14161a";
      ctx.fillRect(0, 0, w, h);
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      // Draw floor bounds (dimensions constraint)
      const fb = { x: 0, y: 0, w: 10, d: 8 };
      try { fb.w = parseFloat(floor.width) || 10; fb.d = parseFloat(floor.depth) || 8; } catch (e) {}
      const c00 = this._worldToScreen(0, 0, floor), cW0 = this._worldToScreen(fb.w, 0, floor), cWd = this._worldToScreen(fb.w, fb.d, floor), c0d = this._worldToScreen(0, fb.d, floor);
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.beginPath(); ctx.moveTo(c00.x, c00.y); ctx.lineTo(cW0.x, cW0.y); ctx.lineTo(cWd.x, cWd.y); ctx.lineTo(c0d.x, c0d.y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "#4a5568"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(c00.x, c00.y); ctx.lineTo(cW0.x, cW0.y); ctx.lineTo(cWd.x, cWd.y); ctx.lineTo(c0d.x, c0d.y); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "#2a2e35"; ctx.lineWidth = 1;
      const gridStep = this._floorplanScale * (this._floorplanUnits === "meters" ? 1 : 0.6096);
      for (let x = this._floorplanOffset.x % gridStep; x < w; x += gridStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = this._floorplanOffset.y % gridStep; y < h; y += gridStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      for (const room of (floor.rooms || [])) {
        if (!room.point_ids || room.point_ids.length < 3) continue;
        const pts = room.point_ids.map((id) => floor.points.find((p) => p.id === id)).filter(Boolean);
        if (pts.length < 3) continue;
        ctx.fillStyle = room.color ? room.color + "55" : "rgba(100,150,255,0.25)";
        ctx.strokeStyle = room.color || "#7aa2ff"; ctx.lineWidth = 2;
        ctx.beginPath();
        pts.forEach((p, i) => { const s = this._worldToScreen(p.x, p.y, floor); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
        // Readable label: dark halo behind light text
        ctx.font = "12px sans-serif";
        const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 }); c.x /= pts.length; c.y /= pts.length;
        const sc = this._worldToScreen(c.x, c.y, floor);
        ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.strokeText(room.name || "", sc.x - 20, sc.y);
        ctx.fillStyle = "#f1f3f5"; ctx.fillText(room.name || "", sc.x - 20, sc.y);
      }
      for (const wall of (floor.walls || [])) {
        const p1 = floor.points.find((p) => p.id === wall.p1), p2 = floor.points.find((p) => p.id === wall.p2);
        if (!p1 || !p2) continue;
        const s1 = this._worldToScreen(p1.x, p1.y, floor), s2 = this._worldToScreen(p2.x, p2.y, floor);
        if (this._selectedWallId === wall.id) { ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 4; } else { ctx.strokeStyle = "#e8eaf0"; ctx.lineWidth = 3; }
        ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
      }
      // Doors (placeable + rotatable, no labels)
      for (const door of (floor.doors || [])) {
        const g = this._doorEndpoints(door, floor);
        const isSel = this._selectedDoorId === door.id;
        const swing = (door.swing || "right").toLowerCase();
        // Cut opening in wall: dark gap slightly wider than wall
        ctx.strokeStyle = "#14161a"; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.moveTo(g.s1.x, g.s1.y); ctx.lineTo(g.s2.x, g.s2.y); ctx.stroke();
        // Frame jambs
        ctx.strokeStyle = isSel ? "#ff9800" : "#9aa4b2"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(g.s1.x, g.s1.y); ctx.lineTo(g.s2.x, g.s2.y); ctx.stroke();
        // Leaf(s)
        const leafColor = isSel ? "#ff9800" : "#f1f3f5";
        ctx.strokeStyle = leafColor; ctx.lineWidth = 2.5;
        const leafLenPx = Math.hypot(g.s2.x - g.s1.x, g.s2.y - g.s1.y) || 1;
        const ux = (g.s2.x - g.s1.x) / leafLenPx, uy = (g.s2.y - g.s1.y) / leafLenPx;
        const drawLeaf = (hx, hy, angDeg, lenPx) => {
          const a = angDeg * Math.PI / 180;
          ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + Math.cos(a) * lenPx, hy + Math.sin(a) * lenPx); ctx.stroke();
          // Swing arc
          ctx.strokeStyle = isSel ? "rgba(255,152,0,0.7)" : "rgba(241,243,245,0.45)";
          ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(hx, hy, lenPx, Math.min(a, Math.atan2(uy, ux)), Math.max(a, Math.atan2(uy, ux)), swing === "left");
          ctx.stroke(); ctx.setLineDash([]);
          ctx.strokeStyle = leafColor; ctx.lineWidth = 2.5;
        };
        const baseAng = Math.atan2(uy, ux) * 180 / Math.PI;
        if (door.type === "Double Door") {
          const half = leafLenPx / 2;
          // Two leaves swinging inward
          const a1 = baseAng + (swing === "left" ? -70 : 70);
          const a2 = baseAng + 180 + (swing === "left" ? 70 : -70);
          const mx = (g.s1.x + g.s2.x) / 2, my = (g.s1.y + g.s2.y) / 2;
          ctx.beginPath(); ctx.moveTo(g.s1.x, g.s1.y); ctx.lineTo(g.s1.x + Math.cos(a1 * Math.PI / 180) * half, g.s1.y + Math.sin(a1 * Math.PI / 180) * half); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(g.s2.x, g.s2.y); ctx.lineTo(g.s2.x + Math.cos(a2 * Math.PI / 180) * half, g.s2.y + Math.sin(a2 * Math.PI / 180) * half); ctx.stroke();
        } else if (door.type === "Garage Door") {
          // Garage: double line + center seam, swing up = draw parallel lines
          const nx = -uy, ny = ux;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(g.s1.x + nx * 3, g.s1.y + ny * 3); ctx.lineTo(g.s2.x + nx * 3, g.s2.y + ny * 3); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(g.s1.x - nx * 3, g.s1.y - ny * 3); ctx.lineTo(g.s2.x - nx * 3, g.s2.y - ny * 3); ctx.stroke();
          const mx = (g.s1.x + g.s2.x) / 2, my = (g.s1.y + g.s2.y) / 2;
          ctx.strokeStyle = "rgba(241,243,245,0.5)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + nx * (swing === "left" ? -14 : 14), my + ny * (swing === "left" ? -14 : 14)); ctx.stroke();
        } else {
          // Single door: hinge at one end based on swing
          const hinge = swing === "left" ? { x: g.s1.x, y: g.s1.y } : { x: g.s2.x, y: g.s2.y };
          const leafAng = baseAng + (swing === "left" ? -75 : 75);
          drawLeaf(hinge.x, hinge.y, leafAng, leafLenPx);
        }
        if (isSel) {
          const midx = (g.s1.x + g.s2.x) / 2, midy = (g.s1.y + g.s2.y) / 2;
          ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(midx, midy, 12, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // Windows (origin = lower-left corner; cyan opening, no labels)
      for (const win of (floor.windows || [])) {
        const g = this._windowSeg(win, floor);
        const isSel = this._selectedWindowId === win.id;
        // Cut opening
        ctx.strokeStyle = "#14161a"; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.moveTo(g.s1.x, g.s1.y); ctx.lineTo(g.s2.x, g.s2.y); ctx.stroke();
        // Sill: double cyan lines
        const len = Math.hypot(g.s2.x - g.s1.x, g.s2.y - g.s1.y) || 1;
        const nx = -(g.s2.y - g.s1.y) / len, ny = (g.s2.x - g.s1.x) / len;
        ctx.strokeStyle = isSel ? "#ff9800" : "#22d3ee"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(g.s1.x + nx * 3, g.s1.y + ny * 3); ctx.lineTo(g.s2.x + nx * 3, g.s2.y + ny * 3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(g.s1.x - nx * 3, g.s1.y - ny * 3); ctx.lineTo(g.s2.x - nx * 3, g.s2.y - ny * 3); ctx.stroke();
        // End ticks
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(g.s1.x - nx * 5, g.s1.y - ny * 5); ctx.lineTo(g.s1.x + nx * 5, g.s1.y + ny * 5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(g.s2.x - nx * 5, g.s2.y - ny * 5); ctx.lineTo(g.s2.x + nx * 5, g.s2.y + ny * 5); ctx.stroke();
        if (isSel) {
          const midx = (g.s1.x + g.s2.x) / 2, midy = (g.s1.y + g.s2.y) / 2;
          ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(midx, midy, 12, 0, Math.PI * 2); ctx.stroke();
        }
      }
      for (const pt of (floor.points || [])) {
        const s = this._worldToScreen(pt.x, pt.y, floor);
        const isSelected = this._selectedPointId === pt.id;
        // No white tint: dark outline so text/neighbors stay readable
        ctx.fillStyle = isSelected ? "#ff9800" : "#03a9f4";
        ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = "#0b0e13"; ctx.lineWidth = 2; ctx.stroke();
        if (isSelected) {
          ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, Math.PI * 2); ctx.stroke();
        }
      }
      if (this._contextMenu && this._contextMenu.pointId) {
        const pt = floor.points.find((p) => p.id === this._contextMenu.pointId);
        if (pt) {
          const s = this._worldToScreen(pt.x, pt.y, floor);
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
      // Wall-drag preview (right-drag point to point)
      if (this._wallDrag && this._wallDrag.moved) {
        const from = floor.points.find((p) => p.id === this._wallDrag.fromId);
        if (from) {
          const s1 = this._worldToScreen(from.x, from.y, floor);
          ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 3; ctx.setLineDash([8, 5]);
          ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(this._wallDrag.curX, this._wallDrag.curY); ctx.stroke();
          ctx.setLineDash([]);
          if (this._wallDrag.hoverId) {
            const hp = floor.points.find((p) => p.id === this._wallDrag.hoverId);
            if (hp) {
              const sh = this._worldToScreen(hp.x, hp.y, floor);
              ctx.strokeStyle = "#ff9800"; ctx.lineWidth = 2;
              ctx.beginPath(); ctx.arc(sh.x, sh.y, 12, 0, Math.PI * 2); ctx.stroke();
            }
          }
        }
      }
      // Room-drag selection highlight (middle-drag across points)
      if (this._roomDrag && this._roomDrag.pointIds.length) {
        for (const pid of this._roomDrag.pointIds) {
          const pt = floor.points.find((p) => p.id === pid);
          if (!pt) continue;
          const s = this._worldToScreen(pt.x, pt.y, floor);
          ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(s.x, s.y, 11, 0, Math.PI * 2); ctx.stroke();
        }
        // Rubber line from start to cursor
        ctx.strokeStyle = "rgba(34,197,94,0.6)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(this._roomDrag.startX, this._roomDrag.startY); ctx.lineTo(this._roomDrag.curX, this._roomDrag.curY); ctx.stroke();
        ctx.setLineDash([]);
      }
    },

    _handleFloorplanClick(e) {
      const canvas = this._fpCanvasEl();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      // CSS pixels (worldToScreen returns CSS px, canvas is DPR-scaled via setTransform)
      const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
      const floor = this._getActiveFloor();
      if (!floor) return;
      if (this._contextMenu) {
        const pt = floor.points.find((p) => p.id === this._contextMenu.pointId);
        if (pt) {
          const s = this._fpToScreen(pt.x, pt.y, floor);
          const dirs = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];
          for (const d of dirs) {
            const ax = s.x + d.dx * 40, ay = s.y + d.dy * 40;
            if (Math.hypot(sx - ax, sy - ay) < 16) {
              const unitLabel = this._floorplanUnits === "meters" ? "meters" : "feet/inches (e.g. 6' 11\")";
              const def = this._floorplanUnits === "meters" ? "2" : "6' 0\"";
              const valStr = prompt("How many " + unitLabel + " away should the new point be placed?", def);
              if (valStr === null) return;
              const distM = this._parseDisplayToMeters(valStr);
              if (isNaN(distM) || distM <= 0) { alert("Invalid distance (try 6' 11\" or 2.5)"); return; }
              let newX = typeof this._fpSnapVal === "function" ? this._fpSnapVal(pt.x + d.dx * distM) : pt.x + d.dx * distM;
              let newY = typeof this._fpSnapVal === "function" ? this._fpSnapVal(pt.y + d.dy * distM) : pt.y + d.dy * distM;
              const cl = this._clampToFloor(floor, newX, newY);
              newX = cl.x; newY = cl.y;
              this._fpPushUndo();
              const newId = "point_" + Date.now();
              floor.points.push({ id: newId, x: newX, y: newY, label: "" });
              // No auto wall (per request) - walls are created by right-dragging points together
              this._selectedPointId = newId;
              this._contextMenu = null;
              this._saveFloorplan();
              this._render();
              this._fpRedraw();
              return;
            }
          }
        }
      }
      // Window placement mode: left-click places window origin (lower-left corner)
      if (this._placingWindow && e.button !== 2) {
        const w = this._fpToWorld(sx, sy, floor);
        const snw = (v) => (typeof this._fpSnapVal === "function" ? this._fpSnapVal(v) : v);
        const cl = this._clampToFloor(floor, snw(w.x), snw(w.y));
        const defs = this._windowDefaults();
        this._fpPushUndo();
        const nid = "window_" + Date.now();
        floor.windows = floor.windows || [];
        floor.windows.push({
          id: nid, x: cl.x, y: cl.y, rotation: 0,
          width: defs.width, height: defs.height, height_from_floor: defs.height_from_floor,
        });
        this._selectedWindowId = nid;
        this._selectedPointId = null; this._selectedWallId = null; this._selectedDoorId = null;
        this._placingWindow = false;
        this._placingDoorType = null;
        this._saveFloorplan();
        this._render();
        this._fpRedraw();
        return;
      }
      // Door placement mode: left-click places a door of the pending type
      if (this._placingDoorType && e.button !== 2) {
        const w = this._fpToWorld(sx, sy, floor);
        const snd = (v) => (typeof this._fpSnapVal === "function" ? this._fpSnapVal(v) : v);
        const cl = this._clampToFloor(floor, snd(w.x), snd(w.y));
        const defaults = this._doorDefaults();
        this._fpPushUndo();
        const nid = "door_" + Date.now();
        floor.doors = floor.doors || [];
        floor.doors.push({
          id: nid,
          type: this._placingDoorType,
          x: cl.x, y: cl.y,
          rotation: 0,
          width: defaults[this._placingDoorType] || 0.9,
          swing: this._placingDoorType === "Double Door" ? "left" : (this._placingDoorType === "Garage Door" ? "up" : "right"),
        });
        this._selectedDoorId = nid;
        this._selectedPointId = null; this._selectedWallId = null; this._selectedWindowId = null;
        this._placingDoorType = null;
        this._placingWindow = false;
        this._saveFloorplan();
        this._render();
        this._fpRedraw();
        return;
      }
      for (const pt of floor.points) {
        const s = this._fpToScreen(pt.x, pt.y, floor);
        if (Math.hypot(sx - s.x, sy - s.y) < 12) {
          if (e.button === 2) {
            this._contextMenu = { x: sx, y: sy, pointId: pt.id };
            this._selectedPointId = pt.id;
            this._selectedDoorId = null;
            this._fpRedraw();
            return;
          } else {
            this._selectedPointId = pt.id;
            this._selectedWallId = null;
            this._selectedDoorId = null;
            this._selectedWindowId = null;
            this._contextMenu = null;
            this._fpRedraw();
            return;
          }
        }
      }
      // Doors (select before walls so small targets win over wall lines)
      {
        const hit = this._doorHitTest(sx, sy, floor, 10);
        if (hit) {
          this._selectedDoorId = hit.id;
          this._selectedPointId = null; this._selectedWallId = null; this._selectedWindowId = null; this._contextMenu = null;
          this._placingDoorType = null; this._placingWindow = false;
          this._render();
          this._fpRedraw();
          return;
        }
      }
      // Windows
      {
        const hit = this._windowHitTest(sx, sy, floor, 10);
        if (hit) {
          this._selectedWindowId = hit.id;
          this._selectedPointId = null; this._selectedWallId = null; this._selectedDoorId = null; this._contextMenu = null;
          this._placingDoorType = null; this._placingWindow = false;
          this._render();
          this._fpRedraw();
          return;
        }
      }
      for (const wall of floor.walls) {
        const p1 = floor.points.find((p) => p.id === wall.p1), p2 = floor.points.find((p) => p.id === wall.p2);
        if (!p1 || !p2) continue;
        const s1 = this._fpToScreen(p1.x, p1.y, floor), s2 = this._fpToScreen(p2.x, p2.y, floor);
        const len = Math.hypot(s2.x - s1.x, s2.y - s1.y) || 1;
        const dist = Math.abs((s2.y - s1.y) * sx - (s2.x - s1.x) * sy + s2.x * s1.y - s2.y * s1.x) / len;
        const dot = ((sx - s1.x) * (s2.x - s1.x) + (sy - s1.y) * (s2.y - s1.y)) / (len * len);
        if (dist < 10 && dot >= 0 && dot <= 1) {
          this._selectedWallId = wall.id; this._selectedPointId = null; this._selectedDoorId = null; this._selectedWindowId = null; this._contextMenu = null; this._fpRedraw(); return;
        }
      }
      this._selectedPointId = null; this._selectedWallId = null; this._selectedDoorId = null; this._selectedWindowId = null; this._contextMenu = null;
      if (this._placingDoorType || this._placingWindow) { this._placingDoorType = null; this._placingWindow = false; this._render(); }
      this._fpRedraw();
    },

    _handleFloorplanDblClick(e) {
      const canvas = this._fpCanvasEl();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
      const floor = this._getActiveFloor();
      if (!floor) return;
      for (const pt of floor.points) {
        const s = this._fpToScreen(pt.x, pt.y, floor);
        if (Math.hypot(sx - s.x, sy - s.y) < 12) {
          const unitLabel = this._floorplanUnits === "meters" ? "meters" : "feet/inches (e.g. 6' 11\")";
          const xs = prompt("New X (" + unitLabel + ")?", this._formatMetersForInput(pt.x));
          if (xs === null) return;
          const ys = prompt("New Y (" + unitLabel + ")?", this._formatMetersForInput(pt.y));
          if (ys === null) return;
          const xvm = this._parseDisplayToMeters(xs), yvm = this._parseDisplayToMeters(ys);
          if (isNaN(xvm) || isNaN(yvm)) { alert("Invalid position (try 6' 11\" or 2.5)"); return; }
          this._fpPushUndo();
          const sxv = typeof this._fpSnapVal === "function" ? this._fpSnapVal(xvm) : xvm;
          const syv = typeof this._fpSnapVal === "function" ? this._fpSnapVal(yvm) : yvm;
          const cl = this._clampToFloor(floor, sxv, syv);
          pt.x = cl.x;
          pt.y = cl.y;
          this._saveFloorplan();
          this._fpRedraw();
          return;
        }
      }
    },

    _fpPointAt(sx, sy, floor, radius) {
      const r = radius || 12;
      for (const pt of (floor.points || [])) {
        const s = this._fpToScreen(pt.x, pt.y, floor);
        if (Math.hypot(sx - s.x, sy - s.y) < r) return pt;
      }
      return null;
    },

    _handleFloorplanMouseDown(e) {
      const canvas = this._fpCanvasEl();
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
      const floor = this._getActiveFloor();
      if (!floor) return;
      if (e.button === 2) {
        // Right-drag from a point to create a wall on release
        const pt = this._fpPointAt(sx, sy, floor, 12);
        if (pt) {
          this._wallDrag = { fromId: pt.id, curX: sx, curY: sy, moved: false, startX: sx, startY: sy };
          e.preventDefault();
          return;
        }
        return;
      }
      if (e.button === 1) {
        // Middle-drag across points to create a room on release
        e.preventDefault();
        const hit = this._fpPointAt(sx, sy, floor, 14);
        this._roomDrag = { pointIds: [], seen: {}, startX: sx, startY: sy, curX: sx, curY: sy, moved: false };
        if (hit && !this._roomDrag.seen[hit.id]) { this._roomDrag.seen[hit.id] = true; this._roomDrag.pointIds.push(hit.id); }
        return;
      }
      if (e.button !== 0) return;
      // No point dragging (per request) - only pan on empty drag in 2D mode.
      // In 3D mode the view changes via buttons only.
      if (this._fpIs3D && this._fpIs3D()) return;
      this._floorplanPanning = true;
      this._floorplanPanStart = { x: e.clientX, y: e.clientY, ox: this._floorplanOffset.x, oy: this._floorplanOffset.y };
    },

    _handleFloorplanMouseMove(e) {
      const canvas = this._fpCanvasEl();
      if (!canvas) return;
      const floor = this._getActiveFloor();
      if (!floor) return;
      if (this._wallDrag) {
        const rect = canvas.getBoundingClientRect();
        const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
        if (Math.hypot(sx - this._wallDrag.startX, sy - this._wallDrag.startY) > 5) this._wallDrag.moved = true;
        this._wallDrag.curX = sx; this._wallDrag.curY = sy;
        // Hover target highlight
        const hov = this._fpPointAt(sx, sy, floor, 12);
        this._wallDrag.hoverId = hov && hov.id !== this._wallDrag.fromId ? hov.id : null;
        this._fpRedraw();
        return;
      }
      if (this._roomDrag) {
        const rect = canvas.getBoundingClientRect();
        const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
        if (Math.hypot(sx - this._roomDrag.startX, sy - this._roomDrag.startY) > 5) this._roomDrag.moved = true;
        this._roomDrag.curX = sx; this._roomDrag.curY = sy;
        const hit = this._fpPointAt(sx, sy, floor, 14);
        if (hit && !this._roomDrag.seen[hit.id]) {
          this._roomDrag.seen[hit.id] = true;
          this._roomDrag.pointIds.push(hit.id);
          this._fpRedraw();
        } else if (this._roomDrag.moved) {
          this._fpRedraw();
        }
        return;
      }
      if (this._floorplanPanning && this._floorplanPanStart) {
        this._floorplanOffset.x = this._floorplanPanStart.ox + (e.clientX - this._floorplanPanStart.x);
        this._floorplanOffset.y = this._floorplanPanStart.oy + (e.clientY - this._floorplanPanStart.y);
        this._fpRedraw();
      }
    },

    _handleFloorplanMouseUp(e) {
      const canvas = this._fpCanvasEl();
      const floor = this._getActiveFloor();
      if (this._wallDrag && floor) {
        const wd = this._wallDrag;
        this._wallDrag = null;
        if (e && e.button !== undefined && e.button !== 2) { this._fpRedraw(); return; }
        if (wd.moved && canvas) {
          const rect = canvas.getBoundingClientRect();
          const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
          const target = this._fpPointAt(sx, sy, floor, 14);
          if (target && target.id !== wd.fromId) {
            const exists = (floor.walls || []).some((w) => (w.p1 === wd.fromId && w.p2 === target.id) || (w.p1 === target.id && w.p2 === wd.fromId));
            if (!exists) {
              this._fpPushUndo();
              floor.walls.push({ id: "wall_" + Date.now(), p1: wd.fromId, p2: target.id });
              this._selectedWallId = floor.walls[floor.walls.length - 1].id;
              this._selectedPointId = null;
              this._suppressContextMenu = true;
              this._saveFloorplan();
              this._render();
              this._fpRedraw();
              return;
            }
            this._suppressContextMenu = true;
          }
        }
        // Not a drag (simple right-click handled in click handler for arrows)
        this._fpRedraw();
        return;
      }
      if (this._roomDrag && floor) {
        const rd = this._roomDrag;
        this._roomDrag = null;
        if (e && e.button !== undefined && e.button !== 1) { this._fpRedraw(); return; }
        if (rd.pointIds.length >= 3) {
          const name = prompt("Room name?", "Room " + ((floor.rooms || []).length + 1));
          if (name) {
            this._fpPushUndo();
            floor.rooms.push({ id: "room_" + Date.now(), name: name, point_ids: [...rd.pointIds], color: "#6496ff" });
            this._saveFloorplan();
            this._render();
            this._fpRedraw();
            return;
          }
        } else if (rd.moved && rd.pointIds.length > 0) {
          alert("Need 3+ points for a room (middle-drag across points)");
        }
        this._fpRedraw();
        return;
      }
      if (this._floorplanPanning) { this._floorplanPanning = false; this._floorplanPanStart = null; }
    },

    _handleFloorplanKeyDown(e) {
      const isFp = this._activeTab === "floorplan";
      const isHome = this._activeTab === "home";
      if (!isFp && !isHome) return;
      if (isFp && e.key === "Escape" && (this._placingDoorType || this._placingWindow)) {
        this._placingDoorType = null;
        this._placingWindow = false;
        this._render(); this._fpRedraw();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!isFp && mod) return;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        this._fpUndoDo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        this._fpRedoDo();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        const floor = this._getActiveFloor();
        if (!floor) return;
        // Copy selected point, wall, door, or window
        if (this._selectedWindowId) {
          const w = (floor.windows || []).find((ww) => ww.id === this._selectedWindowId);
          if (w) { this._fpClipboard = { kind: "window", data: JSON.parse(JSON.stringify(w)) }; }
        } else if (this._selectedDoorId) {
          const d = (floor.doors || []).find((dd) => dd.id === this._selectedDoorId);
          if (d) { this._fpClipboard = { kind: "door", data: JSON.parse(JSON.stringify(d)) }; }
        } else if (this._selectedPointId) {
          const pt = floor.points.find((p) => p.id === this._selectedPointId);
          if (pt) { this._fpClipboard = { kind: "point", data: JSON.parse(JSON.stringify(pt)) }; }
        } else if (this._selectedWallId) {
          const w = (floor.walls || []).find((ww) => ww.id === this._selectedWallId);
          if (w) { this._fpClipboard = { kind: "wall", data: JSON.parse(JSON.stringify(w)) }; }
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        const floor = this._getActiveFloor();
        if (!floor || !this._fpClipboard) return;
        e.preventDefault();
        this._fpPushUndo();
        const sn = (v) => (typeof this._fpSnapVal === "function" ? this._fpSnapVal(v) : v);
        if (this._fpClipboard.kind === "point") {
          const src = this._fpClipboard.data;
          const nid = "point_" + Date.now();
          const cl = this._clampToFloor(floor, sn((src.x || 0) + 0.5), sn((src.y || 0) + 0.5));
          floor.points.push({ id: nid, x: cl.x, y: cl.y, label: "" });
          this._selectedPointId = nid;
        } else if (this._fpClipboard.kind === "wall") {
          const src = this._fpClipboard.data;
          // Paste wall requires its points; duplicate points too with offset
          const p1 = floor.points.find((p) => p.id === src.p1), p2 = floor.points.find((p) => p.id === src.p2);
          if (p1 && p2) {
          const n1 = "point_" + Date.now(), n2 = "point_" + (Date.now() + 1);
          const c1 = this._clampToFloor(floor, sn(p1.x + 0.5), sn(p1.y + 0.5));
          const c2 = this._clampToFloor(floor, sn(p2.x + 0.5), sn(p2.y + 0.5));
            floor.points.push({ id: n1, x: c1.x, y: c1.y, label: "" });
            floor.points.push({ id: n2, x: c2.x, y: c2.y, label: "" });
            floor.walls.push({ id: "wall_" + Date.now(), p1: n1, p2: n2 });
          }
        } else if (this._fpClipboard.kind === "door") {
          const src = this._fpClipboard.data;
          const nid = "door_" + Date.now();
          const cl = this._clampToFloor(floor, sn((parseFloat(src.x) || 0) + 0.5), sn((parseFloat(src.y) || 0) + 0.5));
          floor.doors = floor.doors || [];
          floor.doors.push({ id: nid, type: src.type || "Door", x: cl.x, y: cl.y, rotation: parseFloat(src.rotation) || 0, width: parseFloat(src.width) || 0.9, swing: src.swing || "right" });
          this._selectedDoorId = nid;
        } else if (this._fpClipboard.kind === "window") {
          const src = this._fpClipboard.data;
          const nid = "window_" + Date.now();
          const cl = this._clampToFloor(floor, sn((parseFloat(src.x) || 0) + 0.5), sn((parseFloat(src.y) || 0) + 0.5));
          floor.windows = floor.windows || [];
          floor.windows.push({ id: nid, x: cl.x, y: cl.y, rotation: parseFloat(src.rotation) || 0, width: parseFloat(src.width) || 1.2, height: parseFloat(src.height) || 1.2, height_from_floor: parseFloat(src.height_from_floor) || 0.9 });
          this._selectedWindowId = nid;
        }
        this._saveFloorplan();
        this._render();
        this._fpRedraw();
        return;
      }
      // Camera keys: WASDQE moves/zooms, arrows zoom/look. Works in edit mode too,
      // but never while typing or with Ctrl/Cmd held.
      const mod2 = e.ctrlKey || e.metaKey || e.altKey;
      const typing2 = /INPUT|SELECT|TEXTAREA/.test(document.activeElement ? document.activeElement.tagName : "");
      if (!mod2 && !typing2) {
        const k = e.key.toLowerCase();
        const PAN = 24, ANG = 5;
        if (isFp && this._fpMode !== "3d") {
          // 2D editor canvas: WASD/arrows pan, QE zoom.
          let handled = true;
          if (k === "w" || e.key === "ArrowUp") this._floorplanOffset.y += PAN;
          else if (k === "s" || e.key === "ArrowDown") this._floorplanOffset.y -= PAN;
          else if (k === "a" || e.key === "ArrowLeft") this._floorplanOffset.x += PAN;
          else if (k === "d" || e.key === "ArrowRight") this._floorplanOffset.x -= PAN;
          else if (k === "q") this._floorplanScale = Math.max(5, this._floorplanScale / 1.12);
          else if (k === "e") this._floorplanScale = Math.min(200, this._floorplanScale * 1.12);
          else handled = false;
          if (handled) { e.preventDefault(); this._fpRedraw(); return; }
        } else {
          // 3D views (editor preview + home): WASD pan, QE zoom, arrows look.
          const isEditor3D = isFp;
          const getP = () => isEditor3D
            ? { panX: this._fpPanX || 0, panY: this._fpPanY || 0, zoom: this._fpZoom || 1, yaw: this._fpYawOff || 0, pitch: this._fpPitchOff || 0 }
            : { panX: this._homePanX || 0, panY: this._homePanY || 0, zoom: this._homeZoom || 1, yaw: this._homeYawOff || 0, pitch: this._homePitchOff || 0 };
          const setP = (p) => {
            if (isEditor3D) {
              this._fpPanX = p.panX; this._fpPanY = p.panY; this._fpZoom = p.zoom;
              this._fpYawOff = p.yaw; this._fpPitchOff = p.pitch;
            } else {
              this._homePanX = p.panX; this._homePanY = p.panY; this._homeZoom = p.zoom;
              this._homeYawOff = p.yaw; this._homePitchOff = p.pitch;
            }
          };
          const draw = () => {
            if (isEditor3D) {
              if (typeof this._requestDraw === "function") this._requestDraw("fpkeys", () => this._renderFloorPreview3D());
              else this._renderFloorPreview3D();
            } else {
              if (typeof this._requestDraw === "function") this._requestDraw("homekeys", () => this._renderHomeIsoCanvas());
              else this._renderHomeIsoCanvas();
            }
          };
          const p = getP();
          let handled = true;
          if (k === "w") p.panY += PAN;
          else if (k === "s") p.panY -= PAN;
          else if (k === "a") p.panX += PAN;
          else if (k === "d") p.panX -= PAN;
          else if (k === "q") p.zoom = Math.max(0.4, p.zoom / 1.12);
          else if (k === "e") p.zoom = Math.min(3, p.zoom * 1.12);
          else if (e.key === "ArrowUp") p.pitch = Math.max(-60, p.pitch - ANG);
          else if (e.key === "ArrowDown") p.pitch = Math.min(60, p.pitch + ANG);
          else if (e.key === "ArrowLeft") p.yaw -= ANG;
          else if (e.key === "ArrowRight") p.yaw += ANG;
          else handled = false;
          if (handled) { e.preventDefault(); setP(p); draw(); return; }
        }
      }
      if (isFp && (e.key === "Delete" || e.key === "Backspace") && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement ? document.activeElement.tagName : "")) {
        const floor = this._getActiveFloor();
        if (!floor) return;
        if (this._selectedWindowId) {
          this._fpPushUndo();
          floor.windows = (floor.windows || []).filter((w) => w.id !== this._selectedWindowId);
          this._selectedWindowId = null;
          this._saveFloorplan(); this._render(); this._fpRedraw();
        } else if (this._selectedDoorId) {
          this._fpPushUndo();
          floor.doors = (floor.doors || []).filter((d) => d.id !== this._selectedDoorId);
          this._selectedDoorId = null;
          this._saveFloorplan(); this._render(); this._fpRedraw();
        } else if (this._selectedPointId) {
          this._fpPushUndo();
          const pid = this._selectedPointId;
          floor.points = floor.points.filter((pp) => pp.id !== pid);
          floor.walls = (floor.walls || []).filter((w) => w.p1 !== pid && w.p2 !== pid);
          (floor.rooms || []).forEach((r) => { r.point_ids = (r.point_ids || []).filter((id) => id !== pid); });
          this._selectedPointId = null;
          this._saveFloorplan(); this._render(); this._fpRedraw();
        } else if (this._selectedWallId) {
          this._fpPushUndo();
          floor.walls = (floor.walls || []).filter((w) => w.id !== this._selectedWallId);
          this._selectedWallId = null;
          this._saveFloorplan(); this._render(); this._fpRedraw();
        }
      }
    },

    _handleFloorplanWheel(e) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this._floorplanScale *= delta;
      this._floorplanScale = Math.max(5, Math.min(200, this._floorplanScale));
      this._fpRedraw();
    }
};
