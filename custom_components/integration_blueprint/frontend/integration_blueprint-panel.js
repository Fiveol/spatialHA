/**
 * integration_blueprint Panel - WebSocket architecture (mirrors spatialHA)
 */
class IntegrationBlueprintPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._activeTab = "home";
    this._version = null;
    this._loading = false;
    this._error = null;
    this._hasFetched = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._activeTab === "about" && !this._hasFetched && !this._loading) {
      this._fetchVersion();
    }
  }

  connectedCallback() {
    this._render();
  }

  _switchTab(tab) {
    if (this._activeTab === tab) return;
    this._activeTab = tab;
    this._render();
    if (tab === "about" && !this._hasFetched && this._hass && !this._loading) {
      this._fetchVersion();
    }
  }

  async _fetchVersion() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    this._hasFetched = true;
    this._error = null;
    this._render();
    try {
      const result = await this._hass.callWS({ type: "integration_blueprint/get_version" });
      this._version = result.version;
      this._error = null;
    } catch (err) {
      this._error = err.message || String(err);
      this._version = null;
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _render() {
    const style = `
      :host { display: block; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
      .container { padding: 16px; max-width: 900px; margin: 0 auto; }
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
      .tab-content { padding: 16px 0; }
      .card {
        background: var(--card-background-color, white);
        border-radius: 8px; padding: 16px;
        box-shadow: var(--ha-card-box-shadow, 0 2px 4px rgba(0,0,0,0.1));
      }
      h1, h2 { margin-top: 0; }
      .version { font-size: 18px; font-weight: 500; }
      .loading { color: var(--secondary-text-color, #666); font-style: italic; }
      .error { color: var(--error-color, #db4437); }
    `;

    const homeContent = `
      <div class="card">
        <h1>This is the spatialHA panel</h1>
        <p>Welcome to integration_blueprint – Home tab</p>
      </div>
    `;

    let aboutInner = "";
    if (this._loading) {
      aboutInner = `<p class="loading">Loading version via WebSocket...</p>`;
    } else if (this._error) {
      aboutInner = `<p class="error">Error loading version: ${this._error}</p><p><button id="retry-btn">Retry</button></p>`;
    } else if (this._version !== null) {
      aboutInner = `<p class="version">Current version: ${this._version}</p>`;
    } else {
      aboutInner = `<p class="loading">No version loaded yet.</p>`;
    }

    const aboutContent = `
      <div class="card">
        <h2>About</h2>
        ${aboutInner}
      </div>
    `;

    this.shadowRoot.innerHTML = `
      <style>${style}</style>
      <div class="container">
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected="${this._activeTab === "home"}" data-tab="home" class="${this._activeTab === "home" ? "active" : ""}">Home</button>
          <button role="tab" aria-selected="${this._activeTab === "about"}" data-tab="about" class="${this._activeTab === "about" ? "active" : ""}">About</button>
        </div>
        <div class="tab-content">
          ${this._activeTab === "home" ? homeContent : aboutContent}
        </div>
      </div>
    `;

    this.shadowRoot.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
    });
    const retryBtn = this.shadowRoot.getElementById("retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        this._hasFetched = false;
        this._version = null;
        this._error = null;
        this._fetchVersion();
      });
    }
  }
}

customElements.define("integration_blueprint-panel", IntegrationBlueprintPanel);
if (!customElements.get("spatialHA-panel")) {
  class SpatialAlias extends IntegrationBlueprintPanel {}
  customElements.define("spatialHA-panel", SpatialAlias);
}
