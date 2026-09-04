/**
 * spatialHA Panel - WebSocket architecture with BLE
 * Frontend NEVER queries directly. All data goes via backend WebSocket
 * through Home Assistant: hass.callWS({type: "spatialha/..."} ) -> backend -> HA
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
    this._bleHasFetched = false;
    this._bleData = null; // {scanners, sightings, devices}
  }

  set hass(hass) {
    this._hass = hass;
    if (this._activeTab === "about" && !this._hasFetchedVersion && !this._loadingVersion) {
      this._fetchVersion();
    }
    if (this._activeTab === "ble" && !this._bleHasFetched && !this._bleLoading) {
      this._fetchBleData();
    }
  }

  connectedCallback() {
    this._render();
  }

  _switchTab(tab) {
    if (this._activeTab === tab) return;
    this._activeTab = tab;
    this._render();
    if (tab === "about" && !this._hasFetchedVersion && this._hass && !this._loadingVersion) {
      this._fetchVersion();
    }
    if (tab === "ble" && !this._bleHasFetched && this._hass && !this._bleLoading) {
      this._fetchBleData();
    }
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
      let result;
      try {
        result = await this._hass.callWS({ type: "spatialha/get_version" });
      } catch (e) {
        result = await this._hass.callWS({ type: "spatialHA/get_version" });
      }
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

  async _fetchBleData() {
    if (!this._hass || this._bleLoading) return;
    this._bleLoading = true;
    this._bleHasFetched = true;
    this._bleError = null;
    this._render();
    try {
      let data;
      try {
        data = await this._hass.callWS({ type: "spatialha/ble/get_data" });
      } catch (e) {
        try {
          data = await this._hass.callWS({ type: "spatialha/get_ble_data" });
        } catch (e2) {
          data = await this._hass.callWS({ type: "spatialHA/ble/get_data" });
        }
      }
      this._bleData = data;
      this._bleError = null;
    } catch (err) {
      this._bleError = err.message || String(err);
      this._bleData = null;
    } finally {
      this._bleLoading = false;
      this._render();
    }
  }

  _renderBleScannerView() {
    if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocket...</p>`;
    if (this._bleError) return `<p class="error">Error: ${this._bleError}</p><p><button id="ble-retry">Retry</button></p>`;
    if (!this._bleData || !this._bleData.sightings || this._bleData.sightings.length === 0) {
      const hasScanners = this._bleData && this._bleData.scanners && this._bleData.scanners.length > 0;
      if (!hasScanners) return `<p>No Bluetooth scanners found. Ensure Bluetooth proxies are configured.</p><p><button id="ble-retry">Refresh</button></p>`;
      return `<p>No BLE devices found by scanners.</p><p><button id="ble-retry">Refresh</button></p>`;
    }
    const sightings = this._bleData.sightings;
    // Build table: Scanner | MAC/UUID | Name | RSSI
    let rows = sightings.map(s => `
      <tr>
        <td>${this._esc(s.scanner_name || s.source)}</td>
        <td><code>${this._esc(s.address)}</code></td>
        <td>${this._esc(s.name || "")}</td>
        <td>${s.rssi !== null && s.rssi !== undefined ? this._esc(String(s.rssi)) + " dBm" : "N/A"}</td>
      </tr>
    `).join("");
    return `
      <div style="overflow:auto">
        <p><em>Scanner view: every sighting (device × scanner). ${sightings.length} rows.</em> <button id="ble-refresh">Refresh</button></p>
        <table>
          <thead><tr><th>Scanner</th><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  _renderBleDeviceView() {
    if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocket...</p>`;
    if (this._bleError) return `<p class="error">Error: ${this._bleError}</p><p><button id="ble-retry">Retry</button></p>`;
    if (!this._bleData || !this._bleData.devices || this._bleData.devices.length === 0) {
      return `<p>No BLE devices found.</p><p><button id="ble-retry">Refresh</button></p>`;
    }
    const scanners = this._bleData.scanners || [];
    const devices = this._bleData.devices;
    if (scanners.length === 0) {
      // Fallback to simple list if no scanners
      let rows = devices.map(d => `
        <tr><td><code>${this._esc(d.address)}</code></td><td>${this._esc(d.name)}</td><td>N/A</td></tr>
      `).join("");
      return `
        <p><em>Device view: ${devices.length} devices (no scanner info).</em> <button id="ble-refresh">Refresh</button></p>
        <table><thead><tr><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead><tbody>${rows}</tbody></table>
      `;
    }
    // Build header: fixed cols + per scanner
    let headerCols = `<th>MAC / UUID</th><th>Name</th>`;
    scanners.forEach(sc => {
      const label = this._esc(sc.name || sc.source);
      headerCols += `<th>${label}<br><small>${this._esc(sc.source)}</small></th>`;
    });
    // Rows
    let rows = devices.map(dev => {
      let cols = `<td><code>${this._esc(dev.address)}</code></td><td>${this._esc(dev.name)}</td>`;
      const per = dev.per_scanner || {};
      scanners.forEach(sc => {
        const key = sc.source;
        // per_scanner may have upper/lower variations, try case-insensitive
        let val = per[key];
        if (val === undefined) {
          // try upper
          val = per[key.toUpperCase()] || per[key.toLowerCase()];
          // also try to find any key case-insensitive
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
        <p><em>Device view: ${devices.length} unique devices, ${scanners.length} scanners. Each column is a scanner (RSSI or N/A).</em> <button id="ble-refresh">Refresh</button></p>
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
          <p>Bluetooth devices found by Bluetooth proxies (via backend WebSocket straight to Home Assistant).</p>
          ${subNav}
          <div>${bleInner}</div>
        </div>
      `;
    }

    let aboutInner = "";
    if (this._loadingVersion) {
      aboutInner = `<p class="loading">Loading version via WebSocket...</p>`;
    } else if (this._versionError) {
      aboutInner = `<p class="error">Error loading version: ${this._versionError}</p><p><button id="retry-btn">Retry</button></p>`;
    } else if (this._version !== null) {
      aboutInner = `<p class="version">Current version: ${this._version}</p><p>Version fetched via <code>spatialha/get_version</code> WebSocket (frontend → backend → Home Assistant).</p>`;
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
    else if (this._activeTab === "about") mainInner = aboutContent;

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <div class="container">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${this._activeTab === "home"}" data-tab="home" class="${this._activeTab === "home" ? "active" : ""}">Home</button>
          <button role="tab" aria-selected="${this._activeTab === "ble"}" data-tab="ble" class="${this._activeTab === "ble" ? "active" : ""}">BLE</button>
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
        this._bleHasFetched = false;
        this._bleData = null;
        this._bleError = null;
        this._fetchBleData();
      });
    }
    const bleRefresh = this.shadowRoot.getElementById("ble-refresh");
    if (bleRefresh) {
      bleRefresh.addEventListener("click", () => {
        this._bleHasFetched = false;
        this._bleData = null;
        this._bleError = null;
        this._fetchBleData();
      });
    }
  }
}

if (!customElements.get("spatialha-panel")) {
  customElements.define("spatialha-panel", SpatialHAPanel);
}
if (!customElements.get("spatialHA-panel")) {
  customElements.define("spatialHA-panel", SpatialHAPanel);
}
