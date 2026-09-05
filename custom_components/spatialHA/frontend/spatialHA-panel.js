/**
 * spatialHA Panel - WebSocket architecture with BLE + Settings + Targets
 * Frontend NEVER queries directly. All data goes via backend WebSocket
 * through Home Assistant: hass.callWS / hass.connection.subscribeMessage -> backend -> HA
 */
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
    this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [] };
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (firstHass) {
      if (this._activeTab === "about" && !this._hasFetchedVersion) this._fetchVersion();
      if (this._activeTab === "settings" && !this._settings) this._fetchSettings();
      if (this._activeTab === "ble") this._ensureBleSubscription();
      if (this._activeTab === "targets") this._ensureTargetsSubscription();
    } else {
      if (this._activeTab === "about" && !this._hasFetchedVersion && !this._loadingVersion) this._fetchVersion();
      if (this._activeTab === "ble" && !this._bleUnsub) this._ensureBleSubscription();
      if (this._activeTab === "settings" && !this._settings && !this._settingsLoading) this._fetchSettings();
      if (this._activeTab === "targets" && !this._targetsUnsub) this._ensureTargetsSubscription();
    }
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    if (this._bleUnsub) { try { this._bleUnsub(); } catch(e){} this._bleUnsub = null; }
    if (this._targetsUnsub) { try { this._targetsUnsub(); } catch(e){} this._targetsUnsub = null; }
  }

  _switchTab(tab) {
    if (this._activeTab === tab) return;
    this._activeTab = tab;
    this._render();
    if (tab === "about" && !this._hasFetchedVersion && this._hass && !this._loadingVersion) this._fetchVersion();
    if (tab === "settings" && !this._settings && this._hass && !this._settingsLoading) this._fetchSettings();
    if (tab === "ble" && this._hass) this._ensureBleSubscription();
    if (tab === "targets" && this._hass) this._ensureTargetsSubscription();
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
            this._render();
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
          if (Array.isArray(targets) || Array.isArray(payload.targets)) {
            this._targets = payload.targets || targets;
            this._targetsLoading = false;
            this._targetsError = null;
            this._render();
          } else if (payload && payload.targets) {
            this._targets = payload.targets;
            this._targetsLoading = false;
            this._render();
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
    };
    this._render();
  }

  _startAdd() {
    this._editingTarget = null;
    this._showAddForm = true;
    this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [] };
    this._render();
  }

  _cancelForm() {
    this._showAddForm = false;
    this._editingTarget = null;
    this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [] };
    this._render();
  }

  _toggleBleDevice(addr) {
    const upper = String(addr).toUpperCase();
    const idx = this._targetForm.ble_devices.findIndex(a => String(a).toUpperCase() === upper);
    if (idx >= 0) this._targetForm.ble_devices.splice(idx, 1);
    else this._targetForm.ble_devices.push(upper);
    this._render();
  }

  _renderBleScannerView() {
    if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocket… (auto-refresh every Update Interval)</p>`;
    if (this._bleError) return `<p class="error">Error: ${this._esc(this._bleError)}</p><p><button id="ble-retry">Retry</button></p>`;
    if (!this._bleData || !this._bleData.sightings || this._bleData.sightings.length === 0) {
      const hasScanners = this._bleData && this._bleData.scanners && this._bleData.scanners.length > 0;
      if (!hasScanners) return `<p>No Bluetooth scanners found. Ensure Bluetooth proxies are configured. Data auto-updates every Update Interval.</p><p><button id="ble-retry">Refresh</button></p>`;
      return `<p>No BLE devices found by scanners. Auto-refreshing…</p><p><button id="ble-retry">Refresh</button></p>`;
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
        <p><em>Scanner view: every sighting (device × scanner). ${sightings.length} rows. Auto-updates every ${this._esc(String(this._bleData.update_interval || this._settings?.update_interval || 1))}s ${updated ? " – last: " + updated : ""}</em></p>
        <table>
          <thead><tr><th>Scanner</th><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _renderBleDeviceView() {
    if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocket… (auto-refresh every Update Interval)</p>`;
    if (this._bleError) return `<p class="error">Error: ${this._bleError}</p><p><button id="ble-retry">Retry</button></p>`;
    if (!this._bleData || !this._bleData.devices || this._bleData.devices.length === 0) {
      return `<p>No BLE devices found. Auto-refreshing…</p><p><button id="ble-retry">Refresh</button></p>`;
    }
    const scanners = this._bleData.scanners || [];
    const devices = this._bleData.devices;
    const updated = this._bleData.last_updated ? new Date(this._bleData.last_updated * 1000).toLocaleTimeString() : "";
    if (scanners.length === 0) {
      let rows = devices.map(d => `
        <tr><td><code>${this._esc(d.address)}</code></td><td>${this._esc(d.name)}</td><td>${d.ibeacon ? this._esc(d.ibeacon.uuid) + " " + d.ibeacon.major + "/" + d.ibeacon.minor : "N/A"}</td><td>N/A</td></tr>
      `).join("");
      return `
        <p><em>Device view: ${devices.length} devices (no scanner info). Auto-refreshing…</em></p>
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
        const ib = dev.ibeacon ? `${this._esc(dev.ibeacon.uuid)}<br><small>${dev.ibeacon.major}/${dev.ibeacon.minor}</small>` : "—";
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
        <p><em>Device view: ${devices.length} unique devices, ${scanners.length} scanners. Each column is a scanner (RSSI or N/A). Auto-updates every ${this._esc(String(this._bleData.update_interval || this._settings?.update_interval || 1))}s ${updated ? " – last: " + updated : ""}</em></p>
        <table>
          <thead><tr>${headerCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _renderTargets() {
    if (this._targetsLoading) return `<p class="loading">Loading targets…</p>`;
    if (this._targetsError) return `<p class="error">Error: ${this._esc(this._targetsError)}</p><p><button id="targets-retry">Retry</button></p>`;

    let listHtml = "";
    if (!this._targets || this._targets.length === 0) {
      listHtml = `<p>No targets yet. Add a Person or Other target and assign BLE devices.</p>`;
    } else {
      listHtml = `<table><thead><tr><th>Name</th><th>Type</th><th>Icon</th><th>BLE Devices</th><th>State</th><th>Actions</th></tr></thead><tbody>`;
      this._targets.forEach(t => {
        const bleList = (t.ble_devices || []).map(a => `<code>${this._esc(a)}</code>`).join(", ") || "<em>none</em>";
        const state = this._esc(t.state || "unknown");
        const stateColor = state === "home" ? "var(--success-color, green)" : "var(--error-color, #db4437)";
        listHtml += `<tr>
          <td>${this._esc(t.name)} <small>(${this._esc(t.id.slice(0,8))})</small></td>
          <td>${this._esc(t.type)} </td>
          <td><ha-icon icon="${this._esc(t.icon)}"></ha-icon> <code>${this._esc(t.icon)}</code></td>
          <td>${bleList}</td>
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
      // Also include sightings addresses that may not be in devices? Use devices
      const allAddrs = new Set();
      available.forEach(d => allAddrs.add(d.address));
      // Also add any ble_devices already assigned that may not be in available
      (this._targetForm.ble_devices || []).forEach(a => allAddrs.add(a));
      if (allAddrs.size === 0) {
        bleOptions = `<p><em>No BLE devices discovered yet. Assign manually or wait for scanner.</em></p>`;
      } else {
        bleOptions = `<div style="max-height:180px; overflow:auto; border:1px solid var(--divider-color, #ccc); padding:8px; border-radius:6px;">`;
        allAddrs.forEach(addr => {
          const upper = String(addr).toUpperCase();
          const checked = this._targetForm.ble_devices.some(a => String(a).toUpperCase() === upper) ? "checked" : "";
          // Find name
          let name = upper;
          const dev = available.find(d => String(d.address).toUpperCase() === upper);
          if (dev && dev.name) name = `${dev.name} (${upper})`;
          bleOptions += `<label style="display:block; margin:4px 0;"><input type="checkbox" data-ble-addr="${this._esc(upper)}" ${checked}> <code>${this._esc(upper)}</code> ${this._esc(name !== upper ? " - " + dev.name : "")}</label>`;
        });
        bleOptions += `</div>`;
        // Also manual input
        bleOptions += `<p><small>Or add custom MAC/UUID:</small> <input id="ble-custom" placeholder="AA:BB:CC:DD:EE:FF" style="width:200px"> <button id="ble-add-custom">Add</button></p>`;
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
        <p>Welcome to spatialHA – Home tab</p>
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
    if (this._settingsLoading) settingsInner = `<p class="loading">Loading settings…</p>`;
    else if (this._settingsError) settingsInner = `<p class="error">Error: ${this._esc(this._settingsError)}</p><p><button id="settings-retry">Retry</button></p>`;
    else if (this._settings) {
      settingsInner = `
        <div class="field">
          <label for="interval-input">Update Interval (seconds, default 1)</label>
          <input id="interval-input" type="number" min="0.5" max="3600" step="0.5" value="${this._esc(this._pendingInterval)}" />
          <button id="settings-save" ${this._settingsSaving ? "disabled" : ""}>${this._settingsSaving ? "Saving…" : "Save"}</button>
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
      aboutInner = `<p class="version">Current version: ${this._version}</p><p>Version fetched via <code>spatialHA/get_version</code> WebSocket (frontend → backend → Home Assistant).</p>`;
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
    else if (this._activeTab === "targets") mainInner = targetsContent;
    else if (this._activeTab === "settings") mainInner = settingsContent;
    else if (this._activeTab === "about") mainInner = aboutContent;

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <div class="container">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${this._activeTab === "home"}" data-tab="home" class="${this._activeTab === "home" ? "active" : ""}">Home</button>
          <button role="tab" aria-selected="${this._activeTab === "ble"}" data-tab="ble" class="${this._activeTab === "ble" ? "active" : ""}">BLE</button>
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
  }
}

if (!customElements.get("spatialHA-panel")) {
  customElements.define("spatialHA-panel", SpatialHAPanel);
}
