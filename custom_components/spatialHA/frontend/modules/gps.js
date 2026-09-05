export const GpsMixin = {
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
              if (this._activeTab === "gps" || (this._activeTab === "targets" && this._showAddForm)) {
                if (typeof this._queueRender === "function") this._queueRender();
                else this._render();
              }
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
    },

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
    },

    _renderGps() {
    if (this._gpsLoading) return `<p class="loading">Loading GPS entities…</p>`;
    if (this._gpsError) return `<p class="error">Error: ${this._esc(this._gpsError)}</p><p><button id="gps-retry">Retry</button></p>`;
    if (!this._gpsData || !this._gpsData.entities || this._gpsData.entities.length === 0) {
      return `<p>No Device Tracker entities found.</p><p><button id="gps-retry">Refresh</button></p>`;
    }
    const _gfq = (this._gpsFilter || "").trim().toLowerCase();
    const entities = (this._gpsData.entities || []).filter((e) => !_gfq || [e.entity_id, e.name || "", e.friendly_name || "", e.state || ""].join(" ").toLowerCase().includes(_gfq));
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
        <p><input id="gps-filter" type="search" placeholder="Filter" value="${this._esc(this._gpsFilter || "")}" style="max-width:220px"> <em>${entities.length} entities.</em> <button id="gps-refresh">Refresh</button></p>
        <table>
          <thead><tr><th>Entity ID</th><th>Name</th><th>State</th><th>Source</th><th>Location</th><th>Icon</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    }
};
