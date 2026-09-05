export const FloorplanDataMixin = {
    _ensureFloorplanSubscription() {
      if (!this._hass || !this._hass.connection || this._floorplanUnsub) return;
      this._floorplanLoading = true;
      this._render();
      try {
        const sub = this._hass.connection.subscribeMessage((msg) => {
          const data = msg.data || msg;
          const fp = data.floorplan || (data.data && data.data.floorplan) || data;
          if (fp && fp.floors) {
            this._floorplan = fp;
            this._floorplanUnits = fp.units || "meters";
            if (!this._selectedFloorId && fp.floors.length) this._selectedFloorId = fp.active_floor_id || fp.floors[0].id;
            this._floorplanLoading = false;
            this._floorplanError = null;
            // Only full re-render if on floorplan tab and not mid-drag; else just redraw canvas
            if (this._activeTab === "floorplan" && !this._dragging && !this._floorplanPanning) this._render();
            this._renderFloorplanCanvas();
            if (this._activeTab === "home") this._renderHomeIsoCanvas();
          }
        }, { type: "spatialHA/floorplan/subscribe" });
        if (sub && typeof sub.then === "function") {
          sub.then((unsub) => { this._floorplanUnsub = unsub; this._floorplanLoading = false; this._fetchFloorplanOnce(); }).catch(() => { this._floorplanLoading = false; this._fetchFloorplanOnce(); });
        } else if (typeof sub === "function") { this._floorplanUnsub = sub; this._floorplanLoading = false; }
        else { this._floorplanLoading = false; this._fetchFloorplanOnce(); }
      } catch (e) { this._floorplanLoading = false; this._fetchFloorplanOnce(); }
    },

    async _fetchFloorplanOnce() {
      if (!this._hass) return;
      try {
        const fp = await this._hass.callWS({ type: "spatialHA/floorplan/get" });
        this._floorplan = fp;
        this._floorplanUnits = fp.units || "meters";
        if (!this._selectedFloorId && fp.floors && fp.floors.length) this._selectedFloorId = fp.active_floor_id || fp.floors[0].id;
      } catch (err) { this._floorplanError = err.message || String(err); }
      finally { this._floorplanLoading = false; this._render(); this._renderFloorplanCanvas(); this._renderHomeIsoCanvas(); }
    },

    async _saveFloorplan() {
      if (!this._hass || !this._floorplan) return;
      try { this._floorplan.units = this._floorplanUnits; this._floorplan.active_floor_id = this._selectedFloorId; await this._hass.callWS({ type: "spatialHA/floorplan/set", floorplan: this._floorplan }); } catch (e) { console.error(e); }
    },

    _getActiveFloor() {
      if (!this._floorplan || !this._floorplan.floors) return null;
      return this._floorplan.floors.find((f) => f.id === this._selectedFloorId) || this._floorplan.floors[0];
    },

    _fpIs3D() {
      return this._activeTab === "floorplan" && this._fpMode === "3d";
    },

    _fpCanvasEl() {
      if (!this.shadowRoot) return null;
      if (this._fpIs3D()) return this.shadowRoot.getElementById("floorplan-3d-canvas");
      return this.shadowRoot.getElementById("floorplan-canvas");
    },

    _fpPickFit(floor) {
      // Fit for picking on the editor 3D preview (slab height of active floor).
      if (typeof this._fpPreviewFit !== "function") return null;
      const info = this._fpPreviewFit();
      if (!info || !info.fit) return null;
      return info;
    },

    _fpToScreen(x, y, floor) {
      if (this._fpIs3D() && typeof this._project3DFit === "function") {
        const info = this._fpPickFit();
        const f = floor || this._getActiveFloor();
        if (info && f) return this._project3DFit(info.fit, x, y, 0.25);
      }
      return this._worldToScreen(x, y, floor);
    },

    _fpToWorld(sx, sy, floor) {
      if (this._fpIs3D() && typeof this._unproject3DFit === "function") {
        const info = this._fpPickFit();
        if (info) {
          const w = this._unproject3DFit(info.fit, sx, sy, 0.25);
          if (w) return w;
        }
        return { x: 0, y: 0 };
      }
      return this._screenToWorld(sx, sy, floor);
    },

    _fpRedraw() {
      if (this._fpIs3D() && typeof this._renderFloorPreview3D === "function") this._renderFloorPreview3D();
      else this._renderFloorplanCanvas();
    },

    _worldToScreen(x, y, floor) {
      const f = floor || this._getActiveFloor();
      if (!f) return { x: 0, y: 0 };
      const cos = Math.cos(f.rotation || 0), sin = Math.sin(f.rotation || 0);
      const sx = (x * (f.scale || 1) + (f.offset_x || 0));
      const sy = (y * (f.scale || 1) + (f.offset_y || 0));
      const rx = sx * cos - sy * sin;
      const ry = sx * sin + sy * cos;
      return { x: rx * this._floorplanScale + this._floorplanOffset.x, y: ry * this._floorplanScale + this._floorplanOffset.y };
    },

    _screenToWorld(sx, sy, floor) {
      const f = floor || this._getActiveFloor();
      if (!f) return { x: 0, y: 0 };
      const cos = Math.cos(f.rotation || 0), sin = Math.sin(f.rotation || 0);
      const x = (sx - this._floorplanOffset.x) / this._floorplanScale;
      const y = (sy - this._floorplanOffset.y) / this._floorplanScale;
      const rx = x * cos + y * sin;
      const ry = -x * sin + y * cos;
      return { x: (rx - (f.offset_x || 0)) / (f.scale || 1), y: (ry - (f.offset_y || 0)) / (f.scale || 1) };
    },

    _doorDefaults() {
      const d = (this._floorplan && this._floorplan.door_defaults) || {};
      return {
        "Door": parseFloat(d["Door"]) || 0.9,
        "Double Door": parseFloat(d["Double Door"]) || 1.6,
        "Garage Door": parseFloat(d["Garage Door"]) || 2.4,
      };
    },

    _windowDefaults() {
      const d = (this._floorplan && this._floorplan.window_defaults) || {};
      return {
        width: parseFloat(d.width) || 1.2,
        height: parseFloat(d.height) || 1.2,
        height_from_floor: parseFloat(d.height_from_floor) || 0.9,
      };
    },

    _windowSeg(win, floor) {
      // Origin = lower-left corner; segment along rotation dir, length = width
      const rad = (parseFloat(win.rotation) || 0) * Math.PI / 180;
      const w = parseFloat(win.width) || 1.2;
      const x = parseFloat(win.x) || 0, y = parseFloat(win.y) || 0;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      const s1 = this._fpToScreen(x, y, floor);
      const s2 = this._fpToScreen(x + dx * w, y + dy * w, floor);
      return { s1, s2, rad, w, x, y, dx, dy };
    },

    _windowHitTest(sx, sy, floor, radius) {
      const r = radius || 10;
      for (const win of (floor.windows || [])) {
        const g = this._windowSeg(win, floor);
        const len = Math.hypot(g.s2.x - g.s1.x, g.s2.y - g.s1.y) || 1;
        const dist = Math.abs((g.s2.y - g.s1.y) * sx - (g.s2.x - g.s1.x) * sy + g.s2.x * g.s1.y - g.s2.y * g.s1.x) / len;
        const dot = ((sx - g.s1.x) * (g.s2.x - g.s1.x) + (sy - g.s1.y) * (g.s2.y - g.s1.y)) / (len * len);
        if (dist < r && dot >= -0.1 && dot <= 1.1) return win;
      }
      return null;
    },

    _doorEndpoints(door, floor) {
      // Returns screen-space segment + leaf geometry for a door (world meters)
      const rad = (parseFloat(door.rotation) || 0) * Math.PI / 180;
      const w = parseFloat(door.width) || 0.9;
      const dx = Math.cos(rad), dy = Math.sin(rad);
      const x = parseFloat(door.x) || 0, y = parseFloat(door.y) || 0;
      const ax = x - dx * w / 2, ay = y - dy * w / 2;
      const bx = x + dx * w / 2, by = y + dy * w / 2;
      const s1 = this._fpToScreen(ax, ay, floor), s2 = this._fpToScreen(bx, by, floor);
      return { ax, ay, bx, by, s1, s2, w, rad };
    },

    _doorHitTest(sx, sy, floor, radius) {
      const r = radius || 10;
      for (const door of (floor.doors || [])) {
        const g = this._doorEndpoints(door, floor);
        const len = Math.hypot(g.s2.x - g.s1.x, g.s2.y - g.s1.y) || 1;
        const dist = Math.abs((g.s2.y - g.s1.y) * sx - (g.s2.x - g.s1.x) * sy + g.s2.x * g.s1.y - g.s2.y * g.s1.x) / len;
        const dot = ((sx - g.s1.x) * (g.s2.x - g.s1.x) + (sy - g.s1.y) * (g.s2.y - g.s1.y)) / (len * len);
        if (dist < r && dot >= -0.1 && dot <= 1.1) return door;
      }
      return null;
    },

    _receiverHitTest(sx, sy, floor, radius) {
      const r = radius || 12;
      for (const rx of (floor.receivers || [])) {
        const s = this._fpToScreen(rx.x, rx.y, floor);
        if (Math.hypot(sx - s.x, sy - s.y) < r) return rx;
      }
      return null;
    },

    _scannerHitTest(sx, sy, floor, radius) {
      const r = radius || 12;
      for (const sc of (floor.scanners || [])) {
        const s = this._fpToScreen(sc.x, sc.y, floor);
        if (Math.hypot(sx - s.x, sy - s.y) < r) return sc;
      }
      return null;
    },

    _fpPushUndo() {
      try {
        this._fpUndo = this._fpUndo || [];
        this._fpRedo = this._fpRedo || [];
        this._fpUndo.push(JSON.stringify(this._floorplan));
        if (this._fpUndo.length > 50) this._fpUndo.shift();
        this._fpRedo = [];
      } catch (e) {}
    },

    _fpUndoDo() {
      if (!this._fpUndo || !this._fpUndo.length) return;
      try {
        this._fpRedo = this._fpRedo || [];
        this._fpRedo.push(JSON.stringify(this._floorplan));
        const prev = this._fpUndo.pop();
        this._floorplan = JSON.parse(prev);
        const f = this._getActiveFloor();
        if (f && !f.points.find((p) => p.id === this._selectedPointId)) this._selectedPointId = null;
        if (f && !(f.doors || []).find((d) => d.id === this._selectedDoorId)) this._selectedDoorId = null;
        if (f && !(f.windows || []).find((w) => w.id === this._selectedWindowId)) this._selectedWindowId = null;
        if (f && !(f.receivers || []).find((r) => r.id === this._selectedReceiverId)) this._selectedReceiverId = null;
        if (f && !(f.scanners || []).find((s) => s.id === this._selectedScannerId)) this._selectedScannerId = null;
        this._saveFloorplan();
        this._render();
        this._renderFloorplanCanvas();
      } catch (e) {}
    },

    _fpRedoDo() {
      if (!this._fpRedo || !this._fpRedo.length) return;
      try {
        this._fpUndo = this._fpUndo || [];
        this._fpUndo.push(JSON.stringify(this._floorplan));
        const nxt = this._fpRedo.pop();
        this._floorplan = JSON.parse(nxt);
        this._saveFloorplan();
        this._render();
        this._renderFloorplanCanvas();
      } catch (e) {}
    }
};
