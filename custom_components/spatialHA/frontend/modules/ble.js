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
      const _fq = (this._bleFilter || "").trim().toLowerCase();
      const sightings = (this._bleData.sightings || []).filter((s) => !_fq || [s.scanner_name || s.source, s.address, s.name || "", ...((s.service_uuids || []).map(String))].join(" ").toLowerCase().includes(_fq));
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
          <p><input id="ble-filter" type="search" placeholder="Filter" value="${this._esc(this._bleFilter || "")}" style="max-width:220px"> <em>${sightings.length} sightings.</em></p>
          <table>
            <thead><tr><th>Scanner</th><th>MAC / UUID</th><th>Name</th><th>RSSI</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    },

    _renderBleDeviceView() {
      if (this._bleLoading) return `<p class="loading">Loading BLE devices via WebSocket… (auto-refresh every Update Interval)</p>`;
      if (this._bleError) return `<p class="error">Error: ${this._bleError}</p><p><button id="ble-retry">Retry</button></p>`;
      if (!this._bleData || !this._bleData.devices || this._bleData.devices.length === 0) {
        return `<p>No BLE devices found. Auto-refreshing…</p><p><button id="ble-retry">Refresh</button></p>`;
      }
      const scanners = this._bleData.scanners || [];
      const _fq2 = (this._bleFilter || "").trim().toLowerCase();
      const _match = (d) => !_fq2 || [d.address, d.name || "", ...((d.service_uuids || []).map(String)), d.ibeacon ? d.ibeacon.uuid : ""].join(" ").toLowerCase().includes(_fq2);
      const devices = (this._bleData.devices || []).filter(_match);
      const updated = this._bleData.last_updated ? new Date(this._bleData.last_updated * 1000).toLocaleTimeString() : "";
      const _tracked = Array.isArray(this._trackedDevices) ? this._trackedDevices : [];
      const _isTracked = (d) => _tracked.includes(String(d.address || "").toUpperCase());
      if (scanners.length === 0) {
        let rows = devices.map(d => `
          <tr><td><input type="checkbox" data-track-addr="${this._esc(String(d.address || "").toUpperCase())}" ${_isTracked(d) ? "checked" : ""} title="Show on Home map"></td><td><code>${this._esc(d.address)}</code></td><td>${this._esc(d.name)}</td><td>${d.ibeacon ? this._esc(d.ibeacon.uuid) + " " + d.ibeacon.major + "/" + d.ibeacon.minor : "N/A"}</td><td>N/A</td></tr>
        `).join("");
        return `
          <p><input id="ble-filter" type="search" placeholder="Filter" value="${this._esc(this._bleFilter || "")}" style="max-width:220px"> <em>${devices.length} devices (${_tracked.length} tracked).</em></p>
          <table><thead><tr><th>Track</th><th>MAC / UUID</th><th>Name</th><th>iBeacon</th><th>RSSI</th></tr></thead><tbody>${rows}</tbody></table>
        `;
      }
      let headerCols = `<th>Track</th><th>MAC / UUID</th><th>Name</th>`;
      // Add iBeacon column if any device has iBeacon
      const hasIbeacon = devices.some(d => d.ibeacon);
      if (hasIbeacon) headerCols += `<th>iBeacon UUID</th>`;
      // Add position column if any device was triangulated
      const floorsById = {};
      try {
        for (const f of ((this._floorplan && this._floorplan.floors) || [])) floorsById[f.id] = f.name || f.id;
      } catch (e) {}
      const hasPos = devices.some(d => d.position);
      if (hasPos) headerCols += `<th>Position</th>`;
      scanners.forEach(sc => {
        const label = this._esc(sc.name || sc.source);
        headerCols += `<th>${label}<br><small>${this._esc(sc.source)}</small></th>`;
      });
      let rows = devices.map(dev => {
        let cols = `<td><input type="checkbox" data-track-addr="${this._esc(String(dev.address || "").toUpperCase())}" ${_isTracked(dev) ? "checked" : ""} title="Show on Home map"></td><td><code>${this._esc(dev.address)}</code></td><td>${this._esc(dev.name)}</td>`;
        if (hasIbeacon) {
          const ib = dev.ibeacon ? `${this._esc(dev.ibeacon.uuid)}<br><small>${dev.ibeacon.major}/${dev.ibeacon.minor}</small>` : "—";
          cols += `<td>${ib}</td>`;
        }
        if (hasPos) {
          const pos = dev.position;
          cols += pos
            ? `<td>${this._esc(floorsById[pos.floor_id] || pos.floor_id)} (${Number(pos.x).toFixed(1)}, ${Number(pos.y).toFixed(1)})</td>`
            : `<td style="color: var(--secondary-text-color, #999)">N/A</td>`;
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
          <p><input id="ble-filter" type="search" placeholder="Filter" value="${this._esc(this._bleFilter || "")}" style="max-width:220px"> <em>${devices.length} devices / ${scanners.length} scanners (${_tracked.length} tracked).</em></p>
          <table>
            <thead><tr>${headerCols}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }
};
