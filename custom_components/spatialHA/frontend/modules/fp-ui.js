export const FloorplanUiMixin = {
    _renderFloorplan() {
      if (this._floorplanLoading) return `<p class="loading">Loading floorplan…</p>`;
      if (this._floorplanError) return `<p class="error">Error: ${this._esc(this._floorplanError)}</p><p><button id="floorplan-retry">Retry</button></p>`;
      if (!this._floorplan || !this._floorplan.floors) return `<p>No floorplan.</p>`;
      const floor = this._getActiveFloor();
      if (!floor) return `<div class="card"><h2>Floor Plan</h2><p>No floors. Add one to begin.</p><p><button id="floor-add">Add Floor</button></p></div>`;
      const unitsSel = `<select id="floorplan-units"><option value="meters" ${this._floorplanUnits === "meters" ? "selected" : ""}>Meters</option><option value="feet_inches" ${this._floorplanUnits === "feet_inches" ? "selected" : ""}>Feet/Inches</option></select>`;
      const floorTabs = this._floorplan.floors.map((f) => `<button data-floor="${this._esc(f.id)}" style="padding:6px 12px; margin:2px; border:1px solid #ccc; border-radius:4px; background:${f.id === this._selectedFloorId ? "#03a9f4" : "#fafafa"}; color:${f.id === this._selectedFloorId ? "white" : "#333"}; cursor:pointer;">${this._esc(f.name)} (L${f.level})</button>`).join("");
      const wallsHtml = (floor.walls || []).map((w) => {
        const p1 = floor.points.find((p) => p.id === w.p1), p2 = floor.points.find((p) => p.id === w.p2);
        const len = p1 && p2 ? Math.hypot(p1.x - p2.x, p1.y - p2.y) : 0;
        return `<tr><td>${this._esc(this._metersToDisplay(len))}</td><td><button data-del-wall="${this._esc(w.id)}">Delete</button></td></tr>`;
      }).join("") || `<tr><td colspan="2"><em>No walls</em></td></tr>`;
      const roomsHtml = (floor.rooms || []).map((r) => `<tr><td>${this._esc(r.name)}</td><td>${this._esc(String((r.point_ids || []).length))} pts</td><td><input type="color" value="${this._esc(r.color || "#6496ff")}" data-room-color="${this._esc(r.id)}" style="width:40px;"></td><td><button data-del-room="${this._esc(r.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="4"><em>No rooms</em></td></tr>`;
      const doorsHtml = ((floor.doors || []).map((dr) => `<tr><td>${this._esc(dr.type)}</td><td>${this._esc(this._formatMetersForInput(dr.width || 0.9))}</td><td>${this._esc(String(Math.round(((parseFloat(dr.rotation) || 0)))))}°</td><td>${this._esc(dr.swing || "")}</td><td><button data-del-door="${this._esc(dr.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="5"><em>No doors - click Door / Double / Garage then click canvas to place</em></td></tr>`);
      const selDoor = this._selectedDoorId ? (floor.doors || []).find((d) => d.id === this._selectedDoorId) : null;
      const doorEditHtml = selDoor ? `
        <div style="border:1px solid #ff9800; padding:10px; border-radius:6px; margin-top:8px;">
          <h4>Selected Door (${this._esc(selDoor.type)})</h4>
          <label>X: <input id="door-x" type="text" value="${this._esc(this._formatMetersForInput(selDoor.x || 0))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Y: <input id="door-y" type="text" value="${this._esc(this._formatMetersForInput(selDoor.y || 0))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Rotation (deg): <input id="door-rot" type="number" step="5" value="${Math.round(parseFloat(selDoor.rotation) || 0)}" style="width:80px"></label>
          <button id="door-rot-left" title="Rotate -15°">⟲</button><button id="door-rot-right" title="Rotate +15°">⟳</button><br>
          <label>Size: <input id="door-width" type="text" value="${this._esc(this._formatMetersForInput(selDoor.width || 0.9))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Swing: <select id="door-swing">
            <option value="left" ${selDoor.swing === "left" ? "selected" : ""}>left</option>
            <option value="right" ${selDoor.swing === "right" ? "selected" : ""}>right</option>
            <option value="up" ${selDoor.swing === "up" ? "selected" : ""}>up</option>
            <option value="none" ${selDoor.swing === "none" ? "selected" : ""}>none</option>
          </select></label><br>
          <button id="door-save">Save Door</button>
        </div>` : (this._placingDoorType ? `<p><em>Placing ${this._esc(this._placingDoorType)} - click on canvas to place (Esc to cancel).</em> <button id="door-cancel-place">Cancel</button></p>` : "");
      const dd = this._doorDefaults();
      const windowsHtml = (((floor.windows || []).map((wn) => `<tr><td>${this._esc(this._formatMetersForInput(wn.width || 1.2))} × ${this._esc(this._formatMetersForInput(wn.height || 1.2))}</td><td>${this._esc(this._formatMetersForInput(wn.height_from_floor || 0.9))}</td><td>${this._esc(String(Math.round(parseFloat(wn.rotation) || 0)))}°</td><td><button data-del-window="${this._esc(wn.id)}">Delete</button></td></tr>`).join("")) || `<tr><td colspan="4"><em>No windows - click Add Window then click canvas (origin = lower-left corner)</em></td></tr>`);
      const selWin = this._selectedWindowId ? (floor.windows || []).find((w) => w.id === this._selectedWindowId) : null;
      const windowEditHtml = selWin ? `
        <div style="border:1px solid #22d3ee; padding:10px; border-radius:6px; margin-top:8px;">
          <h4>Selected Window (origin = lower-left corner)</h4>
          <label>X: <input id="window-x" type="text" value="${this._esc(this._formatMetersForInput(selWin.x || 0))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Y: <input id="window-y" type="text" value="${this._esc(this._formatMetersForInput(selWin.y || 0))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Width: <input id="window-width" type="text" value="${this._esc(this._formatMetersForInput(selWin.width || 1.2))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Height: <input id="window-height" type="text" value="${this._esc(this._formatMetersForInput(selWin.height || 1.2))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Height from floor: <input id="window-sill" type="text" value="${this._esc(this._formatMetersForInput(selWin.height_from_floor || 0.9))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
          <label>Rotation (deg): <input id="window-rot" type="number" step="5" value="${Math.round(parseFloat(selWin.rotation) || 0)}" style="width:80px"></label>
          <button id="window-rot-left" title="Rotate -15°">⟲</button><button id="window-rot-right" title="Rotate +15°">⟳</button><br>
          <button id="window-save">Save Window</button>
        </div>` : (this._placingWindow ? `<p><em>Placing window - click on canvas for lower-left corner origin (Esc to cancel).</em> <button id="window-cancel-place">Cancel</button></p>` : "");
      const receiversHtml = (((floor.receivers || []).map((rx) => `<tr><td>${this._esc(rx.name || "Receiver")}</td><td>(${this._esc(this._formatMetersForInput(rx.x))}, ${this._esc(this._formatMetersForInput(rx.y))})</td><td><button data-del-receiver="${this._esc(rx.id)}">Delete</button></td></tr>`).join("")) || `<tr><td colspan="3"><em>No receivers - click Add Receiver then click canvas to place</em></td></tr>`);
      const receiverHintHtml = this._placingReceiver ? `<p><em>Placing receiver - click on canvas to place (Esc to cancel).</em> <button id="receiver-cancel-place">Cancel</button></p>` : "";
      const discoveredScanners = ((this._bleData && this._bleData.scanners) || []).map((s) => ({ source: String(s.source || ""), label: String(s.name || s.source || "") })).filter((s) => s.source);
      const scannersHtml = (((floor.scanners || []).map((sc) => `<tr><td>${this._esc(sc.name || sc.source || "Scanner")}</td><td><code>${this._esc(sc.source || "")}</code></td><td>(${this._esc(this._formatMetersForInput(sc.x))}, ${this._esc(this._formatMetersForInput(sc.y))})</td><td><button data-del-scanner="${this._esc(sc.id)}">Delete</button></td></tr>`).join("")) || `<tr><td colspan="4"><em>No scanners - pick one below then click canvas to place</em></td></tr>`);
      const scannerPickHtml = `<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;"><label>Scanner: <select id="scanner-source">${discoveredScanners.map((s) => `<option value="${this._esc(s.source)}">${this._esc(s.label)} (${this._esc(s.source)})</option>`).join("") || `<option value="">No scanners discovered</option>`}</select></label><input id="scanner-custom" placeholder="or custom source" style="width:170px"><button id="scanner-add">Add Scanner</button></div>${this._placingScanner ? `<p><em>Placing scanner - click on canvas to place (Esc to cancel).</em> <button id="scanner-cancel-place">Cancel</button></p>` : ""}`;
      const wd2 = this._windowDefaults();
      const windowDefaultsHtml = `
        <div style="border:1px solid #eee; padding:10px; border-radius:6px; margin-top:12px;"><h4>Default Window (used for new windows)</h4>
        <label>Width: <input id="def-win-w" type="text" value="${this._esc(this._formatMetersForInput(wd2.width))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
        <label>Height: <input id="def-win-h" type="text" value="${this._esc(this._formatMetersForInput(wd2.height))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
        <label>Height from floor: <input id="def-win-sill" type="text" value="${this._esc(this._formatMetersForInput(wd2.height_from_floor))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
        <button id="window-defs-save">Save Defaults</button></div>`;
      const selectedInfo = this._selectedPointId ? (() => { const pt = floor.points.find((p) => p.id === this._selectedPointId); return pt ? `Selected point at (${this._formatMetersForInput(pt.x)}, ${this._formatMetersForInput(pt.y)}) - double-click to edit` : ""; })() : (this._selectedScannerId ? `Scanner selected - double-click to rename or move` : (this._selectedReceiverId ? `Receiver selected - double-click to rename or move` : (this._selectedWindowId ? `Window selected - edit below` : (this._selectedDoorId ? `Door selected - edit below` : (this._selectedWallId ? `Wall selected` : "Left-click selects, double-click point to edit position, right-click point for 4 arrows"))))); const doorDefaultsHtml = `
        <div style="border:1px solid #eee; padding:10px; border-radius:6px; margin-top:12px;"><h4>Default Door Sizes (used for new doors)</h4>
        <label>Door: <input id="def-door" type="text" value="${this._esc(this._formatMetersForInput(dd["Door"]))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
        <label>Double Door: <input id="def-double" type="text" value="${this._esc(this._formatMetersForInput(dd["Double Door"]))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
        <label>Garage Door: <input id="def-garage" type="text" value="${this._esc(this._formatMetersForInput(dd["Garage Door"]))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br>
        <button id="door-defs-save">Save Defaults</button></div>`;
      return `
        <div class="card">
          <h2>Floor Plan - ${this._esc(floor.name)}</h2>
          <p>Floor plan editor. Units: ${unitsSel}. Keys: WASD move, QE zoom, arrows zoom/look.</p>
          <div style="margin:8px 0; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <button id="floor-add">Add Floor</button>
            <button id="floor-rename">Rename Floor</button>
            <button id="floor-delete">Delete Floor</button>
            <label>Level: <input id="floor-level" type="number" value="${floor.level}" style="width:60px"></label>
          </div>
          <div style="display:flex; gap:4px; margin:8px 0; flex-wrap:wrap;">${floorTabs}</div>
          <div style="display:flex; gap:4px; margin:8px 0;">
            <button data-fp-mode="2d" style="padding:6px 12px; border:1px solid #444; border-radius:4px; background:${(this._fpMode || "2d") === "2d" ? "#03a9f4" : "#1e2228"}; color:${(this._fpMode || "2d") === "2d" ? "white" : "#cfd6df"}; cursor:pointer;">2D</button>
            <button data-fp-mode="3d" style="padding:6px 12px; border:1px solid #444; border-radius:4px; background:${this._fpMode === "3d" ? "#03a9f4" : "#1e2228"}; color:${this._fpMode === "3d" ? "white" : "#cfd6df"}; cursor:pointer;">3D</button>
            <span style="flex:1"></span>
            <span data-fp-views style="display:${this._fpMode === "3d" ? "flex" : "none"}; gap:4px;">
              <button data-fp-view="iso">Isometric</button>
              <button data-fp-view="top">Top Down</button>
              <button data-fp-view="front">Front</button>
              <button data-fp-view="back">Back</button>
              <button data-fp-view="left">Left Side</button>
              <button data-fp-view="right">Right Side</button>
            </span>
          </div>
          <div id="floorplan-wrap" style="border:1px solid #333; border-radius:8px; overflow:hidden; background:#14161a; aspect-ratio: 8/5; max-height:520px; display:${(this._fpMode || "2d") === "2d" ? "block" : "none"};">
            <canvas id="floorplan-canvas" width="800" height="500" style="display:block; cursor:crosshair; width:100%; height:100%; background:#14161a;"></canvas>
          </div>
          <div id="floorplan-3d-wrap" style="border:1px solid #333; border-radius:8px; overflow:hidden; background:#14161a; display:${this._fpMode === "3d" ? "block" : "none"};">
            <canvas id="floorplan-3d-canvas" width="800" height="380" style="display:block; width:100%; height:380px; background:#14161a; cursor:grab;"></canvas>
            <p style="padding:0 12px;"><small>Drag to rotate. Scroll to zoom.</small></p>
          </div>
          <p><small>${selectedInfo} | Scale: ${this._floorplanScale.toFixed(1)}px/m</small></p>
          <div style="margin-top:12px; border:1px solid #eee; padding:10px; border-radius:6px;">
            <h3>Doors</h3>
            <p>
              <button id="door-add-Door">Add Door</button>
              <button id="door-add-Double">Add Double Door</button>
              <button id="door-add-Garage">Add Garage Door</button>
            </p>
            <table><thead><tr><th>Type</th><th>Size</th><th>Rotation</th><th>Swing</th><th>Action</th></tr></thead><tbody>${doorsHtml}</tbody></table>
            ${doorEditHtml}
            ${doorDefaultsHtml}
          </div>
          <div style="margin-top:12px; border:1px solid #eee; padding:10px; border-radius:6px;">
            <h3>Windows</h3>
            <p><button id="window-add">Add Window</button> <small>origin = lower-left corner, then edit size/height/sill/rotation</small></p>
            <table><thead><tr><th>Size (W × H)</th><th>Sill Height</th><th>Rotation</th><th>Action</th></tr></thead><tbody>${windowsHtml}</tbody></table>
            ${windowEditHtml}
            ${windowDefaultsHtml}
          </div>
          <div style="margin-top:12px; border:1px solid #eee; padding:10px; border-radius:6px;">
            <h3>BLE Receivers</h3>
            <p><button id="receiver-add">Add Receiver</button> <small>click canvas to place</small></p>
            <table><thead><tr><th>Name</th><th>Position</th><th>Action</th></tr></thead><tbody>${receiversHtml}</tbody></table>
            ${receiverHintHtml}
          </div>
          <div style="margin-top:12px; border:1px solid #eee; padding:10px; border-radius:6px;">
            <h3>Bluetooth Scanners</h3>
            <p><small>Place your proxies on the plan. Position only for now.</small></p>
            ${scannerPickHtml}
            <table><thead><tr><th>Name</th><th>Source</th><th>Position</th><th>Action</th></tr></thead><tbody>${scannersHtml}</tbody></table>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:12px;">
            <div><h3>Walls</h3><p><button id="wall-add">Add Wall (selected + last)</button> <small>or right-drag point to point</small></p><table><thead><tr><th>Length</th><th>Action</th></tr></thead><tbody>${wallsHtml}</tbody></table></div>
            <div><h3>Rooms</h3><p><button id="room-add">Add Room (all points)</button> <small>or middle-drag across points</small></p><table><thead><tr><th>Name</th><th>Points</th><th>Color</th><th>Action</th></tr></thead><tbody>${roomsHtml}</tbody></table></div>
          </div>
          <div style="margin-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:16px;">
            <div style="border:1px solid #eee; padding:10px; border-radius:6px;"><h4>Floor Dimensions (constrains points)</h4><label>Width: <input id="floor-width" type="text" value="${this._esc(this._formatMetersForInput(floor.width || 10))}" placeholder="${this._floorplanUnits === "meters" ? "10.00" : "32' 10.0\" "}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in (e.g. 32' 10\")"}</small><br><label>Depth: <input id="floor-depth" type="text" value="${this._esc(this._formatMetersForInput(floor.depth || 8))}" placeholder="${this._floorplanUnits === "meters" ? "8.00" : "26' 3\" "}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br><label>Height: <input id="floor-height" type="text" value="${this._esc(this._formatMetersForInput(floor.height || 3))}" placeholder="${this._floorplanUnits === "meters" ? "3.00" : "9' 10\" "}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br><button id="dims-save">Save Dimensions</button><h4 style="margin-top:12px;">Floor Alignment</h4><label>Offset X: <input id="align-x" type="text" value="${this._esc(this._formatMetersForInput(floor.offset_x || 0))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br><label>Offset Y: <input id="align-y" type="text" value="${this._esc(this._formatMetersForInput(floor.offset_y || 0))}" style="width:110px"></label> <small>${this._floorplanUnits === "meters" ? "meters" : "ft/in"}</small><br><label>Scale: <input id="align-scale" type="number" step="0.1" value="${floor.scale || 1}" style="width:80px"></label><br><label>Rotation (deg): <input id="align-rot" type="number" step="1" value="${(((floor.rotation || 0) * 180 / Math.PI)).toFixed(1)}" style="width:80px"></label><br><button id="align-save">Save Alignment</button></div>
            <div style="border:1px solid #eee; padding:10px; border-radius:6px;"><h4>Points (${floor.points.length})</h4><div style="max-height:150px; overflow:auto;">${floor.points.map((p) => `<div style="padding:4px; background:${p.id === this._selectedPointId ? "#e3f2fd" : "transparent"}; border-radius:4px;">(${this._esc(this._formatMetersForInput(p.x))}, ${this._esc(this._formatMetersForInput(p.y))}) <button data-del-point="${this._esc(p.id)}" style="float:right;">Delete</button></div>`).join("")}</div><p><button id="point-add">Add Point at 0,0</button></p><p><label><input id="fp-snap" type="checkbox" ${this._fpSnapOn === false ? "" : "checked"}> Snap to grid</label> <input id="fp-snap-step" type="text" value="${this._esc(this._fpSnapStep || "0.1")}" style="width:70px"></p></div>
          </div>
        </div>
      `;
    }
};
