/**
 * spatialHA Panel - WebSocket architecture with BLE + Settings
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
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (firstHass) {
      // Fetch version and settings eagerly
      if (this._activeTab === "about" && !this._hasFetchedVersion) this._fetchVersion();
      if (this._activeTab === "settings" && !this._settings) this._fetchSettings();
      if (this._activeTab === "ble") this._ensureBleSubscription();
    } else {
      if (this._activeTab === "about" && !this._hasFetchedVersion && !this._loadingVersion) this._fetchVersion();
      if (this._activeTab === "ble" && !this._bleUnsub) this._ensureBleSubscription();
      if (this._activeTab === "settings" && !this._settings && !this._settingsLoading) this._fetchSettings();
    }
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    if (this._bleUnsub) {
      try { this._bleUnsub(); } catch (e) {}
      this._bleUnsub = null;
    }
  }

  _switchTab(tab) {
    if (this._activeTab === tab) return;
    this._activeTab = tab;
    this._render();
    if (tab === "about" && !this._hasFetchedVersion && this._hass && !this._loadingVersion) this._fetchVersion();
    if (tab === "settings" && !this._settings && this._hass && !this._settingsLoading) this._fetchSettings();
    if (tab === "ble" && this._hass) this._ensureBleSubscription();
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
    // If already have data, keep it but ensure subscription for live pushes
    this._bleLoading = true;
    this._render();
    try {
      // Use subscribeMessage for push every Update Interval
      const sub = this._hass.connection.subscribeMessage(
        (msg) => {
          // HA sends event_message with {type, data}
          const data = msg.data || msg;
          // data may be {type:"ble_update", data:{...}} or directly {scanners,...}
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
      // subscribeMessage may return Promise that resolves to unsub function
      if (sub && typeof sub.then === "function") {
        sub.then((unsub) => {
          this._bleUnsub = unsub;
          this._bleLoading = false;
          // Also fetch once via get_data as fallback to populate immediately if push hasn't arrived
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
    if (scanners.length === 0) {
      let rows = devices.map(d => `
        <tr><td><code>${this._esc(d.address)}</code></td><td>${this._esc(d.name)}</td><td>N/A</td></tr>
      `).join("");
      return `
        <p><em>Device view: ${devices.length} devices (no scanner info). Auto-refreshing…</em></p>
        <table><thead><tr><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead><tbody>${rows}</tbody></table>
      `;
    }
    let headerCols = `<th>MAC / UUID</th><th>Name</th>`;
    scanners.forEach(sc => {
      const label = this._esc(sc.name || sc.source);
      headerCols += `<th>${label}<br><small>${this._esc(sc.source)}</small></th>`;
    });
    let rows = devices.map(dev => {
      let cols = `<td><code>${this._esc(dev.address)}</code></td><td>${this._esc(dev.name)}</td>`;
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
    const updated = this._bleData.last_updated ? new Date(this._bleData.last_updated * 1000).toLocaleTimeString() : "";
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

  _esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  _render() {
    const style = `
      :host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
      .container { padding: 16px; max-width: 1100px; margin: 0 auto; }
      .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--divider-color, #e0e0e0); margin-bottom: 16px; }
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
      .field input { padding: 8px 10px; font-size: 14px; border: 1px solid var(--divider-color, #ccc); border-radius: 6px; width: 160px; }
      .field button { margin-left: 8px; padding: 8px 14px; }
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
        <p><small>Backend polls BLE data every Update Interval even without frontend and pushes to BLE tab. Stored in <code>.storage/spatialHA.settings</code> and <code>.storage/spatialHA.ble_data</code>.</small></p>
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
    else if (this._activeTab === "settings") mainInner = settingsContent;
    else if (this._activeTab === "about") mainInner = aboutContent;

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <div class="container">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${this._activeTab === "home"}" data-tab="home" class="${this._activeTab === "home" ? "active" : ""}">Home</button>
          <button role="tab" aria-selected="${this._activeTab === "ble"}" data-tab="ble" class="${this._activeTab === "ble" ? "active" : ""}">BLE</button>
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
  }
}

if (!customElements.get("spatialHA-panel")) {
  customElements.define("spatialHA-panel", SpatialHAPanel);
}
