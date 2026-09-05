/**
 * spatialHA Panel - WebSocket architecture with BLE + Settings + Targets
 * Frontend NEVER queries directly. All data goes via backend WebSocket
 * through Home Assistant: hass.callWS / hass.connection.subscribeMessage -> backend -> HA
 */
if (!customElements.get("spatialHA-panel")) {
const SPATIALHA_MOD_VERSION = "0.9.1.8";
function spatialHAModUrl(name) {
  return "/api/panels/spatialHA/modules/" + name + ".js?v=" + SPATIALHA_MOD_VERSION;
}
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
    this._bleFilter = "";
    this._showPositions = true;
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
    this._gpsFilter = "";
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
    this._selectedDoorId = null;
    this._placingDoorType = null;
    this._selectedWindowId = null;
    this._placingWindow = false;
    this._selectedReceiverId = null;
    this._placingReceiver = false;
    this._selectedScannerId = null;
    this._placingScanner = false;
    this._placingScannerSource = "";
    this._placingScannerName = "";
    // Floorplan 3D preview state
    this._fpMode = "2d";
    this._fpView = "iso";
    this._fpYawOff = 0;
    this._fpPitchOff = 0;
    this._fpZoom = 1;
    this._fpRotating = false;
    this._contextMenu = null; // {x,y,pointId}
    this._dragging = null;
    this._floorplanScale = 40; // px per meter
    this._floorplanOffset = {x: 400, y: 300};
    this._floorplanPanning = false;
    this._floorplanPanStart = null;
    this._homePanX = 0;
    this._homePanY = 0;
    this._fpPanX = 0;
    this._fpPanY = 0;
    this._fpSnapOn = true;
    this._fpSnapStep = "0.1";
    // Home 3D view state
    this._homeView = "iso";
    this._homeYawOff = 0;
    this._homePitchOff = 0;
    this._homeZoom = 1;
    this._homeRotating = false;
    // Feature module loader state
    this._modsReady = false;
    this._modsPromise = null;
  }

  async _ensureMods() {
    if (this._modsReady) return;
    if (!this._modsPromise) {
      this._modsPromise = (async () => {
        const defs = [
          ["utils", "UtilsMixin"],
          ["ble", "BleMixin"],
          ["gps", "GpsMixin"],
          ["settings", "SettingsMixin"],
          ["targets", "TargetsMixin"],
          ["fp-data", "FloorplanDataMixin"],
          ["fp-canvas", "FloorplanCanvasMixin"],
          ["fp-ui", "FloorplanUiMixin"],
          ["home3d", "Home3DMixin"],
        ];
        const mods = await Promise.all(defs.map(([n]) => import(spatialHAModUrl(n))));
        const proto = Object.getPrototypeOf(this);
        mods.forEach((m, i) => {
          const mix = m[defs[i][1]];
          if (mix) Object.assign(proto, mix);
        });
        this._modsReady = true;
      })().catch((err) => {
        this._modsPromise = null;
        console.error("spatialHA modules failed to load", err);
        throw err;
      });
    }
    try { await this._modsPromise; } catch (e) { /* render shows retry */ }
  }

  _dispatchTab(tab) {
    if (!this._hass || !this._modsReady) return;
    if (tab === "about" && !this._hasFetchedVersion && !this._loadingVersion) this._fetchVersion();
    if (tab === "settings" && !this._settings && !this._settingsLoading) this._fetchSettings();
    if (tab === "ble" && !this._bleUnsub) this._ensureBleSubscription();
    if (tab === "targets" && !this._targetsUnsub) this._ensureTargetsSubscription();
    if (tab === "gps" && !this._gpsUnsub) this._ensureGpsSubscription();
    if (tab === "floorplan" && !this._floorplanUnsub) this._ensureFloorplanSubscription();
    if (tab === "floorplan" && !this._bleData && !this._bleLoading) this._fetchBleOnce();
    if (tab === "home") {
      if (!this._floorplan && !this._floorplanLoading && !this._floorplanUnsub) this._ensureFloorplanSubscription();
      else this._renderHomeIsoCanvas();
    }
  }

  set hass(hass) {
    this._hass = hass;
    this._ensureMods().then(() => {
      if (!this._hass) return;
      this._dispatchTab(this._activeTab);
    });
  }

  connectedCallback() {
    this._render();
    this._ensureMods().then(() => {
      this._render();
      this._dispatchTab(this._activeTab);
    });
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
    this._ensureMods().then(() => this._dispatchTab(tab));
  }

  _switchBleSubTab(sub) {
    this._activeBleSubTab = sub;
    this._render();
  }

  _esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  _viewOrLoading(fnName) {
    if (typeof this[fnName] === "function") {
      const args = Array.prototype.slice.call(arguments, 1);
      return this[fnName].apply(this, args);
    }
    return `<p class="loading">Loading…</p>`;
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







  // ---- Floorplan ----
  // Home 3D view lives in modules/home3d.js (loaded via _ensureMods).
  _renderHomeIsoCanvas() {
    if (typeof this._renderHome3D === "function") this._renderHome3D();
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

    const _hv = this._homeView || "iso";
    const _hvb = (id, label) => `<button data-home-view="${id}" style="padding:6px 12px; margin:2px; border:1px solid #444; border-radius:4px; background:${_hv === id ? "#03a9f4" : "#1e2228"}; color:${_hv === id ? "white" : "#cfd6df"}; cursor:pointer;">${label}</button>`;
    const homeContent = `
      <div class="card">
        <h1>This is the spatialHA panel</h1>
      </div>
      <div class="card" style="margin-top:12px;">
        <h2>Floors</h2>
        <div style="display:flex; gap:4px; margin:8px 0; flex-wrap:wrap;">
          ${_hvb("iso", "Isometric")}${_hvb("top", "Top Down")}${_hvb("front", "Front")}${_hvb("back", "Back")}${_hvb("left", "Left Side")}${_hvb("right", "Right Side")}
        </div>
        <div style="border:1px solid #333; border-radius:8px; overflow:hidden; background:#14161a;">
          <canvas id="home-iso-canvas" width="800" height="420" style="display:block; width:100%; height:420px; background:#14161a; cursor:grab;"></canvas>
        </div>
        <p><small>Drag to rotate. Scroll to zoom. Keys: WASD move, QE or +/- zoom, arrows look.</small></p>
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
      if (this._activeBleSubTab === "scanner") bleInner = this._viewOrLoading("_renderBleScannerView");
      else bleInner = this._viewOrLoading("_renderBleDeviceView");

      bleContent = `
        <div class="card">
          <h2>BLE</h2>
          <p>Bluetooth devices found by Bluetooth proxies.</p>
          ${subNav}
          <div>${bleInner}</div>
        </div>
      `;
    }

    let settingsInner = "";
    if (this._settingsLoading) settingsInner = `<p class="loading">Loading settings…</p>`;
    else if (this._settingsError) settingsInner = `<p class="error">Error: ${this._esc(this._settingsError)}</p><p><button id="settings-retry">Retry</button></p>`;
    else if (this._settings) {
      settingsInner = `
        <div class="field">
          <label for="interval-input">Update Interval (seconds, default 1)</label>
          <input id="interval-input" type="number" min="0.5" max="3600" step="0.5" value="${this._esc(this._pendingInterval)}" />
          <button id="settings-save" ${this._settingsSaving ? "disabled" : ""}>${this._settingsSaving ? "Saving…" : "Save"}</button>
        </div>
        <p><small>Applies to background updates.</small></p>
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
      targetsContent = this._viewOrLoading("_renderTargets");
    }

    let aboutInner = "";
    if (this._loadingVersion) {
      aboutInner = `<p class="loading">Loading version via WebSocket...</p>`;
    } else if (this._versionError) {
      aboutInner = `<p class="error">Error loading version: ${this._versionError}</p><p><button id="retry-btn">Retry</button></p>`;
    } else if (this._version !== null) {
      aboutInner = `<p class="version">Version ${this._version}</p>`;
    } else {
      aboutInner = `<p class="loading">Loading…</p>`;
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
    else if (this._activeTab === "floorplan") mainInner = this._viewOrLoading("_renderFloorplan");
    else if (this._activeTab === "gps") mainInner = this._viewOrLoading("_renderGps");
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
    const bleFilter = this.shadowRoot.getElementById("ble-filter");
    if (bleFilter) {
      bleFilter.addEventListener("input", (e) => { this._bleFilter = e.target.value; this._render(); });
      bleFilter.addEventListener("search", (e) => { this._bleFilter = e.target.value; this._render(); });
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
      intervalInput.addEventListener("keydown", (e) => { if (e.key === "Enter") this._saveSettings(); });
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
    const gpsFilter = this.shadowRoot.getElementById("gps-filter");
    if (gpsFilter) {
      gpsFilter.addEventListener("input", (e) => { this._gpsFilter = e.target.value; this._render(); });
      gpsFilter.addEventListener("search", (e) => { this._gpsFilter = e.target.value; this._render(); });
    }
    // Floorplan bindings
    const fpCanvas = this.shadowRoot.getElementById("floorplan-canvas");
    if (fpCanvas) {
      fpCanvas.oncontextmenu = (e) => {
        e.preventDefault();
        if (this._suppressContextMenu) { this._suppressContextMenu = false; return; }
        this._handleFloorplanClick({ clientX: e.clientX, clientY: e.clientY, button: 2 });
      };
      fpCanvas.onauxclick = (e) => { if (e.button === 1) e.preventDefault(); };
      fpCanvas.onclick = (e) => { if (e.button !== 2) this._handleFloorplanClick({ clientX: e.clientX, clientY: e.clientY, button: 0 }); };
      fpCanvas.ondblclick = (e) => this._handleFloorplanDblClick(e);
      fpCanvas.onmousedown = (e) => this._handleFloorplanMouseDown(e);
      fpCanvas.onmousemove = (e) => this._handleFloorplanMouseMove(e);
      fpCanvas.onmouseup = (e) => this._handleFloorplanMouseUp(e);
      fpCanvas.addEventListener("wheel", (e) => this._handleFloorplanWheel(e), { passive: false });
      fpCanvas.tabIndex = 0;
      fpCanvas.onkeydown = (e) => this._handleFloorplanKeyDown(e);
      // Draw after DOM ready
      setTimeout(() => this._renderFloorplanCanvas(), 0);
    }
    // Global keys for floorplan + home camera (bound once; handler routes by tab)
    if (!this._fpKeyBound) {
      this._fpKeyBound = true;
      // Bind once on shadow root
      this.shadowRoot.onkeydown = (e) => this._handleFloorplanKeyDown(e);
    }
    this.shadowRoot.querySelectorAll("[data-fp-mode]").forEach((b) => b.addEventListener("click", () => {
      this._fpMode = b.getAttribute("data-fp-mode");
      this._render();
      setTimeout(() => {
        if (typeof this._renderFloorPreview3D === "function") this._renderFloorPreview3D();
        else this._renderFloorplanCanvas();
      }, 0);
    }));
    const posToggle = this.shadowRoot.getElementById("fp-positions");
    if (posToggle) posToggle.addEventListener("change", (e) => {
      this._showPositions = e.target.checked;
      this._fpRedraw();
      if (typeof this._renderHomeIsoCanvas === "function") this._renderHomeIsoCanvas();
    });
    this.shadowRoot.querySelectorAll("[data-fp-view]").forEach((b) => b.addEventListener("click", () => {
      if (typeof this._fpSetView === "function") this._fpSetView(b.getAttribute("data-fp-view"));
      else { this._fpView = b.getAttribute("data-fp-view"); this._render(); }
    }));
    const fp3d = this.shadowRoot.getElementById("floorplan-3d-canvas");
    if (fp3d) {
      setTimeout(() => { if (typeof this._renderFloorPreview3D === "function") this._renderFloorPreview3D(); }, 0);
      // 3D view changes via buttons only; canvas edits like the 2D view.
      fp3d.oncontextmenu = (e) => {
        e.preventDefault();
        if (this._suppressContextMenu) { this._suppressContextMenu = false; return; }
        this._handleFloorplanClick({ clientX: e.clientX, clientY: e.clientY, button: 2 });
      };
      fp3d.onauxclick = (e) => { if (e.button === 1) e.preventDefault(); };
      fp3d.onclick = (e) => { if (e.button !== 2) this._handleFloorplanClick({ clientX: e.clientX, clientY: e.clientY, button: 0 }); };
      fp3d.ondblclick = (e) => this._handleFloorplanDblClick(e);
      fp3d.onmousedown = (e) => this._handleFloorplanMouseDown(e);
      fp3d.onmousemove = (e) => this._handleFloorplanMouseMove(e);
      fp3d.onmouseup = (e) => this._handleFloorplanMouseUp(e);
      fp3d.tabIndex = 0;
      fp3d.onkeydown = (e) => this._handleFloorplanKeyDown(e);
    }
    const fpRetry = this.shadowRoot.getElementById("floorplan-retry");
    if (fpRetry) fpRetry.addEventListener("click", () => { this._floorplanError = null; this._fetchFloorplanOnce(); });
    const unitsSel = this.shadowRoot.getElementById("floorplan-units");
    if (unitsSel) unitsSel.addEventListener("change", (e) => { this._floorplanUnits = e.target.value; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas(); });
    this.shadowRoot.querySelectorAll("[data-floor]").forEach((b) => b.addEventListener("click", () => { this._selectedFloorId = b.getAttribute("data-floor"); this._selectedPointId = null; this._selectedWallId = null; this._contextMenu = null; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas(); }));
    if (this.shadowRoot.getElementById("home-iso-canvas")) {
      setTimeout(() => this._renderHomeIsoCanvas(), 0);
      const hc = this.shadowRoot.getElementById("home-iso-canvas");
      hc.onmousedown = (e) => {
        if (e.button !== 0) return;
        this._homeRotating = true;
        this._homeRotStart = { x: e.clientX, y: e.clientY, yaw: this._homeYawOff || 0, pitch: this._homePitchOff || 0 };
        hc.style.cursor = "grabbing";
        e.preventDefault();
      };
      hc.onmousemove = (e) => {
        if (!this._homeRotating || !this._homeRotStart) return;
        this._homeYawOff = this._homeRotStart.yaw - (e.clientX - this._homeRotStart.x) * 0.4;
        this._homePitchOff = Math.max(-60, Math.min(60, this._homeRotStart.pitch + (e.clientY - this._homeRotStart.y) * 0.3));
        if (typeof this._requestDraw === "function") this._requestDraw("home3d", () => this._renderHomeIsoCanvas());
        else this._renderHomeIsoCanvas();
      };
      hc.onmouseup = () => { this._homeRotating = false; hc.style.cursor = "grab"; };
      hc.onmouseleave = () => { this._homeRotating = false; hc.style.cursor = "grab"; };
      hc.addEventListener("wheel", (e) => {
        e.preventDefault();
        this._homeZoom = Math.max(0.4, Math.min(3, (this._homeZoom || 1) * (e.deltaY > 0 ? 0.92 : 1.08)));
        if (typeof this._requestDraw === "function") this._requestDraw("home3d", () => this._renderHomeIsoCanvas());
        else this._renderHomeIsoCanvas();
      }, { passive: false });
    }
    this.shadowRoot.querySelectorAll("[data-home-view]").forEach((b) => b.addEventListener("click", () => {
      if (typeof this._homeSetView === "function") this._homeSetView(b.getAttribute("data-home-view"));
      else { this._homeView = b.getAttribute("data-home-view"); this._render(); }
    }));
    const floorAdd = this.shadowRoot.getElementById("floor-add");
    if (floorAdd) floorAdd.addEventListener("click", () => {
      const name = prompt("Floor name?", "Floor " + (this._floorplan.floors.length + 1));
      if (!name) return;
      const lvlStr = prompt("Level (integer)?", String(this._floorplan.floors.length));
      const lvl = parseInt(lvlStr || "0", 10) || 0;
      this._fpPushUndo();
      const nid = "floor_" + Date.now();
      this._floorplan.floors.push({ id: nid, name: name, level: lvl, offset_x: 0, offset_y: 0, scale: 1, rotation: 0, width: 10, depth: 8, height: 3, points: [{ id: "point_" + Date.now(), x: 0, y: 0, label: "" }], walls: [], rooms: [] });
      this._selectedFloorId = nid; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const floorRename = this.shadowRoot.getElementById("floor-rename");
    if (floorRename) floorRename.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const name = prompt("Rename floor?", f.name); if (!name) return; this._fpPushUndo(); f.name = name; this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const floorDel = this.shadowRoot.getElementById("floor-delete");
    if (floorDel) floorDel.addEventListener("click", () => {
      if (!this._floorplan.floors.length) return;
      if (!confirm("Delete floor?")) return;
      this._fpPushUndo();
      this._floorplan.floors = this._floorplan.floors.filter((f) => f.id !== this._selectedFloorId);
      this._selectedFloorId = this._floorplan.floors.length ? this._floorplan.floors[0].id : null;
      this._selectedPointId = null; this._selectedWallId = null; this._selectedDoorId = null;
      this._selectedWindowId = null; this._contextMenu = null;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
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
    const doorBtn = (id, type) => {
      const b = this.shadowRoot.getElementById(id);
      if (b) b.addEventListener("click", () => {
        if (this._placingDoorType === type) this._placingDoorType = null;
        else { this._placingDoorType = type; this._selectedDoorId = null; this._placingWindow = false; this._placingReceiver = false; }
        this._render(); this._renderFloorplanCanvas();
      });
    };
    doorBtn("door-add-Door", "Door");
    doorBtn("door-add-Double", "Double Door");
    doorBtn("door-add-Garage", "Garage Door");
    const doorCancel = this.shadowRoot.getElementById("door-cancel-place");
    if (doorCancel) doorCancel.addEventListener("click", () => { this._placingDoorType = null; this._render(); this._renderFloorplanCanvas(); });
    this.shadowRoot.querySelectorAll("[data-del-door]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      f.doors = (f.doors || []).filter((d) => d.id !== b.getAttribute("data-del-door"));
      if (this._selectedDoorId === b.getAttribute("data-del-door")) this._selectedDoorId = null;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));
    const doorSave = this.shadowRoot.getElementById("door-save");
    if (doorSave) doorSave.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const d = (f.doors || []).find((dd) => dd.id === this._selectedDoorId);
      if (!d) return;
      this._fpPushUndo();
      const dx = this.shadowRoot.getElementById("door-x"), dy = this.shadowRoot.getElementById("door-y");
      const dr = this.shadowRoot.getElementById("door-rot"), dw = this.shadowRoot.getElementById("door-width");
      const sw = this.shadowRoot.getElementById("door-swing");
      if (dx) { const v = this._parseDisplayToMeters(dx.value); if (!isNaN(v)) { const cl = this._clampToFloor(f, v, d.y); d.x = cl.x; } }
      if (dy) { const v = this._parseDisplayToMeters(dy.value); if (!isNaN(v)) { const cl = this._clampToFloor(f, d.x, v); d.y = cl.y; } }
      if (dr) { const v = parseFloat(dr.value); if (!isNaN(v)) d.rotation = ((v % 360) + 360) % 360; }
      if (dw) { const v = this._parseDisplayToMeters(dw.value); if (!isNaN(v) && v >= 0.2) d.width = v; }
      if (sw && ["left", "right", "up", "none"].includes(sw.value)) d.swing = sw.value;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const rotL = this.shadowRoot.getElementById("door-rot-left");
    if (rotL) rotL.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const d = (f.doors || []).find((dd) => dd.id === this._selectedDoorId);
      if (!d) return;
      this._fpPushUndo();
      d.rotation = (((parseFloat(d.rotation) || 0) - 15) % 360 + 360) % 360;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const rotR = this.shadowRoot.getElementById("door-rot-right");
    if (rotR) rotR.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const d = (f.doors || []).find((dd) => dd.id === this._selectedDoorId);
      if (!d) return;
      this._fpPushUndo();
      d.rotation = (((parseFloat(d.rotation) || 0) + 15) % 360 + 360) % 360;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const defsSave = this.shadowRoot.getElementById("door-defs-save");
    if (defsSave) defsSave.addEventListener("click", () => {
      if (!this._floorplan) return;
      this._fpPushUndo();
      this._floorplan.door_defaults = this._floorplan.door_defaults || {};
      const d1 = this.shadowRoot.getElementById("def-door"), d2 = this.shadowRoot.getElementById("def-double"), d3 = this.shadowRoot.getElementById("def-garage");
      if (d1) { const v = this._parseDisplayToMeters(d1.value); if (!isNaN(v) && v >= 0.2) this._floorplan.door_defaults["Door"] = v; }
      if (d2) { const v = this._parseDisplayToMeters(d2.value); if (!isNaN(v) && v >= 0.2) this._floorplan.door_defaults["Double Door"] = v; }
      if (d3) { const v = this._parseDisplayToMeters(d3.value); if (!isNaN(v) && v >= 0.2) this._floorplan.door_defaults["Garage Door"] = v; }
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const winAdd = this.shadowRoot.getElementById("window-add");
    if (winAdd) winAdd.addEventListener("click", () => {
      if (this._placingWindow) this._placingWindow = false;
      else { this._placingWindow = true; this._placingDoorType = null; this._placingReceiver = false; this._selectedWindowId = null; }
      this._render(); this._renderFloorplanCanvas();
    });
    const winCancel = this.shadowRoot.getElementById("window-cancel-place");
    if (winCancel) winCancel.addEventListener("click", () => { this._placingWindow = false; this._render(); this._renderFloorplanCanvas(); });
    const rxAdd = this.shadowRoot.getElementById("receiver-add");
    if (rxAdd) rxAdd.addEventListener("click", () => {
      if (this._placingReceiver) this._placingReceiver = false;
      else { this._placingReceiver = true; this._placingDoorType = null; this._placingWindow = false; this._selectedReceiverId = null; }
      this._render(); this._renderFloorplanCanvas();
    });
    const rxCancel = this.shadowRoot.getElementById("receiver-cancel-place");
    if (rxCancel) rxCancel.addEventListener("click", () => { this._placingReceiver = false; this._render(); this._renderFloorplanCanvas(); });
    this.shadowRoot.querySelectorAll("[data-del-receiver]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      f.receivers = (f.receivers || []).filter((r) => r.id !== b.getAttribute("data-del-receiver"));
      if (this._selectedReceiverId === b.getAttribute("data-del-receiver")) this._selectedReceiverId = null;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));
    const scAdd = this.shadowRoot.getElementById("scanner-add");
    if (scAdd) scAdd.addEventListener("click", () => {
      if (this._placingScanner) { this._placingScanner = false; this._render(); this._renderFloorplanCanvas(); return; }
      const sel = this.shadowRoot.getElementById("scanner-source");
      const custom = this.shadowRoot.getElementById("scanner-custom");
      const src = (custom && custom.value.trim()) || (sel ? sel.value : "");
      if (!src) { alert("Pick a discovered scanner or enter a custom source first."); return; }
      let nm = src;
      const opt = sel ? sel.selectedOptions[0] : null;
      if (opt && !custom.value.trim()) nm = opt.textContent.split(" (")[0] || src;
      this._placingScanner = true;
      this._placingScannerSource = src;
      this._placingScannerName = nm;
      this._placingDoorType = null; this._placingWindow = false; this._placingReceiver = false;
      this._selectedScannerId = null;
      this._render(); this._renderFloorplanCanvas();
    });
    const scCancel = this.shadowRoot.getElementById("scanner-cancel-place");
    if (scCancel) scCancel.addEventListener("click", () => { this._placingScanner = false; this._render(); this._renderFloorplanCanvas(); });
    this.shadowRoot.querySelectorAll("[data-del-scanner]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      f.scanners = (f.scanners || []).filter((s) => s.id !== b.getAttribute("data-del-scanner"));
      if (this._selectedScannerId === b.getAttribute("data-del-scanner")) this._selectedScannerId = null;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));
    this.shadowRoot.querySelectorAll("[data-del-window]").forEach((b) => b.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      f.windows = (f.windows || []).filter((w) => w.id !== b.getAttribute("data-del-window"));
      if (this._selectedWindowId === b.getAttribute("data-del-window")) this._selectedWindowId = null;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    }));
    const winSave = this.shadowRoot.getElementById("window-save");
    if (winSave) winSave.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const wn = (f.windows || []).find((ww) => ww.id === this._selectedWindowId);
      if (!wn) return;
      this._fpPushUndo();
      const wx = this.shadowRoot.getElementById("window-x"), wy = this.shadowRoot.getElementById("window-y");
      const ww = this.shadowRoot.getElementById("window-width"), wh = this.shadowRoot.getElementById("window-height");
      const ws = this.shadowRoot.getElementById("window-sill"), wr = this.shadowRoot.getElementById("window-rot");
      if (wx) { const v = this._parseDisplayToMeters(wx.value); if (!isNaN(v)) { const cl = this._clampToFloor(f, v, wn.y); wn.x = cl.x; } }
      if (wy) { const v = this._parseDisplayToMeters(wy.value); if (!isNaN(v)) { const cl = this._clampToFloor(f, wn.x, v); wn.y = cl.y; } }
      if (ww) { const v = this._parseDisplayToMeters(ww.value); if (!isNaN(v) && v >= 0.2) wn.width = v; }
      if (wh) { const v = this._parseDisplayToMeters(wh.value); if (!isNaN(v) && v >= 0.2) wn.height = v; }
      if (ws) { const v = this._parseDisplayToMeters(ws.value); if (!isNaN(v) && v >= 0) wn.height_from_floor = v; }
      if (wr) { const v = parseFloat(wr.value); if (!isNaN(v)) wn.rotation = ((v % 360) + 360) % 360; }
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const winRotL = this.shadowRoot.getElementById("window-rot-left");
    if (winRotL) winRotL.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const wn = (f.windows || []).find((ww) => ww.id === this._selectedWindowId);
      if (!wn) return;
      this._fpPushUndo();
      wn.rotation = (((parseFloat(wn.rotation) || 0) - 15) % 360 + 360) % 360;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const winRotR = this.shadowRoot.getElementById("window-rot-right");
    if (winRotR) winRotR.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      const wn = (f.windows || []).find((ww) => ww.id === this._selectedWindowId);
      if (!wn) return;
      this._fpPushUndo();
      wn.rotation = (((parseFloat(wn.rotation) || 0) + 15) % 360 + 360) % 360;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const winDefsSave = this.shadowRoot.getElementById("window-defs-save");
    if (winDefsSave) winDefsSave.addEventListener("click", () => {
      if (!this._floorplan) return;
      this._fpPushUndo();
      this._floorplan.window_defaults = this._floorplan.window_defaults || {};
      const w1 = this.shadowRoot.getElementById("def-win-w"), w2 = this.shadowRoot.getElementById("def-win-h"), w3 = this.shadowRoot.getElementById("def-win-sill");
      if (w1) { const v = this._parseDisplayToMeters(w1.value); if (!isNaN(v) && v >= 0.2) this._floorplan.window_defaults.width = v; }
      if (w2) { const v = this._parseDisplayToMeters(w2.value); if (!isNaN(v) && v >= 0.2) this._floorplan.window_defaults.height = v; }
      if (w3) { const v = this._parseDisplayToMeters(w3.value); if (!isNaN(v) && v >= 0) this._floorplan.window_defaults.height_from_floor = v; }
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const alignSave = this.shadowRoot.getElementById("align-save");
    if (alignSave) alignSave.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      const ax = this.shadowRoot.getElementById("align-x"), ay = this.shadowRoot.getElementById("align-y"), sc = this.shadowRoot.getElementById("align-scale"), rt = this.shadowRoot.getElementById("align-rot");
      if (ax) { const v = this._parseDisplayToMeters(ax.value); if (!isNaN(v)) f.offset_x = v; }
      if (ay) { const v = this._parseDisplayToMeters(ay.value); if (!isNaN(v)) f.offset_y = v; }
      if (sc) f.scale = parseFloat(sc.value) || 1;
      if (rt) f.rotation = (parseFloat(rt.value) || 0) * Math.PI / 180;
      this._saveFloorplan(); this._render(); this._renderFloorplanCanvas();
    });
    const dimsSave = this.shadowRoot.getElementById("dims-save");
    if (dimsSave) dimsSave.addEventListener("click", () => {
      const f = this._getActiveFloor(); if (!f) return;
      this._fpPushUndo();
      const fw = this.shadowRoot.getElementById("floor-width"), fd = this.shadowRoot.getElementById("floor-depth"), fh = this.shadowRoot.getElementById("floor-height");
      if (fw) { const v = this._parseDisplayToMeters(fw.value); if (!isNaN(v) && v >= 0.3) f.width = v; }
      if (fd) { const v = this._parseDisplayToMeters(fd.value); if (!isNaN(v) && v >= 0.3) f.depth = v; }
      if (fh) { const v = this._parseDisplayToMeters(fh.value); if (!isNaN(v) && v >= 0.3) f.height = v; }
      // Constrain all points into new dimensions
      for (const pt of (f.points || [])) {
        const cl = this._clampToFloor(f, pt.x, pt.y);
        pt.x = cl.x; pt.y = cl.y;
      }
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
    const snapBox = this.shadowRoot.getElementById("fp-snap");
    if (snapBox) snapBox.addEventListener("change", (e) => { this._fpSnapOn = e.target.checked; });
    const snapStep = this.shadowRoot.getElementById("fp-snap-step");
    if (snapStep) {
      snapStep.addEventListener("input", (e) => { this._fpSnapStep = e.target.value; });
      snapStep.addEventListener("change", (e) => { this._fpSnapStep = e.target.value; });
    }
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