export const TargetsMixin = {
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
    },

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
    },

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
        this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
        // Targets will be pushed via subscription, but also fetch
        this._fetchTargetsOnce();
      } catch (e) {
        alert("Failed to create target: " + (e.message || String(e)));
      }
    },

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
        this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
        this._fetchTargetsOnce();
      } catch (e) {
        alert("Failed to update target: " + (e.message || String(e)));
      }
    },

    async _deleteTarget(id) {
      if (!confirm("Delete target?")) return;
      try {
        await this._hass.callWS({ type: "spatialHA/targets/delete", target_id: id });
        this._fetchTargetsOnce();
      } catch (e) {
        alert("Failed to delete: " + (e.message || String(e)));
      }
    },

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
      this._ensureTargetOptions();
    },

    _ensureTargetOptions() {
      // Make sure BLE + GPS option lists populate even if those tabs were never opened.
      if (!this._hass) return;
      try {
        if (!this._bleUnsub) this._ensureBleSubscription();
        else if (!this._bleData && !this._bleLoading) this._fetchBleOnce();
      } catch (e) {}
      try {
        if (!this._gpsUnsub) this._ensureGpsSubscription();
        else if (!this._gpsData && !this._gpsLoading) this._fetchGpsOnce();
      } catch (e) {}
    },

    _startAdd() {
      this._editingTarget = null;
      this._showAddForm = true;
      this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
      this._render();
      this._ensureTargetOptions();
    },

    _cancelForm() {
      this._showAddForm = false;
      this._editingTarget = null;
      this._targetForm = { name: "", type: "Person", icon: "mdi:account", ble_devices: [], gps_entities: [] };
      this._render();
    },

    _toggleBleDevice(addr) {
      const upper = String(addr).toUpperCase();
      if (!Array.isArray(this._targetForm.ble_devices)) this._targetForm.ble_devices = [];
      const idx = this._targetForm.ble_devices.findIndex(a => String(a).toUpperCase() === upper);
      if (idx >= 0) this._targetForm.ble_devices.splice(idx, 1);
      else this._targetForm.ble_devices.push(upper);
      this._render();
    },

    _toggleGpsEntity(entity_id) {
      if (!Array.isArray(this._targetForm.gps_entities)) this._targetForm.gps_entities = [];
      const idx = this._targetForm.gps_entities.indexOf(entity_id);
      if (idx >= 0) this._targetForm.gps_entities.splice(idx, 1);
      else this._targetForm.gps_entities.push(entity_id);
      this._render();
    },

    _renderTargets() {
      if (this._targetsLoading) return `<p class="loading">Loading targets…</p>`;
      if (this._targetsError) return `<p class="error">Error: ${this._esc(this._targetsError)}</p><p><button id="targets-retry">Retry</button></p>`;

      let listHtml = "";
      if (!this._targets || this._targets.length === 0) {
        listHtml = `<p>No targets yet.</p>`;
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
          bleOptions = `<p><em>No Bluetooth devices discovered yet.</em></p>`;
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
          bleOptions += `<p><small>Custom MAC/UUID:</small> <input id="ble-custom" placeholder="AA:BB:CC:DD:EE:FF" style="width:200px"> <button id="ble-add-custom">Add</button></p>`;
        }
        // GPS options
        let gpsOptions = "";
        const gpsAvailable = (this._gpsData && (this._gpsData.entities || [])) || [];
        const allGps = new Set();
        gpsAvailable.forEach(e => allGps.add(e.entity_id));
        (this._targetForm.gps_entities || []).forEach(e => allGps.add(e));
        if (allGps.size === 0) {
          gpsOptions = `<p><em>No Device Tracker entities found.</em></p>`;
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
            <div class="field"><label>Bluetooth Devices</label>${bleOptions}</div>
            <div class="field"><label>Device Tracker Entities</label>${gpsOptions}</div>
            <p><button id="target-save">${isEdit ? "Update" : "Create"}</button> <button id="target-cancel">Cancel</button></p>
          </div>
        `;
      }

      return `
        <div class="card">
          <h2>Targets</h2>
          <p>Track people and things. Person/Other are cosmetic (icon). Assign one or many BLE devices; state is <code>home</code> only if all assigned devices are seen, otherwise <code>not_home</code> (any Away => away). Each target creates a Device + Device Tracker entity.</p>
          <p><button id="target-add">Add Target</button> <button id="targets-refresh">Refresh</button></p>
          ${formHtml}
          ${listHtml}
        </div>
      `;
    }
};
