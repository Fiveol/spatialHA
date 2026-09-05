export const UtilsMixin = {
    _esc(s) {
      if (s === null || s === undefined) return "";
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    },

    _metersToDisplay(m) {
      if (this._floorplanUnits === "feet_inches") {
        const totalInches = m * 39.3701;
        const feet = Math.floor(totalInches / 12);
        const inches = (totalInches % 12).toFixed(1);
        return feet + "' " + inches + '"';
      }
      return Number(m).toFixed(2) + " m";
    },

    _displayToMeters(v) {
      if (typeof v === "string") return this._parseDisplayToMeters(v);
      if (this._floorplanUnits === "feet_inches") return v * 0.3048;
      return v;
    },

    _parseDisplayToMeters(str) {
      if (str === null || str === undefined) return NaN;
      if (typeof str === "number") {
        if (this._floorplanUnits === "feet_inches") return str * 0.3048;
        return str;
      }
      const s = String(str).trim();
      if (!s) return NaN;
      if (this._floorplanUnits !== "feet_inches") {
        // Meters: allow "2.5", "2.5 m", "250 cm"
        const m = s.match(/^(-?[\d.]+)\s*(m|meter|meters|cm)?$/i);
        if (!m) return parseFloat(s);
        const v = parseFloat(m[1]);
        if (isNaN(v)) return NaN;
        if ((m[2] || "").toLowerCase() === "cm") return v / 100;
        return v;
      }
      // Feet/inches: accept 6' 11", 6'11", 6 ft 11 in, 6.5 (feet), 11" (inches), 11 in
      let m = s.match(/^(-?[\d.]+)\s*(?:'|ft|feet)\s*(-?[\d.]+)?\s*(?:"|″|in|inch|inches)?\s*$/i);
      if (m) {
        const feet = parseFloat(m[1]);
        const inches = m[2] !== undefined && m[2] !== "" ? parseFloat(m[2]) : 0;
        if (isNaN(feet) || isNaN(inches)) return NaN;
        const sign = feet < 0 || Object.is(feet, -0) ? -1 : 1;
        return sign * (Math.abs(feet) * 12 + Math.abs(inches)) * 0.0254;
      }
      // Inches only: 11", 11 in
      m = s.match(/^(-?[\d.]+)\s*(?:"|″|in|inch|inches)\s*$/i);
      if (m) {
        const inches = parseFloat(m[1]);
        if (isNaN(inches)) return NaN;
        return inches * 0.0254;
      }
      // Bare number = feet decimal
      const v = parseFloat(s);
      if (isNaN(v)) return NaN;
      return v * 0.3048;
    },

    _formatMetersForInput(m) {
      if (this._floorplanUnits === "feet_inches") {
        const totalInches = m / 0.0254;
        const feet = Math.floor(totalInches / 12);
        const inches = (totalInches - feet * 12).toFixed(1);
        return feet + "' " + inches + '"';
      }
      return Number(m).toFixed(2);
    },

    _clampToFloor(floor, x, y) {
      const w = parseFloat(floor.width) || 10, d = parseFloat(floor.depth) || 8;
      return { x: Math.min(Math.max(x, 0), w > 0 ? w : 10), y: Math.min(Math.max(y, 0), d > 0 ? d : 8) };
    },

    _requestDraw(key, fn) {
      this._rafPending = this._rafPending || {};
      if (this._rafPending[key]) return;
      this._rafPending[key] = true;
      requestAnimationFrame(() => {
        this._rafPending[key] = false;
        fn();
      });
    },

    _saveFloorplanSoon() {
      if (this._saveFpTimer) clearTimeout(this._saveFpTimer);
      this._saveFpTimer = setTimeout(() => {
        this._saveFpTimer = null;
        this._saveFloorplan();
      }, 400);
    }
};
