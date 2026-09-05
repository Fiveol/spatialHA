export const SettingsMixin = {
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
    },

    async _fetchTracked() {
      if (!this._hass || this._trackedLoading) return;
      this._trackedLoading = true;
      try {
        const res = await this._hass.callWS({ type: "spatialHA/tracked/get" });
        this._trackedDevices = (res && Array.isArray(res.devices)) ? res.devices : [];
      } catch (err) {
        this._trackedDevices = [];
      } finally {
        this._trackedLoading = false;
        this._render();
        if (typeof this._renderHomeIsoCanvas === "function") this._renderHomeIsoCanvas();
      }
    },

    async _setTracked(address, on) {
      if (!this._hass) return;
      const addr = String(address || "").toUpperCase();
      if (!addr) return;
      // Optimistic local update so the checkbox feels instant.
      const cur = Array.isArray(this._trackedDevices) ? [...this._trackedDevices] : [];
      if (on && !cur.includes(addr)) cur.push(addr);
      if (!on) {
        const i = cur.indexOf(addr);
        if (i !== -1) cur.splice(i, 1);
      }
      this._trackedDevices = cur;
      this._render();
      try {
        const res = await this._hass.callWS({ type: "spatialHA/tracked/set", address: addr, tracked: !!on });
        if (res && Array.isArray(res.devices)) {
          this._trackedDevices = res.devices;
          this._render();
        }
      } catch (err) {
        // Keep the optimistic state; next fetch will reconcile.
      } finally {
        if (typeof this._renderHomeIsoCanvas === "function") this._renderHomeIsoCanvas();
      }
    },

    async _clearTracked() {
      if (!this._hass || this._trackedSaving) return;
      this._trackedSaving = true;
      this._render();
      try {
        const res = await this._hass.callWS({ type: "spatialHA/tracked/clear" });
        this._trackedDevices = (res && Array.isArray(res.devices)) ? res.devices : [];
      } catch (err) {
        // Leave state as-is on failure.
      } finally {
        this._trackedSaving = false;
        this._render();
        if (typeof this._renderHomeIsoCanvas === "function") this._renderHomeIsoCanvas();
      }
    },

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
};
