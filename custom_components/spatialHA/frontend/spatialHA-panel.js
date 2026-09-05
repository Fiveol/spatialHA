/**
 * spatialHA Panel - WebSocket architecture with BLE + Settings + Targets
 * Frontend NEVER queries directly. All data goes via backend WebSocket
 * through Home Assistant: hass.callWS / hass.connection.subscribeMessage -> backend -> HA
 */
if (!customElements.get("spatialHA-panel")) {
class SpatialHAPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._activeTab = "home";
    this._activeBleSubTab = "scanner";
    this._version = null;
    this._loadingVersion = false;
    this._hasFetchedVersion = false;
    this._versionError = null;
    // BLE state
    this._bleLoading = false;
    this._bleError = null;
    this._bleData = null;
    this._bleUnsub = null;
    // Settings state
    this._settings = null;
    this._settingsLoading = false;
    this._settingsError = null;
    this._settingsSaving = false;
    this._pendingInterval = null;
    // Targets state
    this._targets = [];
    this._targetsLoading = false;
    this._targetsError = null;
    this._targetsUnsub = null;
    this._editingTarget = null; // target being edited, or null for new
    this._showAddForm = false;
    this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
    // GPS state
    this._gpsData = null;
    this._gpsLoading = false;
    this._gpsError = null;
    this._gpsUnsub = null;
    // Floorplan state
    this._floorplan = null;
    this._floorplanLoading = false;
    this._floorplanError = null;
    this._floorplanUnsub = null;
    this._floorplanUnits = "meters";
    this._selectedFloorId = null;
    this._selectedPointId = null;
    this._selectedWallId = null;
    this._selectedRoomId = null;
    this._contextMenu = null; // {x,y,pointId}
    this._dragging = null;
    this._floorplanScale = 40; // px per meter
    this._floorplanOffset = {x: 400, y: 300};
    this._floorplanPanning = false;
    this._floorplanPanStart = null;
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (firstHass) {
      if (this._activeTab === "about" && !this._hasFetchedVersion) this._fetchVersion();
      if (this._activeTab === "settings" && !this._settings) this._fetchSettings();
      if (this._activeTab === "ble") this._ensureBleSubscription();
      if (this._activeTab === "targets") this._ensureTargetsSubscription();
      if (this._activeTab === "gps") this._ensureGpsSubscription();
      if (this._activeTab === "floorplan") this._ensureFloorplanSubscription();
    } else {
      if (this._activeTab === "about" && !this._hasFetchedVersion && !this._loadingVersion) this._fetchVersion();
      if (this._activeTab === "ble" && !this._bleUnsub) this._ensureBleSubscription();
      if (this._activeTab === "settings" && !this._settings && !this._settingsLoading) this._fetchSettings();
      if (this._activeTab === "targets" && !this._targetsUnsub) this._ensureTargetsSubscription();
      if (this._activeTab === "gps" && !this._gpsUnsub) this._ensureGpsSubscription();
      if (this._activeTab === "floorplan" && !this._floorplanUnsub) this._ensureFloorplanSubscription();
    }
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    if (this._bleUnsub) { try { this._bleUnsub(); } catch(e){} this._bleUnsub = null; }
    if (this._targetsUnsub) { try { this._targetsUnsub(); } catch(e){} this._targetsUnsub = null; }
    if (this._gpsUnsub) { try { this._gpsUnsub(); } catch(e){} this._gpsUnsub = null; }
    if (this._floorplanUnsub) { try { this._floorplanUnsub(); } catch(e){} this._floorplanUnsub = null; }
  }

  _switchTab(tab) {
    if (this._activeTab === tab) return;
    this._activeTab = tab;
    this._render();
    if (tab === "about" && !this._hasFetchedVersion && this._hass && !this._loadingVersion) this._fetchVersion();
    if (tab === "settings" && !this._settings && this._hass && !this._settingsLoading) this._fetchSettings();
    if (tab === "ble" && this._hass) this._ensureBleSubscription();
    if (tab === "targets" && this._hass) this._ensureTargetsSubscription();
    if (tab === "gps" && this._hass) this._ensureGpsSubscription();
    if (tab === "floorplan" && this._hass) this._ensureFloorplanSubscription();
  }

  _switchBleSubTab(sub) {
    this._activeBleSubTab = sub;
    this._render();
  }

  async _fetchVersion() {
    if (!this._hass || this._loadingVersion) return;
    this._loadingVersion = true;
    this._hasFetchedVersion = true;
    this._versionError = null;
    this._render();
    try {
      const result = await this._hass.callWS({ type: "spatialHA/get_version" });
      this._version = result.version;
      this._versionError = null;
    } catch (err) {
      this._versionError = err.message || String(err);
      this._version = null;
    } finally {
      this._loadingVersion = false;
      this._render();
    }
  }

  async _fetchSettings() {
    if (!this._hass || this._settingsLoading) return;
    this._settingsLoading = true;
    this._settingsError = null;
    this._render();
    try {
      const settings = await this._hass.callWS({ type: "spatialHA/settings/get" });
      this._settings = settings;
      this._pendingInterval = String(settings.update_interval ?? 1);
    } catch (err) {
      this._settingsError = err.message || String(err);
    } finally {
      this._settingsLoading = false;
      this._render();
    }
  }

  async _saveSettings() {
    if (!this._hass || this._settingsSaving) return;
    const val = parseFloat(this._pendingInterval);
    if (isNaN(val) || val < 0.5 || val > 3600) {
      this._settingsError = "Update Interval must be between 0.5 and 3600 seconds";
      this._render();
      return;
    }
    this._settingsSaving = true;
    this._settingsError = null;
    this._render();
    try {
      const res = await this._hass.callWS({ type: "spatialHA/settings/set", update_interval: val });
      this._settings = res;
      this._pendingInterval = String(res.update_interval);
    } catch (err) {
      this._settingsError = err.message || String(err);
    } finally {
      this._settingsSaving = false;
      this._render();
    }
  }

  _ensureBleSubscription() {
    if (!this._hass || !this._hass.connection || this._bleUnsub) return;
    this._bleLoading = true;
    this._render();
    try {
      const sub = this._hass.connection.subscribeMessage(
        (msg) => {
          const data = msg.data || msg;
          const payload = data.data || data;
          if (payload && (payload.scanners || payload.devices || payload.sightings)) {
            this._bleData = payload;
            this._bleLoading = false;
            this._bleError = null;
            // Only re-render if on BLE tab or Targets (needs BLE list); never disturb floorplan/inputs
            if (this._activeTab === "ble" || (this._activeTab === "targets" && this._showAddForm)) this._render();
          }
        },
        { type: "spatialHA/ble/subscribe" }
      );
      if (sub && typeof sub.then === "function") {
        sub.then((unsub) => {
          this._bleUnsub = unsub;
          this._bleLoading = false;
          this._fetchBleOnce();
        }).catch(() => {
          this._bleLoading = false;
          this._fetchBleOnce();
        });
      } else if (typeof sub === "function") {
        this._bleUnsub = sub;
        this._bleLoading = false;
      } else {
        this._bleLoading = false;
        this._fetchBleOnce();
      }
    } catch (e) {
      this._bleLoading = false;
      this._fetchBleOnce();
    }
  }

  async _fetchBleOnce() {
    if (!this._hass) return;
    try {
      const data = await this._hass.callWS({ type: "spatialHA/ble/get_data" });
      this._bleData = data;
      this._bleError = null;
    } catch (err) {
      this._bleError = err.message || String(err);
    } finally {
      this._bleLoading = false;
      this._render();
    }
  }

  _ensureGpsSubscription() {
    if (!this._hass || !this._hass.connection || this._gpsUnsub) return;
    this._gpsLoading = true;
    this._render();
    try {
      const sub = this._hass.connection.subscribeMessage(
        (msg) => {
          const data = msg.data || msg;
          const payload = data.data || data;
          if (payload && (payload.entities || payload.count !== undefined)) {
            this._gpsData = payload;
            this._gpsLoading = false;
            this._gpsError = null;
            if (this._activeTab === "gps" || (this._activeTab === "targets" && this._showAddForm)) this._render();
          }
        },
        { type: "spatialHA/gps/subscribe" }
      );
      if (sub && typeof sub.then === "function") {
        sub.then((unsub) => {
          this._gpsUnsub = unsub;
          this._gpsLoading = false;
          this._fetchGpsOnce();
        }).catch(() => {
          this._gpsLoading = false;
          this._fetchGpsOnce();
        });
      } else if (typeof sub === "function") {
        this._gpsUnsub = sub;
        this._gpsLoading = false;
      } else {
        this._gpsLoading = false;
        this._fetchGpsOnce();
      }
    } catch (e) {
      this._gpsLoading = false;
      this._fetchGpsOnce();
    }
  }

  async _fetchGpsOnce() {
    if (!this._hass) return;
    try {
      const data = await this._hass.callWS({ type: "spatialHA/gps/list" });
      this._gpsData = data;
      this._gpsError = null;
    } catch (err) {
      this._gpsError = err.message || String(err);
    } finally {
      this._gpsLoading = false;
      this._render();
    }
  }

  // ---- Floorplan ----
  _metersToDisplay(m) {
    if (this._floorplanUnits === "feet_inches") {
      const totalInches = m * 39.3701;
      const feet = Math.floor(totalInches / 12);
      const inches = (totalInches % 12).toFixed(1);
      return feet + "' " + inches + '"';
    }
    return Number(m).toFixed(2) + " m";
  }
  _displayToMeters(v) {
    if (this._floorplanUnits === "feet_inches") return v * 0.3048;
    return v;
  }
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
        }
      }, { type: "spatialHA/floorplan/subscribe" });
      if (sub && typeof sub.then === "function") {
        sub.then((unsub) => { this._floorplanUnsub = unsub; this._floorplanLoading = false; this._fetchFloorplanOnce(); }).catch(() => { this._floorplanLoading = false; this._fetchFloorplanOnce(); });
      } else if (typeof sub === "function") { this._floorplanUnsub = sub; this._floorplanLoading = false; }
      else { this._floorplanLoading = false; this._fetchFloorplanOnce(); }
    } catch (e) { this._floorplanLoading = false; this._fetchFloorplanOnce(); }
  }
  async _fetchFloorplanOnce() {
    if (!this._hass) return;
    try {
      const fp = await this._hass.callWS({ type: "spatialHA/floorplan/get" });
      this._floorplan = fp;
      this._floorplanUnits = fp.units || "meters";
      if (!this._selectedFloorId && fp.floors && fp.floors.length) this._selectedFloorId = fp.active_floor_id || fp.floors[0].id;
    } catch (err) { this._floorplanError = err.message || String(err); }
    finally { this._floorplanLoading = false; this._render(); this._renderFloorplanCanvas(); }
  }
  async _saveFloorplan() {
    if (!this._hass || !this._floorplan) return;
    try { this._floorplan.units = this._floorplanUnits; this._floorplan.active_floor_id = this._selectedFloorId; await this._hass.callWS({ type: "spatialHA/floorplan/set", floorplan: this._floorplan }); } catch (e) { console.error(e); }
  }
  _getActiveFloor() {
    if (!this._floorplan || !this._floorplan.floors) return null;
    return this._floorplan.floors.find((f) => f.id === this._selectedFloorId) || this._floorplan.floors[0];
  }
  _worldToScreen(x, y, floor) {
    const f = floor || this._getActiveFloor();
    if (!f) return { x: 0, y: 0 };
    const cos = Math.cos(f.rotation || 0), sin = Math.sin(f.rotation || 0);
    const sx = (x * (f.scale || 1) + (f.offset_x || 0));
    const sy = (y * (f.scale || 1) + (f.offset_y || 0));
    const rx = sx * cos - sy * sin;
    const ry = sx * sin + sy * cos;
    return { x: rx * this._floorplanScale + this._floorplanOffset.x, y: ry * this._floorplanScale + this._floorplanOffset.y };
  }
  _screenToWorld(sx, sy, floor) {
    const f = floor || this._getActiveFloor();
    if (!f) return { x: 0, y: 0 };
    const cos = Math.cos(f.rotation || 0), sin = Math.sin(f.rotation || 0);
    const x = (sx - this._floorplanOffset.x) / this._floorplanScale;
    const y = (sy - this._floorplanOffset.y) / this._floorplanScale;
    const rx = x * cos + y * sin;
    const ry = -x * sin + y * cos;
    return { x: (rx - (f.offset_x || 0)) / (f.scale || 1), y: (ry - (f.offset_y || 0)) / (f.scale || 1) };
  }
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
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.strokeStyle = "#eee"; ctx.lineWidth = 1;
    const gridStep = this._floorplanScale * (this._floorplanUnits === "meters" ? 1 : 0.6096);
    for (let x = this._floorplanOffset.x % gridStep; x < w; x += gridStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = this._floorplanOffset.y % gridStep; y < h; y += gridStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    for (const room of (floor.rooms || [])) {
      if (!room.point_ids || room.point_ids.length < 3) continue;
      const pts = room.point_ids.map((id) => floor.points.find((p) => p.id === id)).filter(Boolean);
      if (pts.length < 3) continue;
      ctx.fillStyle = room.color || "rgba(100,150,255,0.2)";
      ctx.strokeStyle = room.color || "#6496ff"; ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, i) => { const s = this._worldToScreen(p.x, p.y, floor); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#333"; ctx.font = "12px sans-serif";
      const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 }); c.x /= pts.length; c.y /= pts.length;
      const sc = this._worldToScreen(c.x, c.y, floor); ctx.fillText(room.name || room.id, sc.x - 20, sc.y);
    }
    for (const wall of (floor.walls || [])) {
      const p1 = floor.points.find((p) => p.id === wall.p1), p2 = floor.points.find((p) => p.id === wall.p2);
      if (!p1 || !p2) continue;
      const s1 = this._worldToScreen(p1.x, p1.y, floor), s2 = this._worldToScreen(p2.x, p2.y, floor);
      if (this._selectedWallId === wall.id) { ctx.strokeStyle = "#ff6600"; ctx.lineWidth = 4; } else { ctx.strokeStyle = "#333"; ctx.lineWidth = 3; }
      ctx.beginPath(); ctx.moveTo(s1.x, s1.y); ctx.lineTo(s2.x, s2.y); ctx.stroke();
    }
    for (const pt of (floor.points || [])) {
      const s = this._worldToScreen(pt.x, pt.y, floor);
      const isSelected = this._selectedPointId === pt.id;
      ctx.fillStyle = isSelected ? "#ff6600" : "#03a9f4";
      ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "white"; ctx.lineWidth = 2; ctx.stroke();
      // No names/IDs shown (per request) - dots only, selected gets ring
      if (isSelected) {
        ctx.strokeStyle = "#ff6600"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, 10, 0, Math.PI * 2); ctx.stroke();
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
  }
  _handleFloorplanClick(e) {
    const canvas = this.shadowRoot.getElementById("floorplan-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    // CSS pixels (worldToScreen returns CSS px, canvas is DPR-scaled via setTransform)
    const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
    const floor = this._getActiveFloor();
    if (!floor) return;
    if (this._contextMenu) {
      const pt = floor.points.find((p) => p.id === this._contextMenu.pointId);
      if (pt) {
        const s = this._worldToScreen(pt.x, pt.y, floor);
        const dirs = [{ dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }];
        for (const d of dirs) {
          const ax = s.x + d.dx * 40, ay = s.y + d.dy * 40;
          if (Math.hypot(sx - ax, sy - ay) < 16) {
            const unitLabel = this._floorplanUnits === "meters" ? "meters" : "feet";
            const def = this._floorplanUnits === "meters" ? "2" : "6";
            const valStr = prompt("How many " + unitLabel + " away should the new point be placed?", def);
            if (valStr === null) return;
            const dist = parseFloat(valStr);
            if (isNaN(dist) || dist <= 0) { alert("Invalid distance"); return; }
            const distM = this._displayToMeters(dist);
            const newX = pt.x + d.dx * distM;
            const newY = pt.y + d.dy * distM;
            this._fpPushUndo();
            const newId = "point_" + Date.now();
            floor.points.push({ id: newId, x: newX, y: newY, label: "" });
            floor.walls.push({ id: "wall_" + Date.now(), p1: pt.id, p2: newId });
            this._selectedPointId = newId;
            this._contextMenu = null;
            this._saveFloorplan();
            this._render();
            this._renderFloorplanCanvas();
            return;
          }
        }
      }
    }
    for (const pt of floor.points) {
      const s = this._worldToScreen(pt.x, pt.y, floor);
      if (Math.hypot(sx - s.x, sy - s.y) < 12) {
        if (e.button === 2) {
          this._contextMenu = { x: sx, y: sy, pointId: pt.id };
          this._selectedPointId = pt.id;
          this._renderFloorplanCanvas();
          return;
        } else {
          this._selectedPointId = pt.id;
          this._selectedWallId = null;
          this._contextMenu = null;
          this._renderFloorplanCanvas();
          return;
        }
      }
    }
    for (const wall of floor.walls) {
      const p1 = floor.points.find((p) => p.id === wall.p1), p2 = floor.points.find((p) => p.id === wall.p2);
      if (!p1 || !p2) continue;
      const s1 = this._worldToScreen(p1.x, p1.y, floor), s2 = this._worldToScreen(p2.x, p2.y, floor);
      const len = Math.hypot(s2.x - s1.x, s2.y - s1.y) || 1;
      const dist = Math.abs((s2.y - s1.y) * sx - (s2.x - s1.x) * sy + s2.x * s1.y - s2.y * s1.x) / len;
      const dot = ((sx - s1.x) * (s2.x - s1.x) + (sy - s1.y) * (s2.y - s1.y)) / (len * len);
      if (dist < 10 && dot >= 0 && dot <= 1) {
        this._selectedWallId = wall.id; this._selectedPointId = null; this._contextMenu = null; this._renderFloorplanCanvas(); return;
      }
    }
    this._selectedPointId = null; this._selectedWallId = null; this._contextMenu = null; this._renderFloorplanCanvas();
  }
  _fpPushUndo() {
    try {
      this._fpUndo = this._fpUndo || [];
      this._fpRedo = this._fpRedo || [];
      this._fpUndo.push(JSON.stringify(this._floorplan));
      if (this._fpUndo.length > 50) this._fpUndo.shift();
      this._fpRedo = [];
    } catch (e) {}
  }
  _fpUndoDo() {
    if (!this._fpUndo || !this._fpUndo.length) return;
    try {
      this._fpRedo = this._fpRedo || [];
      this._fpRedo.push(JSON.stringify(this._floorplan));
      const prev = this._fpUndo.pop();
      this._floorplan = JSON.parse(prev);
      const f = this._getActiveFloor();
      if (f && !f.points.find((p) => p.id === this._selectedPointId)) this._selectedPointId = null;
      this._saveFloorplan();
      this._render();
      this._renderFloorplanCanvas();
    } catch (e) {}
  }
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
  _handleFloorplanDblClick(e) {
    const canvas = this.shadowRoot.getElementById("floorplan-canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left), sy = (e.clientY - rect.top);
    const floor = this._getActiveFloor();
    if (!floor) return;
    for (const pt of floor.points) {
      const s = this._worldToScreen(pt.x, pt.y, floor);
      if (Math.hypot(sx - s.x, sy - s.y) < 12) {
        const unitLabel = this._floorplanUnits === "meters" ? "meters" : "feet";
        const toDisp = (m) => this._floorplanUnits === "meters" ? m.toFixed(2) : (m / 0.3048).toFixed(2);
        const xs = prompt("New X (" + unitLabel + ")?", toDisp(pt.x));
        if (xs === null) return;
        const ys = prompt("New Y (" + unitLabel + ")?", toDisp(pt.y));
        if (ys === null) return;
        const xv = parseFloat(xs), yv = parseFloat(ys);
        if (isNaN(xv) || isNaN(yv)) { alert("Invalid position"); return; }
        this._fpPushUndo();
        pt.x = this._displayToMeters(xv);
        pt.y = this._displayToMeters(yv);
        this._saveFloorplan();
        this._renderFloorplanCanvas();
        return;
      }
    }
  }
  _handleFloorplanMouseDown(e) {
    if (e.button !== 0) return;
    // No point dragging (per request) - only pan on empty drag
    this._floorplanPanning = true;
    this._floorplanPanStart = { x: e.clientX, y: e.clientY, ox: this._floorplanOffset.x, oy: this._floorplanOffset.y };
  }
  _handleFloorplanMouseMove(e) {
    const canvas = this.shadowRoot.getElementById("floorplan-canvas");
    if (!canvas) return;
    const floor = this._getActiveFloor();
    if (!floor) return;
    if (this._floorplanPanning && this._floorplanPanStart) {
      this._floorplanOffset.x = this._floorplanPanStart.ox + (e.clientX - this._floorplanPanStart.x);
      this._floorplanOffset.y = this._floorplanPanStart.oy + (e.clientY - this._floorplanPanStart.y);
      this._renderFloorplanCanvas();
    }
  }
  _handleFloorplanMouseUp(e) {
    if (this._floorplanPanning) { this._floorplanPanning = false; this._floorplanPanStart = null; }
  }
  _handleFloorplanKeyDown(e) {
    const isFp = this._activeTab === "floorplan";
    if (!isFp) return;
    const mod = e.ctrlKey || e.metaKey;
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
      // Copy selected point or wall
      if (this._selectedPointId) {
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
      if (this._fpClipboard.kind === "point") {
        const src = this._fpClipboard.data;
        const nid = "point_" + Date.now();
        floor.points.push({ id: nid, x: (src.x || 0) + 0.5, y: (src.y || 0) + 0.5, label: "" });
        this._selectedPointId = nid;
      } else if (this._fpClipboard.kind === "wall") {
        const src = this._fpClipboard.data;
        // Paste wall requires its points; duplicate points too with offset
        const p1 = floor.points.find((p) => p.id === src.p1), p2 = floor.points.find((p) => p.id === src.p2);
        if (p1 && p2) {
          const n1 = "point_" + Date.now(), n2 = "point_" + (Date.now() + 1);
          floor.points.push({ id: n1, x: p1.x + 0.5, y: p1.y + 0.5, label: "" });
          floor.points.push({ id: n2, x: p2.x + 0.5, y: p2.y + 0.5, label: "" });
          floor.walls.push({ id: "wall_" + Date.now(), p1: n1, p2: n2 });
        }
      }
      this._saveFloorplan();
      this._render();
      this._renderFloorplanCanvas();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement ? document.activeElement.tagName : "")) {
      const floor = this._getActiveFloor();
      if (!floor) return;
      if (this._selectedPointId) {
        this._fpPushUndo();
        const pid = this._selectedPointId;
        floor.points = floor.points.filter((pp) => pp.id !== pid);
        floor.walls = (floor.walls || []).filter((w) => w.p1 !== pid && w.p2 !== pid);
        (floor.rooms || []).forEach((r) => { r.point_ids = (r.point_ids || []).filter((id) => id !== pid); });
        this._selectedPointId = null;
        this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
      } else if (this._selectedWallId) {
        this._fpPushUndo();
        floor.walls = (floor.walls || []).filter((w) => w.id !== this._selectedWallId);
        this._selectedWallId = null;
        this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
      }
    }
  }
  _handleFloorplanWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    this._floorplanScale *= delta;
    this._floorplanScale = Math.max(5, Math.min(200, this._floorplanScale));
    this._renderFloorplanCanvas();
  }
  _renderFloorplan() {
    if (this._floorplanLoading) return `<p class="loading">Loading floorplan…</p>`;
    if (this._floorplanError) return `<p class="error">Error: ${this._esc(this._floorplanError)}</p><p><button id="floorplan-retry">Retry</button></p>`;
    if (!this._floorplan || !this._floorplan.floors) return `<p>No floorplan.</p>`;
    const floor = this._getActiveFloor();
    if (!floor) return `<p>No active floor.</p>`;
    const unitsSel = `<select id="floorplan-units"><option value="meters" ${this._floorplanUnits === "meters" ? "selected" : ""}>Meters</option><option value="feet_inches" ${this._floorplanUnits === "feet_inches" ? "selected" : ""}>Feet/Inches</option></select>`;
    const floorTabs = this._floorplan.floors.map((f) => `<button data-floor="${this._esc(f.id)}" style="padding:6px 12px; margin:2px; border:1px solid #ccc; border-radius:4px; background:${f.id === this._selectedFloorId ? "#03a9f4" : "#fafafa"}; color:${f.id === this._selectedFloorId ? "white" : "#333"}; cursor:pointer;">${this._esc(f.name)} (L${f.level})</button>`).join("");
    const wallsHtml = (floor.walls || []).map((w) => {
      const p1 = floor.points.find((p) => p.id === w.p1), p2 = floor.points.find((p) => p.id === w.p2);
      const len = p1 && p2 ? Math.hypot(p1.x - p2.x, p1.y - p2.y) : 0;
      return `<tr><td>${this._esc(this._metersToDisplay(len))}</td><td><button data-del-wall="${this._esc(w.id)}">Delete</button></td></tr>`;
    }).join("") || `<tr><td colspan="2"><em>No walls</em></td></tr>`;
    const roomsHtml = (floor.rooms || []).map((r) => `<tr><td>${this._esc(r.name)}</td><td>${this._esc(String((r.point_ids || []).length))} pts</td><td><input type="color" value="${this._esc(r.color || "#6496ff")}" data-room-color="${this._esc(r.id)}" style="width:40px;"></td><td><button data-del-room="${this._esc(r.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="4"><em>No rooms</em></td></tr>`;
    const selectedInfo = this._selectedPointId ? (() => { const pt = floor.points.find((p) => p.id === this._selectedPointId); return pt ? `Selected point at (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}) m - double-click to edit` : ""; })() : (this._selectedWallId ? `Wall selected` : "Left-click selects, double-click point to edit position, right-click point for 4 arrows");
    return `
      <div class="card">
        <h2>Floor Plan - ${this._esc(floor.name)}</h2>
        <p>Multi-floor editor. Start point at 0,0. Units: ${unitsSel} (internal meters). Right-click point → 4 arrows → click arrow → dialog asks distance. Left-click selects, double-click point to edit position. Drag empty to pan, wheel to zoom. Ctrl+Z undo, Ctrl+Y redo, Ctrl+C / Ctrl+V copy-paste.</p>
        <div style="margin:8px 0; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button id="floor-add">Add Floor</button>
          <button id="floor-rename">Rename Floor</button>
          <button id="floor-delete">Delete Floor</button>
          <label>Level: <input id="floor-level" type="number" value="${floor.level}" style="width:60px"></label>
        </div>
        <div style="display:flex; gap:4px; margin:8px 0; flex-wrap:wrap;">${floorTabs}</div>
        <div id="floorplan-wrap" style="border:1px solid #ccc; border-radius:8px; overflow:hidden; background:#fafafa; aspect-ratio: 8/5; max-height:520px;">
          <canvas id="floorplan-canvas" width="800" height="500" style="display:block; cursor:crosshair; width:100%; height:100%;"></canvas>
        </div>
        <p><small>${selectedInfo} | Scale: ${this._floorplanScale.toFixed(1)}px/m</small></p>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px;">
          <div><h3>Walls</h3><p><button id="wall-add">Add Wall (selected + last)</button></p><table><thead><tr><th>Length</th><th>Action</th></tr></thead><tbody>${wallsHtml}</tbody></table></div>
          <div><h3>Rooms</h3><p><button id="room-add">Add Room (all points)</button></p><table><thead><tr><th>Name</th><th>Points</th><th>Color</th><th>Action</th></tr></thead><tbody>${roomsHtml}</tbody></table></div>
        </div>
        <div style="margin-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:16px;">
          <div style="border:1px solid #eee; padding:10px; border-radius:6px;"><h4>Floor Alignment</h4><label>Offset X (m): <input id="align-x" type="number" step="0.1" value="${floor.offset_x || 0}" style="width:80px"></label><br><label>Offset Y (m): <input id="align-y" type="number" step="0.1" value="${floor.offset_y || 0}" style="width:80px"></label><br><label>Scale: <input id="align-scale" type="number" step="0.1" value="${floor.scale || 1}" style="width:80px"></label><br><label>Rotation (deg): <input id="align-rot" type="number" step="1" value="${(((floor.rotation || 0) * 180 / Math.PI)).toFixed(1)}" style="width:80px"></label><br><button id="align-save">Save Alignment</button></div>
          <div style="border:1px solid #eee; padding:10px; border-radius:6px;"><h4>Points (${floor.points.length})</h4><div style="max-height:150px; overflow:auto;">${floor.points.map((p) => `<div style="padding:4px; background:${p.id === this._selectedPointId ? "#e3f2fd" : "transparent"}; border-radius:4px;">(${p.x.toFixed(2)},${p.y.toFixed(2)}) <button data-del-point="${this._esc(p.id)}" style="float:right;">Delete</button></div>`).join("")}</div><p><button id="point-add">Add Point at 0,0</button></p></div>
        </div>
      </div>
    `;
  }


    _renderGps() {
    if (this._gpsLoading) return `<p class="loading">Loading GPS entitiesï¿½</p>`;
    if (this._gpsError) return `<p class="error">Error: ${this._esc(this._gpsError)}</p><p><button id="gps-retry">Retry</button></p>`;
    if (!this._gpsData || !this._gpsData.entities || this._gpsData.entities.length === 0) {
      return `<p>No Device Tracker entities found. Ensure GPS trackers are configured.</p><p><button id="gps-retry">Refresh</button></p>`;
    }
    const entities = this._gpsData.entities;
    let rows = entities.map(e => `
      <tr>
        <td><code>${this._esc(e.entity_id)}</code></td>
        <td>${this._esc(e.name || e.friendly_name || "")}</td>
        <td style="color:${e.state==="home"?"var(--success-color, green)":"var(--error-color, #db4437)"};font-weight:600">${this._esc(e.state)}</td>
        <td>${this._esc(e.source_type || "")}</td>
        <td>${e.latitude!=null ? this._esc(String(e.latitude)).slice(0,7)+", "+this._esc(String(e.longitude)).slice(0,7) : "N/A"}</td>
        <td><ha-icon icon="${this._esc(e.icon)}"></ha-icon> <code>${this._esc(e.icon)}</code></td>
      </tr>`).join("");
    return `
      <div style="overflow:auto">
        <p><em>${entities.length} Device Tracker entities. Add to Targets alongside BLE.</em> <button id="gps-refresh">Refresh</button></p>
        <table>
          <thead><tr><th>Entity ID</th><th>Name</th><th>State</th><th>Source</th><th>Location</th><th>Icon</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _ensureTargetsSubscription() {
    if (!this._hass || !this._hass.connection || this._targetsUnsub) return;
    this._targetsLoading = true;
    this._render();
    try {
      const sub = this._hass.connection.subscribeMessage(
        (msg) => {
          const data = msg.data || msg;
          const payload = data.targets ? data : (data.data || data);
          const targets = payload.targets || payload;
          // Don't clobber form edits: if user is adding/editing, keep form but update list silently
          const editing = this._showAddForm;
          if (Array.isArray(targets) || Array.isArray(payload.targets)) {
            this._targets = payload.targets || targets;
            this._targetsLoading = false;
            this._targetsError = null;
            if (this._activeTab === "targets" && !editing) this._render();
            else if (this._activeTab === "targets" && editing) { /* update list without full re-render to preserve inputs */ }
          } else if (payload && payload.targets) {
            this._targets = payload.targets;
            this._targetsLoading = false;
            if (this._activeTab === "targets" && !editing) this._render();
          }
        },
        { type: "spatialHA/targets/subscribe" }
      );
      if (sub && typeof sub.then === "function") {
        sub.then((unsub) => {
          this._targetsUnsub = unsub;
          // Also fetch once
          this._fetchTargetsOnce();
        }).catch(() => {
          this._fetchTargetsOnce();
        });
      } else if (typeof sub === "function") {
        this._targetsUnsub = sub;
      } else {
        this._fetchTargetsOnce();
      }
    } catch (e) {
      this._fetchTargetsOnce();
    }
  }

  async _fetchTargetsOnce() {
    if (!this._hass) return;
    try {
      const res = await this._hass.callWS({ type: "spatialHA/targets/list" });
      this._targets = res.targets || res || [];
      this._targetsError = null;
    } catch (err) {
      this._targetsError = err.message || String(err);
    } finally {
      this._targetsLoading = false;
      this._render();
    }
  }

  async _createTarget() {
    if (!this._hass) return;
    const name = this._targetForm.name.trim();
    if (!name) { alert("Name required"); return; }
    try {
      await this._hass.callWS({
        type: "spatialHA/targets/create",
        name: name,
        target_type: this._targetForm.type,
        icon: this._targetForm.icon,
        ble_devices: this._targetForm.ble_devices,
        gps_entities: this._targetForm.gps_entities || [],
      });
      this._showAddForm = false;
      this._editingTarget = null;
      this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [] };
      // Targets will be pushed via subscription, but also fetch
      this._fetchTargetsOnce();
    } catch (e) {
      alert("Failed to create target: " + (e.message || String(e)));
    }
  }

  async _updateTarget() {
    if (!this._hass || !this._editingTarget) return;
    try {
      await this._hass.callWS({
        type: "spatialHA/targets/update",
        target_id: this._editingTarget.id,
        name: this._targetForm.name.trim() || this._editingTarget.name,
        target_type: this._targetForm.type,
        icon: this._targetForm.icon,
        ble_devices: this._targetForm.ble_devices,
        gps_entities: this._targetForm.gps_entities || [],
      });
      this._editingTarget = null;
      this._showAddForm = false;
      this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [] };
      this._fetchTargetsOnce();
    } catch (e) {
      alert("Failed to update target: " + (e.message || String(e)));
    }
  }

  async _deleteTarget(id) {
    if (!confirm("Delete target?")) return;
    try {
      await this._hass.callWS({ type: "spatialHA/targets/delete", target_id: id });
      this._fetchTargetsOnce();
    } catch (e) {
      alert("Failed to delete: " + (e.message || String(e)));
    }
  }

  _startEdit(target) {
    this._editingTarget = target;
    this._showAddForm = true;
    this._targetForm = {
      name: target.name || "",
      type: target.type || "Other",
      icon: target.icon || (target.type === "Person" ? "mdi:account" : "mdi:help-circle"),
      ble_devices: [...(target.ble_devices || [])],
      gps_entities: [...(target.gps_entities || [])],
    };
    this._render();
  }

  _startAdd() {
    this._editingTarget = null;
    this._showAddForm = true;
    this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
    this._render();
  }

  _cancelForm() {
    this._showAddForm = false;
    this._editingTarget = null;
    this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
    this._render();
  }

  _toggleBleDevice(addr) {
    const upper = String(addr).toUpperCase();
    const idx = this._targetForm.ble_devices.findIndex(a => String(a).toUpperCase() === upper);
    if (idx >= 0) this._targetForm.ble_devices.splice(idx, 1);
    else this._targetForm.ble_devices.push(upper);
    this._render();
  }

  _toggleGpsEntity(entity_id) {
    const idx = this._targetForm.gps_entities.indexOf(entity_id);
    if (idx >= 0) this._targetForm.gps_entities.splice(idx, 1);
    else this._targetForm.gps_entities.push(entity_id);
    this._render();
  }

  _renderBleScannerView() {
    if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocketâ€¦ (auto-refresh every Update Interval)</p>`;
    if (this._bleError) return `<p class="error">Error: ${this._esc(this._bleError)}</p><p><button id="ble-retry">Retry</button></p>`;
    if (!this._bleData || !this._bleData.sightings || this._bleData.sightings.length === 0) {
      const hasScanners = this._bleData && this._bleData.scanners && this._bleData.scanners.length > 0;
      if (!hasScanners) return `<p>No Bluetooth scanners found. Ensure Bluetooth proxies are configured. Data auto-updates every Update Interval.</p><p><button id="ble-retry">Refresh</button></p>`;
      return `<p>No BLE devices found by scanners. Auto-refreshingâ€¦</p><p><button id="ble-retry">Refresh</button></p>`;
    }
    const sightings = this._bleData.sightings;
    let rows = sightings.map(s => `
      <tr>
        <td>${this._esc(s.scanner_name || s.source)}</td>
        <td><code>${this._esc(s.address)}</code></td>
        <td>${this._esc(s.name || "")}</td>
        <td>${s.rssi !== null && s.rssi !== undefined ? this._esc(String(s.rssi)) + " dBm" : "N/A"}</td>
      </tr>
    `).join("");
    const updated = this._bleData.last_updated ? new Date(this._bleData.last_updated * 1000).toLocaleTimeString() : "";
    return `
      <div style="overflow:auto">
        <p><em>Scanner view: every sighting (device Ã— scanner). ${sightings.length} rows. Auto-updates every ${this._esc(String(this._bleData.update_interval || this._settings?.update_interval || 1))}s ${updated ? " â€“ last: " + updated : ""}</em></p>
        <table>
          <thead><tr><th>Scanner</th><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _renderBleDeviceView() {
    if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocketâ€¦ (auto-refresh every Update Interval)</p>`;
    if (this._bleError) return `<p class="error">Error: ${this._bleError}</p><p><button id="ble-retry">Retry</button></p>`;
    if (!this._bleData || !this._bleData.devices || this._bleData.devices.length === 0) {
      return `<p>No BLE devices found. Auto-refreshingâ€¦</p><p><button id="ble-retry">Refresh</button></p>`;
    }
    const scanners = this._bleData.scanners || [];
    const devices = this._bleData.devices;
    const updated = this._bleData.last_updated ? new Date(this._bleData.last_updated * 1000).toLocaleTimeString() : "";
    if (scanners.length === 0) {
      let rows = devices.map(d => `
        <tr><td><code>${this._esc(d.address)}</code></td><td>${this._esc(d.name)}</td><td>${d.ibeacon ? this._esc(d.ibeacon.uuid) + " " + d.ibeacon.major + "/" + d.ibeacon.minor : "N/A"}</td><td>N/A</td></tr>
      `).join("");
      return `
        <p><em>Device view: ${devices.length} devices (no scanner info). Auto-refreshingâ€¦</em></p>
        <table><thead><tr><th>MAC / UUID</th><th>Name</th><th>iBeacon</th><th>RSSI</th></tr></thead><tbody>${rows}</tbody></table>
      `;
    }
    let headerCols = `<th>MAC / UUID</th><th>Name</th>`;
    // Add iBeacon column if any device has iBeacon
    const hasIbeacon = devices.some(d => d.ibeacon);
    if (hasIbeacon) headerCols += `<th>iBeacon UUID</th>`;
    scanners.forEach(sc => {
      const label = this._esc(sc.name || sc.source);
      headerCols += `<th>${label}<br><small>${this._esc(sc.source)}</small></th>`;
    });
    let rows = devices.map(dev => {
      let cols = `<td><code>${this._esc(dev.address)}</code></td><td>${this._esc(dev.name)}</td>`;
      if (hasIbeacon) {
        const ib = dev.ibeacon ? `${this._esc(dev.ibeacon.uuid)}<br><small>${dev.ibeacon.major}/${dev.ibeacon.minor}</small>` : "â€”";
        cols += `<td>${ib}</td>`;
      }
      const per = dev.per_scanner || {};
      scanners.forEach(sc => {
        const key = sc.source;
        let val = per[key];
        if (val === undefined) {
          val = per[key.toUpperCase()] || per[key.toLowerCase()];
          if (val === undefined) {
            for (const k of Object.keys(per)) {
              if (k.toLowerCase() === key.toLowerCase()) { val = per[k]; break; }
            }
          }
        }
        if (val !== null && val !== undefined) {
          cols += `<td>${this._esc(String(val))} dBm</td>`;
        } else {
          cols += `<td style="color: var(--secondary-text-color, #999)">N/A</td>`;
        }
      });
      return `<tr>${cols}</tr>`;
    }).join("");

    return `
      <div style="overflow:auto">
        <p><em>Device view: ${devices.length} unique devices, ${scanners.length} scanners. Each column is a scanner (RSSI or N/A). Auto-updates every ${this._esc(String(this._bleData.update_interval || this._settings?.update_interval || 1))}s ${updated ? " â€“ last: " + updated : ""}</em></p>
        <table>
          <thead><tr>${headerCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _renderTargets() {
    if (this._targetsLoading) return `<p class="loading">Loading targetsâ€¦</p>`;
    if (this._targetsError) return `<p class="error">Error: ${this._esc(this._targetsError)}</p><p><button id="targets-retry">Retry</button></p>`;

    let listHtml = "";
    if (!this._targets || this._targets.length === 0) {
      listHtml = `<p>No targets yet. Add a Person or Other target and assign BLE devices.</p>`;
    } else {
      listHtml = `<table><thead><tr><th>Name</th><th>Type</th><th>Icon</th><th>BLE Devices</th><th>GPS Entities</th><th>State</th><th>Actions</th></tr></thead><tbody>`;
      this._targets.forEach(t => {
        const bleList = (t.ble_devices || []).map(a => `<code>${this._esc(a)}</code>`).join(", ") || "<em>none</em>";
        const gpsList = (t.gps_entities || []).map(a => `<code>${this._esc(a)}</code>`).join(", ") || "<em>none</em>";
        const state = this._esc(t.state || "unknown");
        const stateColor = state === "home" ? "var(--success-color, green)" : "var(--error-color, #db4437)";
        listHtml += `<tr>
          <td>${this._esc(t.name)} <small>(${this._esc(t.id.slice(0,8))})</small></td>
          <td>${this._esc(t.type)} </td>
          <td><ha-icon icon="${this._esc(t.icon)}"></ha-icon> <code>${this._esc(t.icon)}</code></td>
          <td>${bleList}</td>
          <td>${gpsList}</td>
          <td style="color:${stateColor}; font-weight:600">${state}</td>
          <td><button data-edit="${this._esc(t.id)}">Edit</button> <button data-delete="${this._esc(t.id)}">Delete</button></td>
        </tr>`;
      });
      listHtml += `</tbody></table>`;
    }

    let formHtml = "";
    if (this._showAddForm) {
      const isEdit = !!this._editingTarget;
      // Available BLE devices for assignment
      let bleOptions = "";
      const available = (this._bleData && (this._bleData.devices || [])) || [];
      const allAddrs = new Set();
      available.forEach(d => allAddrs.add(d.address));
      (this._targetForm.ble_devices || []).forEach(a => allAddrs.add(a));
      if (allAddrs.size === 0) {
        bleOptions = `<p><em>No BLE devices discovered yet. Assign manually or wait for scanner.</em></p>`;
      } else {
        bleOptions = `<div style="max-height:180px; overflow:auto; border:1px solid var(--divider-color, #ccc); padding:8px; border-radius:6px;">`;
        allAddrs.forEach(addr => {
          const upper = String(addr).toUpperCase();
          const checked = this._targetForm.ble_devices.some(a => String(a).toUpperCase() === upper) ? "checked" : "";
          let name = upper;
          const dev = available.find(d => String(d.address).toUpperCase() === upper);
          if (dev && dev.name) name = `${dev.name} (${upper})`;
          bleOptions += `<label style="display:block; margin:4px 0;"><input type="checkbox" data-ble-addr="${this._esc(upper)}" ${checked}> <code>${this._esc(upper)}</code> ${this._esc(name !== upper ? " - " + dev.name : "")}</label>`;
        });
        bleOptions += `</div>`;
        bleOptions += `<p><small>Or add custom MAC/UUID:</small> <input id="ble-custom" placeholder="AA:BB:CC:DD:EE:FF" style="width:200px"> <button id="ble-add-custom">Add</button></p>`;
      }
      // GPS options
      let gpsOptions = "";
      const gpsAvailable = (this._gpsData && (this._gpsData.entities || [])) || [];
      const allGps = new Set();
      gpsAvailable.forEach(e => allGps.add(e.entity_id));
      (this._targetForm.gps_entities || []).forEach(e => allGps.add(e));
      if (allGps.size === 0) {
        gpsOptions = `<p><em>No GPS Device Tracker entities found.</em></p>`;
      } else {
        gpsOptions = `<div style="max-height:180px; overflow:auto; border:1px solid var(--divider-color, #ccc); padding:8px; border-radius:6px;">`;
        allGps.forEach(eid => {
          const checked = this._targetForm.gps_entities.includes(eid) ? "checked" : "";
          const ent = gpsAvailable.find(x => x.entity_id === eid);
          const label = ent ? `${ent.name || ent.entity_id} (${ent.state})` : eid;
          gpsOptions += `<label style="display:block; margin:4px 0;"><input type="checkbox" data-gps-entity="${this._esc(eid)}" ${checked}> <code>${this._esc(eid)}</code> ${this._esc(ent ? " - " + (ent.name || "") + " [" + ent.state + "]" : "")}</label>`;
        });
        gpsOptions += `</div>`;
      }

      formHtml = `
        <div style="border:1px solid var(--divider-color, #ccc); padding:16px; border-radius:8px; margin:12px 0; background: var(--card-background-color, #fafafa);">
          <h3>${isEdit ? "Edit" : "Add"} Target</h3>
          <div class="field"><label>Name</label><input id="target-name" value="${this._esc(this._targetForm.name)}" placeholder="e.g. Alice" /></div>
          <div class="field"><label>Type</label>
            <select id="target-type">
              <option value="Person" ${this._targetForm.type === "Person" ? "selected" : ""}>Person</option>
              <option value="Other" ${this._targetForm.type === "Other" ? "selected" : ""}>Other</option>
            </select>
          </div>
          <div class="field"><label>Icon (mdi:*)</label><input id="target-icon" value="${this._esc(this._targetForm.icon)}" placeholder="mdi:account" /></div>
          <div class="field"><label>BLE Devices (one or many, state Home only if all seen; any Away => away)</label>${bleOptions}</div>
          <div class="field"><label>GPS Entities (Device Tracker from HASS, also Home/Away)</label>${gpsOptions}</div>
          <p><button id="target-save">${isEdit ? "Update" : "Create"}</button> <button id="target-cancel">Cancel</button></p>
        </div>
      `;
    }

    return `
      <div class="card">
        <h2>Targets</h2>
        <p>Track anything with BLE devices. Person/Other are cosmetic (icon). Assign one or many BLE devices; state is <code>home</code> only if all assigned devices are seen, otherwise <code>not_home</code> (any Away => away). Each target creates a Device + Device Tracker entity.</p>
        <p><button id="target-add">Add Target</button> <button id="targets-refresh">Refresh</button></p>
        ${formHtml}
        ${listHtml}
      </div>
    `;
  }

  _esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  _render() {
    // Preserve focus/selection to fix deselection on auto-refresh
    const active = this.shadowRoot ? this.shadowRoot.activeElement : null;
    const activeId = active ? active.id : null;
    const activeTag = active ? active.tagName : null;
    const activeValue = active && (active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA") ? active.value : null;
    const selStart = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
    const selEnd = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;

    const style = `
      :host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
      .container { padding: 16px; max-width: 1100px; margin: 0 auto; }
      .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--divider-color, #e0e0e0); margin-bottom: 16px; flex-wrap: wrap; }
      .tabs button {
        appearance: none; border: none; background: none;
        padding: 12px 20px; font-size: 14px; font-weight: 500;
        cursor: pointer; color: var(--secondary-text-color, #666);
        border-bottom: 2px solid transparent; margin-bottom: -1px;
      }
      .tabs button.active {
        color: var(--primary-color, #03a9f4);
        border-bottom-color: var(--primary-color, #03a9f4);
      }
      .tabs button:hover { background: var(--divider-color, #f5f5f5); }
      .subtabs { display: flex; gap: 4px; margin: 12px 0; border-bottom: 1px solid var(--divider-color, #eee); }
      .subtabs button {
        appearance: none; border: 1px solid var(--divider-color, #e0e0e0); background: var(--card-background-color, #fafafa);
        padding: 8px 14px; font-size: 13px; cursor: pointer; border-radius: 6px 6px 0 0;
      }
      .subtabs button.active { background: var(--primary-color, #03a9f4); color: white; border-color: var(--primary-color, #03a9f4); }
      .tab-content { padding: 16px 0; }
      .card {
        background: var(--card-background-color, white);
        border-radius: 8px; padding: 16px;
        box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,0.1));
        overflow: hidden;
      }
      h1, h2, h3 { margin-top: 0; }
      .version { font-size: 18px; font-weight: 500; }
      .loading { color: var(--secondary-text-color, #666); font-style: italic; }
      .error { color: var(--error-color, #db4437); }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--divider-color, #e0e0e0); white-space: nowrap; }
      th { background: var(--divider-color, #f5f5f5); font-weight: 600; position: sticky; top: 0; }
      code { background: var(--divider-color, #eee); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
      small { font-weight: 400; color: var(--secondary-text-color, #666); }
      .field { margin: 12px 0; }
      .field label { display: block; font-weight: 500; margin-bottom: 6px; }
      .field input, .field select { padding: 8px 10px; font-size: 14px; border: 1px solid var(--divider-color, #ccc); border-radius: 6px; width: 240px; }
      .field button { margin-left: 8px; padding: 8px 14px; }
      ha-icon { --mdc-icon-size: 18px; vertical-align: middle; }
    `;

    const homeContent = `
      <div class="card">
        <h1>This is the spatialHA panel</h1>
        <p>Welcome to spatialHA â€“ Home tab</p>
        <p>Use the tabs above to navigate. All data is loaded via WebSocket through the backend.</p>
      </div>
    `;

    let bleContent = "";
    if (this._activeTab === "ble") {
      let subNav = `
        <div class="subtabs" role="tablist">
          <button role="tab" data-ble-sub="scanner" class="${this._activeBleSubTab === "scanner" ? "active" : ""}">Scanner</button>
          <button role="tab" data-ble-sub="device" class="${this._activeBleSubTab === "device" ? "active" : ""}">Device</button>
        </div>
      `;
      let bleInner = "";
      if (this._activeBleSubTab === "scanner") bleInner = this._renderBleScannerView();
      else bleInner = this._renderBleDeviceView();

      bleContent = `
        <div class="card">
          <h2>BLE</h2>
          <p>Bluetooth devices found by Bluetooth proxies (via backend WebSocket straight to Home Assistant). Auto-updates every Update Interval.</p>
          ${subNav}
          <div>${bleInner}</div>
        </div>
      `;
    }

    let settingsInner = "";
    if (this._settingsLoading) settingsInner = `<p class="loading">Loading settingsâ€¦</p>`;
    else if (this._settingsError) settingsInner = `<p class="error">Error: ${this._esc(this._settingsError)}</p><p><button id="settings-retry">Retry</button></p>`;
    else if (this._settings) {
      settingsInner = `
        <div class="field">
          <label for="interval-input">Update Interval (seconds, default 1)</label>
          <input id="interval-input" type="number" min="0.5" max="3600" step="0.5" value="${this._esc(this._pendingInterval)}" />
          <button id="settings-save" ${this._settingsSaving ? "disabled" : ""}>${this._settingsSaving ? "Savingâ€¦" : "Save"}</button>
        </div>
        <p><small>Backend polls BLE data every Update Interval even without frontend and pushes to BLE tab. Stored in <code>.storage/spatialHA/settings</code> and <code>.storage/spatialHA/ble_data</code>.</small></p>
      `;
    } else {
      settingsInner = `<p class="loading">No settings loaded.</p><p><button id="settings-retry">Retry</button></p>`;
    }
    const settingsContent = `
      <div class="card">
        <h2>Settings</h2>
        ${settingsInner}
      </div>
    `;

    let targetsContent = "";
    if (this._activeTab === "targets") {
      targetsContent = this._renderTargets();
    }

    let aboutInner = "";
    if (this._loadingVersion) {
      aboutInner = `<p class="loading">Loading version via WebSocket...</p>`;
    } else if (this._versionError) {
      aboutInner = `<p class="error">Error loading version: ${this._versionError}</p><p><button id="retry-btn">Retry</button></p>`;
    } else if (this._version !== null) {
      aboutInner = `<p class="version">Current version: ${this._version}</p><p>Version fetched via <code>spatialHA/get_version</code> WebSocket (frontend â†’ backend â†’ Home Assistant).</p>`;
    } else {
      aboutInner = `<p class="loading">No version loaded yet. Waiting for Home Assistant connection...</p>`;
    }
    const aboutContent = `
      <div class="card">
        <h2>About</h2>
        ${aboutInner}
      </div>
    `;

    let mainInner = "";
    if (this._activeTab === "home") mainInner = homeContent;
    else if (this._activeTab === "ble") mainInner = bleContent;
    else if (this._activeTab === "floorplan") mainInner = this._renderFloorplan();
    else if (this._activeTab === "gps") mainInner = this._renderGps();
    else if (this._activeTab === "targets") mainInner = targetsContent;
    else if (this._activeTab === "settings") mainInner = settingsContent;
    else if (this._activeTab === "about") mainInner = aboutContent;

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <div class="container">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${this._activeTab === "home"}" data-tab="home" class="${this._activeTab === "home" ? "active" : ""}">Home</button>
          <button role="tab" aria-selected="${this._activeTab === "ble"}" data-tab="ble" class="${this._activeTab === "ble" ? "active" : ""}">BLE</button>
          <button role="tab" aria-selected="${this._activeTab === "floorplan"}" data-tab="floorplan" class="${this._activeTab === "floorplan" ? "active" : ""}">Floor Plan</button>
          <button role="tab" aria-selected="${this._activeTab === "gps"}" data-tab="gps" class="${this._activeTab === "gps" ? "active" : ""}">GPS</button>
          <button role="tab" aria-selected="${this._activeTab === "targets"}" data-tab="targets" class="${this._activeTab === "targets" ? "active" : ""}">Targets</button>
          <button role="tab" aria-selected="${this._activeTab === "settings"}" data-tab="settings" class="${this._activeTab === "settings" ? "active" : ""}">Settings</button>
          <button role="tab" aria-selected="${this._activeTab === "about"}" data-tab="about" class="${this._activeTab === "about" ? "active" : ""}">About</button>
        </div>
        <div class="tab-content">
          ${mainInner}
        </div>
      </div>
    `;

    this.shadowRoot.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
    });
    this.shadowRoot.querySelectorAll("[data-ble-sub]").forEach((btn) => {
      btn.addEventListener("click", () => this._switchBleSubTab(btn.dataset.bleSub));
    });
    const retryBtn = this.shadowRoot.getElementById("retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        this._hasFetchedVersion = false;
        this._version = null;
        this._versionError = null;
        this._fetchVersion();
      });
    }
    const bleRetry = this.shadowRoot.getElementById("ble-retry");
    if (bleRetry) {
      bleRetry.addEventListener("click", () => {
        if (this._bleUnsub) { try { this._bleUnsub(); } catch(e){} this._bleUnsub = null; }
        this._bleData = null;
        this._bleError = null;
        this._ensureBleSubscription();
      });
    }
    const settingsRetry = this.shadowRoot.getElementById("settings-retry");
    if (settingsRetry) {
      settingsRetry.addEventListener("click", () => this._fetchSettings());
    }
    const saveBtn = this.shadowRoot.getElementById("settings-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => this._saveSettings());
    }
    const intervalInput = this.shadowRoot.getElementById("interval-input");
    if (intervalInput) {
      intervalInput.addEventListener("input", (e) => { this._pendingInterval = e.target.value; });
      intervalInput.addEventListener("change", (e) => { this._pendingInterval = e.target.value; });
    }
    // Targets
    const addBtn = this.shadowRoot.getElementById("target-add");
    if (addBtn) addBtn.addEventListener("click", () => this._startAdd());
    const refreshBtn = this.shadowRoot.getElementById("targets-refresh");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this._fetchTargetsOnce());
    const cancelBtn = this.shadowRoot.getElementById("target-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", () => this._cancelForm());
    const saveTargetBtn = this.shadowRoot.getElementById("target-save");
    if (saveTargetBtn) {
      saveTargetBtn.addEventListener("click", () => {
        if (this._editingTarget) this._updateTarget();
        else this._createTarget();
      });
    }
    this.shadowRoot.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-edit");
        const t = this._targets.find(x => x.id === id);
        if (t) this._startEdit(t);
      });
    });
    this.shadowRoot.querySelectorAll("[data-delete]").forEach(btn => {
      btn.addEventListener("click", () => this._deleteTarget(btn.getAttribute("data-delete")));
    });
    this.shadowRoot.querySelectorAll("[data-ble-addr]").forEach(cb => {
      cb.addEventListener("change", () => {
        const addr = cb.getAttribute("data-ble-addr");
        this._toggleBleDevice(addr);
      });
    });
    const customInput = this.shadowRoot.getElementById("ble-custom");
    const customBtn = this.shadowRoot.getElementById("ble-add-custom");
    if (customBtn && customInput) {
      customBtn.addEventListener("click", () => {
        const val = customInput.value.trim().toUpperCase();
        if (!val) return;
        if (!this._targetForm.ble_devices.includes(val)) this._targetForm.ble_devices.push(val);
        customInput.value = "";
        this._render();
      });
    }
    const nameInput = this.shadowRoot.getElementById("target-name");
    if (nameInput) nameInput.addEventListener("input", e => { this._targetForm.name = e.target.value; });
    const typeSelect = this.shadowRoot.getElementById("target-type");
    if (typeSelect) typeSelect.addEventListener("change", e => {
      this._targetForm.type = e.target.value;
      if (!this._editingTarget) {
        this._targetForm.icon = e.target.value === "Person" ? "mdi:account" : "mdi:help-circle";
        this._render();
      } else {
        this._targetForm.type = e.target.value;
      }
    });
    const iconInput = this.shadowRoot.getElementById("target-icon");
    if (iconInput) iconInput.addEventListener("input", e => { this._targetForm.icon = e.target.value; });
    // GPS checkboxes in Targets form
    this.shadowRoot.querySelectorAll("[data-gps-entity]").forEach(cb => {
      cb.addEventListener("change", () => {
        const eid = cb.getAttribute("data-gps-entity");
        this._toggleGpsEntity(eid);
      });
    });
    // GPS tab buttons
    const gpsRetry = this.shadowRoot.getElementById("gps-retry");
    if (gpsRetry) gpsRetry.addEventListener("click", () => { if (this._gpsUnsub) { try { this._gpsUnsub(); } catch(e){} this._gpsUnsub=null; } this._gpsData=null; this._ensureGpsSubscription(); });
    const gpsRefresh = this.shadowRoot.getElementById("gps-refresh");
    if (gpsRefresh) gpsRefresh.addEventListener("click", () => { this._fetchGpsOnce(); });
    // Floorplan bindings
    const fpCanvas = this.shadowRoot.getElementById("floorplan-canvas");
    if (fpCanvas) {
      fpCanvas.oncontextmenu = (e) => { e.preventDefault(); this._handleFloorplanClick({ clientX: e.clientX, clientY: e.clientY, button: 2 }); };
      fpCanvas.onclick = (e) => { if (e.button !== 2) this._handleFloorplanClick({ clientX: e.clientX, clientY: e.clientY, button: 0 }); };
      fpCanvas.ondblclick = (e) => this._handleFloorplanDblClick(e);
      fpCanvas.onmousedown = (e) => this._handleFloorplanMouseDown(e);
      fpCanvas.onmousemove = (e) => this._handleFloorplanMouseMove(e);
      fpCanvas.onmouseup = (e) => this._handleFloorplanMouseUp(e);
      fpCanvas.onwheel = (e) => this._handleFloorplanWheel(e);
      fpCanvas.tabIndex = 0;
      fpCanvas.onkeydown = (e) => this._handleFloorplanKeyDown(e);
      // Draw after DOM ready
      setTimeout(() => this._renderFloorplanCanvas(), 0);
    }
    // Global keys for floorplan when tab active (undo/redo/copy/paste)
    if (this._activeTab === "floorplan" && !this._fpKeyBound) {
      this._fpKeyBound = true;
      // Bind once on shadow root
      this.shadowRoot.onkeydown = (e) => this._handleFloorplanKeyDown(e);
    }
    const fpRetry = this.shadowRoot.getElementById("floorplan-retry");
    if (fpRetry) fpRetry.addEventListener("click", () => { this._floorplanError = null; this._fetchFloorplanOnce(); });
    const unitsSel = this.shadowRoot.getElementById("floorplan-units");
    if (unitsSel) unitsSel.addEventListener("change", (e) => { this._floorplanUnits = e.target.value; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas(); });
    this.shadowRoot.querySelectorAll("[data-floor]").forEach((b) => b.addEventListener("click", () => { this._selectedFloorId = b.getAttribute("data-floor"); this._selectedPointId = null; this._selectedWallId = null; this._contextMenu = null; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas(); }));
    const floorAdd = this.shadowRoot.getElementById("floor-add");
    if (floorAdd) floorAdd.addEventListener("click", () => {
      const name = prompt("Floor name?", "Floor " + (this._floorplan.floors.length + 1));
      if (!name) return;
      const lvlStr = prompt("Level (integer)?", String(this._floorplan.floors.length));
      const lvl = parseInt(lvlStr || "0", 10) || 0;
      this._fpPushUndo();
      const nid = "floor_" + Date.now();
      this._floorplan.floors.push({ id: nid, name: name, level: lvl, offset_x: 0, offset_y: 0, scale: 1, rotation: 0, points: [{ id: "point_" + Date.now(), x: 0, y: 0, label: "" }], walls: [], rooms: [] });
      this._selectedFloorId = nid; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const floorRename = this.shadowRoot.getElementById("floor-rename");
    if (floorRename) floorRename.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const name = prompt("Rename floor?", f.name); if (!name) return; this._fpPushUndo(); f.name = name; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const floorDel = this.shadowRoot.getElementById("floor-delete");
    if (floorDel) floorDel.addEventListener("click", () => {
      if (this._floorplan.floors.length <= 1) { alert("Cannot delete last floor"); return; }
      if (!confirm("Delete floor?")) return;
      this._fpPushUndo();
      this._floorplan.floors = this._floorplan.floors.filter((f) => f.id !== this._selectedFloorId);
      this._selectedFloorId = this._floorplan.floors[0].id; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const floorLvl = this.shadowRoot.getElementById("floor-level");
    if (floorLvl) floorLvl.addEventListener("change", (e) => { const f = this._getActiveFloor(); if (!f) return; this._fpPushUndo(); f.level = parseInt(e.target.value, 10) || 0; this._saveFloorplan(); this._render(); });
    const wallAdd = this.shadowRoot.getElementById("wall-add");
    if (wallAdd) wallAdd.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      if (!this._selectedPointId) { alert("Select a point first"); return; }
      const others = f.points.filter((pp) => pp.id !== this._selectedPointId);
      if (!others.length) { alert("Need 2 points"); return; }
      const last = others[others.length - 1];
      this._fpPushUndo();
      f.walls.push({ id: "wall_" + Date.now(), p1: this._selectedPointId, p2: last.id });
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    this.shadowRoot.querySelectorAll("[data-del-wall]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      f.walls = f.walls.filter((w) => w.id !== b.getAttribute("data-del-wall"));
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));
    const roomAdd = this.shadowRoot.getElementById("room-add");
    if (roomAdd) roomAdd.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      if (f.points.length < 3) { alert("Need 3+ points"); return; }
      const name = prompt("Room name?", "Room " + ((f.rooms || []).length + 1)); if (!name) return;
      this._fpPushUndo();
      f.rooms.push({ id: "room_" + Date.now(), name: name, point_ids: f.points.map((pp) => pp.id), color: "#6496ff" });
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    this.shadowRoot.querySelectorAll("[data-del-room]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      f.rooms = (f.rooms || []).filter((r) => r.id !== b.getAttribute("data-del-room"));
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));
    this.shadowRoot.querySelectorAll("[data-room-color]").forEach((inp) => inp.addEventListener("change", (e) => {
      const f = this._getActiveFloor(); if (!f) return;
      const r = (f.rooms || []).find((rr) => rr.id === e.target.getAttribute("data-room-color"));
      if (r) { r.color = e.target.value; this._saveFloorplan(); this._renderFloorplanCanvas(); }
    }));
    const alignSave = this.shadowRoot.getElementById("align-save");
    if (alignSave) alignSave.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      const ax = this.shadowRoot.getElementById("align-x"), ay = this.shadowRoot.getElementById("align-y"), sc = this.shadowRoot.getElementById("align-scale"), rt = this.shadowRoot.getElementById("align-rot");
      if (ax) f.offset_x = parseFloat(ax.value) || 0;
      if (ay) f.offset_y = parseFloat(ay.value) || 0;
      if (sc) f.scale = parseFloat(sc.value) || 1;
      if (rt) f.rotation = (parseFloat(rt.value) || 0) * Math.PI / 180;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const pointAdd = this.shadowRoot.getElementById("point-add");
    if (pointAdd) pointAdd.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      const nid = "point_" + Date.now();
      f.points.push({ id: nid, x: 0, y: 0, label: "" });
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    this.shadowRoot.querySelectorAll("[data-del-point]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      const pid = b.getAttribute("data-del-point");
      f.points = f.points.filter((pp) => pp.id !== pid);
      f.walls = (f.walls || []).filter((w) => w.p1 !== pid && w.p2 !== pid);
      (f.rooms || []).forEach((r) => { r.point_ids = (r.point_ids || []).filter((id) => id !== pid); });
      if (this._selectedPointId === pid) this._selectedPointId = null;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));

    // Restore focus/selection (fix deselection on auto-refresh)
    if (activeId) {
      const el = this.shadowRoot.getElementById(activeId);
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) {
        try {
          el.focus();
          if (activeValue !== null && el.value !== activeValue) el.value = activeValue;
          if (selStart !== null && typeof el.setSelectionRange === "function") {
            try { el.setSelectionRange(selStart, selEnd); } catch(e){}
          }
        } catch(e){}
      }
    } else if (active && activeTag === "INPUT" && activeValue !== null) {
      // Fallback for inputs without id (should not happen, but try)
      const inputs = this.shadowRoot.querySelectorAll("input");
      for (const inp of inputs) {
        if (inp.placeholder === active.getAttribute("placeholder") || inp.value === activeValue) {
          try { inp.focus(); if (selStart !== null) inp.setSelectionRange(selStart, selEnd); } catch(e){}
          break;
        }
      }
    }
  }

}

if (!customElements.get("spatialHA-panel")) {
  customElements.define("spatialHA-panel", SpatialHAPanel);
}
} // close outer guard if (!customElements.get("spatialHA-panel"))
