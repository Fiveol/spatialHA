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
