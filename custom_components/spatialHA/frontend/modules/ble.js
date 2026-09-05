export const BleMixin = {
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
    },

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
    },

    _renderBleScannerView() {
      if (this._bleLoading) return `<p class="loading">Loading…</p>`;
      if (this._bleError) return `<p class="error">Error: ${this._esc(this._bleError)}</p><p><button id="ble-retry">Retry</button></p>`;
      if (!this._bleData || !this._bleData.sightings || this._bleData.sightings.length === 0) {
        const hasScanners = this._bleData && this._bleData.scanners && this._bleData.scanners.length > 0;
        if (!hasScanners) return `<p>No scanners found.</p><p><button id="ble-retry">Refresh</button></p>`;
        return `<p>No devices found.</p><p><button id="ble-retry">Refresh</button></p>`;
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
      return `
        <div style="overflow:auto">
          <p><em>${sightings.length} sightings.</em></p>
          <table>
            <thead><tr><th>Scanner</th><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    },

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
          <p><em>${devices.length} devices. Auto-refreshingâ€¦</em></p>
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
          <p><em>${devices.length} devices · ${scanners.length} scanners.</em></p>
          <table>
            <thead><tr>${headerCols}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }
};
