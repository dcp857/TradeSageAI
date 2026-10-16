/**
 * Module      : app.js
 * Date        : 2026-09-03
 * Author      : Dhruv
 * Modification History:
 *     2026-09-03 - Added Theme manager (Dark/Light toggle with localStorage),
 *                  dynamic canvas theme re-rendering, and refined terminal controllers.
 *     2026-09-21 - [Fix #5] handleLoginSuccess now receives real token+userId
 *                  from the API response so X-User-Id header is always the
 *                  correct user, not the hardcoded fallback of 1.
 *                - [Fix #6] Market ribbon prices fetched live from /api/price/spot
 *                  on dashboard load instead of showing hardcoded stale values.
 * Synopsis    : Complete application controller for TradeSage AI trading terminal.
 */

const API_BASE = (function() {
  if (typeof window !== "undefined" && window.location && window.location.protocol.startsWith("http")) {
    if (window.location.port === "5000") return "";
    return `${window.location.protocol}//${window.location.hostname}:5000`;
  }
  return "http://localhost:5000";
})();

const State = {
  activeTab: "overview",
  authMode: "login",
  equityPoints: [],
  userEmail: null
};

/* --- THEME MANAGER (DARK / LIGHT TOGGLE) --- */
const Theme = {
  current: "dark",

  init() {
    const saved = localStorage.getItem("tradesage-theme");
    if (saved) {
      this.current = saved;
    } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      this.current = "light";
    } else {
      this.current = "dark";
    }
    this.apply(this.current);
  },

  toggle() {
    this.current = this.current === "dark" ? "light" : "dark";
    localStorage.setItem("tradesage-theme", this.current);
    this.apply(this.current);
  },

  apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("btn-themeToggle");
    if (btn) {
      btn.innerHTML = theme === "dark"
        ? `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
      btn.title = `Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`;
    }
    // Redraw chart if visible
    if (State.equityPoints && State.equityPoints.length > 0) {
      Backtest.drawChart(State.equityPoints);
    }
  }
};

/* --- TOAST MESSAGING --- */
const Toast = {
  show(message, type = "info", duration = 3500) {
    const stack = document.getElementById("toastStack");
    if (!stack) return;
    const msg = document.createElement("div");
    msg.className = `toast-msg ${type}`;
    msg.textContent = message;
    stack.appendChild(msg);

    setTimeout(() => {
      msg.style.opacity = "0";
      msg.style.transform = "translateX(10px)";
      msg.style.transition = "all 0.2s ease";
      setTimeout(() => msg.remove(), 200);
    }, duration);
  }
};

/* --- NETWORK API CLIENT --- */
const Api = {
  async fetch(path, options = {}) {
    try {
      const headers = {
        "Content-Type": "application/json",
        ...(options.headers || {})
      };

      const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        credentials: "include",
        headers
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.detail && !data.error) {
        data.error = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      }
      if (res.status === 401 && path !== "/api/login" && path !== "/api/register" && path !== "/api/portfolio" && path !== "/api/me") {
        localStorage.removeItem("tradesage_user");
        Toast.show("Session expired. Redirecting to login...", "info");
        const target = window.location.pathname.includes("/static/") ? "auth.html?mode=login" : "/auth?mode=login";
        setTimeout(() => { window.location.href = target; }, 800);
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, data: { error: `Server offline (${err.message})` } };
    }
  }
};

/* --- NAVIGATION & TAB ROUTING --- */
function switchTab(tabKey) {
  State.activeTab = tabKey;
  document.querySelectorAll(".term-tab").forEach(tab => tab.classList.remove("active"));
  document.querySelectorAll(".tab-workspace").forEach(view => view.classList.remove("active"));

  const targetTab = Array.from(document.querySelectorAll(".term-tab")).find(t => t.getAttribute("data-tab") === tabKey);
  if (targetTab) targetTab.classList.add("active");

  const targetView = document.getElementById(`tab-${tabKey}`);
  if (targetView) targetView.classList.add("active");

  if (tabKey === "backtest" && State.equityPoints.length > 0) {
    setTimeout(() => Backtest.drawChart(State.equityPoints), 50);
  }
}

/* --- MODAL CONTROLS --- */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("active");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("active");
}

const Auth = {
  gatewayMode: "login",

  toggleEye(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === "password") {
      input.type = "text";
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>`;
    } else {
      input.type = "password";
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>`;
    }
  },

  setGatewayMode(mode) {
    this.gatewayMode = mode;
    const submitBtn = document.getElementById("btn-gateSubmit");
    const title = document.getElementById("lbl-gatewayTitle");
    const desc = document.getElementById("lbl-gatewayDesc");
    const pillText = document.getElementById("lbl-gatewayPillText");
    const emailLabel = document.getElementById("lbl-gateEmailLabel");

    if (mode === "login") {
      if (pillText) pillText.textContent = "Secure Sign In";
      if (title) title.textContent = "Sign in to your account";
      if (desc) desc.textContent = "Welcome back! Please enter your details to continue.";
      if (emailLabel) emailLabel.textContent = "EMAIL ADDRESS";
      if (submitBtn) submitBtn.innerHTML = `<span>→ Sign In</span>`;
    } else {
      if (pillText) pillText.textContent = "Get Started";
      if (title) title.textContent = "Create your account";
      if (desc) desc.textContent = "Get started with smart port intelligence in under a minute.";
      if (emailLabel) emailLabel.textContent = "WORK EMAIL";
      if (submitBtn) submitBtn.innerHTML = `<span>→ Create Account</span>`;
    }
  },

  async submitGateway() {
    const email = document.getElementById("txt-gateEmail").value.trim();
    const password = document.getElementById("txt-gatePassword").value;
    if (!email || !password) {
      Toast.show("Please enter your email and password.", "error");
      return;
    }

    const path = this.gatewayMode === "login" ? "/api/login" : "/api/register";
    const { ok, data } = await Api.fetch(path, {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (!ok) {
      Toast.show(data.error || "Authentication failed. Please check credentials.", "error");
      return;
    }

    if (this.gatewayMode === "register") {
      Toast.show("Account registered! Connecting...", "success");
      const loginRes = await Api.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      if (loginRes.ok) this.handleLoginSuccess(loginRes.data.email, loginRes.data.userId);
    } else {
      this.handleLoginSuccess(data.email, data.userId);
    }
  },

  async checkDemoConfig() {
    const { ok, data } = await Api.fetch("/api/config");
    if (ok && data && data.demoEnabled) {
      const container = document.getElementById("gatewayDemoContainer");
      if (container) container.style.display = "block";
    }
  },

  async demoLogin() {
    const btn = document.getElementById("btnGatewayDemo");
    if (btn) btn.disabled = true;
    const { ok, data } = await Api.fetch("/api/demo-login", { method: "POST" });
    if (!ok) {
      Toast.show(data.error || "Demo login failed.", "error");
      if (btn) btn.disabled = false;
      return;
    }
    if (data && (data.email || data.userId)) {
      localStorage.setItem("tradesage_user", JSON.stringify(data));
    }
    Toast.show("Demo login successful! Loading terminal...", "success");
    setTimeout(() => { window.location.reload(); }, 400);
  },

  openModal() {
    this.setMode("login");
    openModal("modal-auth");
  },

  setMode(mode) {
    State.authMode = mode;
    const title = document.getElementById("lbl-authTitle");
    const submitBtn = document.getElementById("btn-authSubmit");
    const tabLogin = document.getElementById("btn-authTabLogin");
    const tabRegister = document.getElementById("btn-authTabRegister");

    if (mode === "login") {
      title.textContent = "Trader Login";
      submitBtn.textContent = "Sign In";
      tabLogin.classList.add("btn-primary");
      tabLogin.classList.remove("btn-subtle");
      tabRegister.classList.add("btn-subtle");
      tabRegister.classList.remove("btn-primary");
    } else {
      title.textContent = "Register New Account";
      submitBtn.textContent = "Register";
      tabRegister.classList.add("btn-primary");
      tabRegister.classList.remove("btn-subtle");
      tabLogin.classList.add("btn-subtle");
      tabLogin.classList.remove("btn-primary");
    }
  },

  async submit() {
    const email = document.getElementById("txt-authEmail").value.trim();
    const password = document.getElementById("txt-authPassword").value;
    if (!email || !password) {
      Toast.show("Please provide email and password.", "error");
      return;
    }

    const path = State.authMode === "login" ? "/api/login" : "/api/register";
    const { ok, data } = await Api.fetch(path, {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (!ok) {
      Toast.show(data.error || "Authentication failed.", "error");
      return;
    }

    if (State.authMode === "register") {
      Toast.show("Registered successfully. Logging in...", "success");
      const loginRes = await Api.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      if (loginRes.ok) this.handleLoginSuccess(loginRes.data.email, loginRes.data.userId);
    } else {
      this.handleLoginSuccess(data.email, data.userId);
    }
    closeModal("modal-auth");
  },

  handleLoginSuccess(email, userId) {
    State.userEmail = email;
    if (email) {
      // Only store email - do not store userId as auth credential.
      // Session identity is managed by Flask-Login session cookie (same-origin).
      localStorage.setItem("tradesage_user", JSON.stringify({ email, userId: null }));
    }
    document.getElementById("userPill").innerHTML = `Trader: <strong>${email}</strong>`;
    document.getElementById("btn-openAuth").style.display = "none";
    document.getElementById("btn-logout").style.display = "inline-flex";

    // Unlock Workspace & Hide Gateway Screen
    const gateway = document.getElementById("authGateway");
    const workspace = document.getElementById("mainWorkspace");
    if (gateway) gateway.style.display = "none";
    if (workspace) workspace.style.display = "block";

    Toast.show(`Connected as ${email}`, "success");
    loadAllTerminalData();
  },

  async logout() {
    await Api.fetch("/api/logout", { method: "POST" });
    State.userEmail = null;
    // Do not remove tradesage_user entirely so the email pill can still show
    // the last known email; the server will redirect unauthenticated users.
    document.getElementById("userPill").textContent = "Not Logged In";
    document.getElementById("btn-openAuth").style.display = "inline-flex";
    document.getElementById("btn-logout").style.display = "none";

    Toast.show("Terminal session ended. Redirecting to Landing Page...", "info");
    const target = window.location.pathname.includes("/static/") ? "index.html" : "/";
    setTimeout(() => { window.location.href = target; }, 400);
  }
};

/* --- PORTFOLIO MODULE (FR-2, FR-6.1) --- */
const Portfolio = {
  // _holdings: raw flat list from API (one entry per database row)
  // _grouped:  merged list (one entry per unique symbol) — used for rendering
  _holdings: [],
  _grouped:  [],

  // ---- Group flat holdings by symbol, computing weighted-average cost ----
  // Each group: { symbol, assetType, livePrice, lots[], totalQty,
  //               avgBuyPrice, totalCostBasis, totalCurrentValue,
  //               totalUnrealizedPnl, totalUnrealizedPnlPct }
  _groupHoldings(holdings) {
    const map = new Map(); // symbol -> group
    for (const h of holdings) {
      const key = h.assetSymbol;
      if (!map.has(key)) {
        map.set(key, {
          symbol: h.assetSymbol,
          assetType: h.assetType,
          livePrice: Number(h.livePrice),
          lots: [],
          totalQty: 0,
          totalCostBasis: 0,
        });
      }
      const g = map.get(key);
      const qty = Number(h.quantity);
      const bp  = Number(h.buyPrice);
      g.lots.push(h);            // keep the raw lot for lot-history table
      g.totalQty        += qty;
      g.totalCostBasis  += qty * bp;
      // live price is the same for all lots of the same symbol
      g.livePrice = Number(h.livePrice);
    }
    // Derive aggregate metrics for each group
    const groups = [];
    for (const g of map.values()) {
      g.avgBuyPrice           = g.totalQty > 0 ? g.totalCostBasis / g.totalQty : 0;
      g.totalCurrentValue     = g.totalQty * g.livePrice;
      g.totalUnrealizedPnl    = g.totalCurrentValue - g.totalCostBasis;
      g.totalUnrealizedPnlPct = g.totalCostBasis > 0
        ? (g.totalUnrealizedPnl / g.totalCostBasis) * 100 : 0;
      groups.push(g);
    }
    return groups;
  },

  async load() {
    const { ok, data } = await Api.fetch("/api/portfolio");
    if (!ok) return;

    const holdings = data.holdings || [];
    const totalPnl = data.totalPnl || 0;
    this._holdings = holdings;
    this._grouped  = this._groupHoldings(holdings);

    // Overview Metric Cell
    const totalPnlEl = document.getElementById("stat-totalPnl");
    totalPnlEl.textContent = `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`;
    totalPnlEl.className = `metric-data mono ${totalPnl >= 0 ? "val-pos" : "val-neg"}`;

    // Badge shows number of unique assets, not raw row count
    document.getElementById("tabCountHoldings").textContent = this._grouped.length;

    // Holdings Table
    const tbody = document.getElementById("tbl-holdings-body");
    if (this._grouped.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 24px;">No holdings recorded. Click "+ Add Position" to start.</td></tr>`;
      this.loadComparison();
      return;
    }

    // Shared formatters
    const fmt$ = v => {
      const n = Number(v);
      return n >= 1
        ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `$${n.toFixed(4)}`;
    };
    const fmtUnits = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 });

    let rows = "";
    this._grouped.forEach((g, idx) => {
      const isPos    = g.totalUnrealizedPnl >= 0;
      const pct      = g.totalUnrealizedPnlPct;
      const typeTag  = g.assetType === "crypto" ? "tag-crypto" : "tag-stock";
      const pctClass = isPos ? "val-pos" : "val-neg";
      const priceChg = g.livePrice - g.avgBuyPrice;
      const priceChgPct = g.avgBuyPrice > 0 ? (priceChg / g.avgBuyPrice) * 100 : 0;

      // Gain bar: capped at ±50% for visual clarity
      const barWidth = (Math.min(Math.abs(pct), 50) / 50) * 50;

      // Lot count badge — only show if >1 purchase
      const lotBadge = g.lots.length > 1
        ? `<span class="lot-badge" title="Recorded across ${g.lots.length} separate purchase transactions">${g.lots.length} purchases</span>`
        : "";

      // --- Summary row ---
      rows += `
        <tr class="holding-row" data-idx="${idx}" onclick="Portfolio.toggleExpand(${idx}, this)">
          <td class="td-toggle" id="toggle-${idx}">▶</td>
          <td><strong class="mono">${g.symbol}</strong> ${lotBadge}</td>
          <td><span class="tag ${typeTag}">${g.assetType}</span></td>
          <td class="mono">${fmtUnits(g.totalQty)}</td>
          <td class="mono">${fmt$(g.avgBuyPrice)}<span class="avg-label">avg</span></td>
          <td class="mono">${fmt$(g.livePrice)}</td>
          <td class="mono ${pctClass}" style="font-weight:700;">
            ${isPos ? "+" : ""}${pct.toFixed(2)}%
          </td>
          <td onclick="event.stopPropagation()">
            <div class="control-row">
              <button class="btn btn-primary btn-xs" onclick="Portfolio.showDetails(${idx})">Details</button>
            </div>
          </td>
        </tr>`;

      // --- Lot history rows (all individual purchases) ---
      const lotsTableRows = g.lots.map(lot => {
        const lotPnl    = (g.livePrice - Number(lot.buyPrice)) * Number(lot.quantity);
        const lotPnlPct = Number(lot.buyPrice) > 0
          ? ((g.livePrice - Number(lot.buyPrice)) / Number(lot.buyPrice)) * 100 : 0;
        const lotIsPos  = lotPnl >= 0;
        return `
          <tr class="lot-row">
            <td class="mono" style="color:var(--text-muted);">${lot.buyDate || "—"}</td>
            <td class="mono">${fmtUnits(lot.quantity)} units</td>
            <td class="mono">${fmt$(lot.buyPrice)}</td>
            <td class="mono ${lotIsPos ? 'val-pos' : 'val-neg'}">
              ${lotIsPos ? "+" : ""}${fmt$(lotPnl)}
              (${lotIsPos ? "+" : ""}${lotPnlPct.toFixed(2)}%)
            </td>
            <td style="text-align:right;">
              <button class="btn btn-danger-outline btn-xs"
                onclick="event.stopPropagation(); Portfolio.removePosition(${lot.holdingId}, '${lot.assetSymbol}')"
                title="Remove this lot">✕</button>
            </td>
          </tr>`;
      }).join("");

      // --- Expand row ---
      rows += `
        <tr class="holding-expand-row collapsed" id="expand-${idx}">
          <td colspan="8">
            <div class="expand-panel">
              <div class="expand-cell">
                <span class="expand-label">Total Cost Basis</span>
                <span class="expand-val">${fmt$(g.totalCostBasis)}</span>
              </div>
              <div class="expand-cell">
                <span class="expand-label">Current Value</span>
                <span class="expand-val ${pctClass}">${fmt$(g.totalCurrentValue)}</span>
              </div>
              <div class="expand-cell">
                <span class="expand-label">Unrealized P&amp;L ($)</span>
                <span class="expand-val ${pctClass}">${isPos ? "+" : ""}${fmt$(g.totalUnrealizedPnl)}</span>
              </div>
              <div class="expand-cell">
                <span class="expand-label">Avg Buy Price</span>
                <span class="expand-val">${fmt$(g.avgBuyPrice)}</span>
              </div>
              <div class="expand-cell">
                <span class="expand-label">Price Δ (Avg → Now)</span>
                <span class="expand-val ${priceChg >= 0 ? 'val-pos' : 'val-neg'}">
                  ${priceChg >= 0 ? "+" : ""}${fmt$(priceChg)}
                  (${priceChg >= 0 ? "+" : ""}${priceChgPct.toFixed(2)}%)
                </span>
              </div>
              <div class="expand-cell">
                <span class="expand-label">Purchases (Lots)</span>
                <span class="expand-val">${g.lots.length}</span>
              </div>

              <!-- Gain/loss bar -->
              <div class="expand-gain-wrap">
                <div class="expand-gain-labels">
                  <span>Max Loss Side</span>
                  <span class="expand-gain-center ${pctClass}">${isPos ? "+" : ""}${pct.toFixed(2)}%</span>
                  <span>Max Gain Side</span>
                </div>
                <div class="expand-gain-track">
                  <div class="expand-gain-fill ${isPos ? 'pos' : 'neg'}"
                    style="width:${barWidth.toFixed(1)}%;"></div>
                  <div class="expand-gain-pivot"></div>
                </div>
              </div>

              <!-- Purchase History Table -->
              <div class="expand-lot-section">
                <div class="expand-lot-title">Purchase History (${g.lots.length} purchase${g.lots.length !== 1 ? "s" : ""})</div>
                <table class="lot-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Quantity</th>
                      <th>Bought At</th>
                      <th>P&amp;L on this purchase</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>${lotsTableRows}</tbody>
                </table>
              </div>

              <!-- Quick actions -->
              <div class="expand-actions">
                <button class="btn btn-primary btn-xs"
                  onclick="Signals.quickAnalyze('${g.symbol}','${g.assetType}')">
                  ⚡ Signal Engine
                </button>
                <button class="btn btn-subtle btn-xs"
                  onclick="Portfolio.showDetails(${idx})">
                  Full Details →
                </button>
              </div>
            </div>
          </td>
        </tr>`;
    });

    tbody.innerHTML = rows;
    this.loadComparison();
  },

  // Toggle the inline expand row for a holding
  toggleExpand(idx) {
    const expandRow = document.getElementById(`expand-${idx}`);
    const toggle    = document.getElementById(`toggle-${idx}`);
    if (!expandRow) return;

    const isOpen = !expandRow.classList.contains("collapsed");
    if (isOpen) {
      expandRow.classList.add("collapsed");
      if (toggle) toggle.textContent = "▶";
    } else {
      document.querySelectorAll(".holding-expand-row:not(.collapsed)").forEach(r => {
        r.classList.add("collapsed");
      });
      document.querySelectorAll(".td-toggle").forEach(t => { t.textContent = "▶"; });
      expandRow.classList.remove("collapsed");
      if (toggle) toggle.textContent = "▼";
    }
  },

  // Open the full Position Detail modal — operates on the grouped entry
  showDetails(idx) {
    const g = this._grouped[idx];
    if (!g) return;

    const isPos    = g.totalUnrealizedPnl >= 0;
    const pct      = g.totalUnrealizedPnlPct;
    const priceChg = g.livePrice - g.avgBuyPrice;
    const priceChgPct = g.avgBuyPrice > 0 ? (priceChg / g.avgBuyPrice) * 100 : 0;
    const typeTag  = g.assetType === "crypto" ? "tag-crypto" : "tag-stock";
    const pctClass = isPos ? "val-pos" : "val-neg";

    const fmt$ = v => {
      const n = Number(v);
      return n >= 1
        ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `$${n.toFixed(4)}`;
    };
    const fmtUnits = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: 8 });

    // Populate modal header
    document.getElementById("lbl-posDetailTitle").textContent = `Position — ${g.symbol}`;
    document.getElementById("pd-symbol").textContent = g.symbol;
    const typeTagEl = document.getElementById("pd-typeTag");
    typeTagEl.textContent = g.assetType;
    typeTagEl.className = `tag ${typeTag}`;
    const pnlBadge = document.getElementById("pd-pnlBadge");
    pnlBadge.textContent = `${isPos ? "+" : ""}${pct.toFixed(2)}%`;
    pnlBadge.className   = `pos-detail-dir ${pctClass}`;

    // Metric grid — now shows merged/aggregate values
    document.getElementById("pd-units").textContent        = fmtUnits(g.totalQty);
    document.getElementById("pd-buyPrice").textContent     = `${fmt$(g.avgBuyPrice)} avg`;
    document.getElementById("pd-livePrice").textContent    = fmt$(g.livePrice);
    document.getElementById("pd-costBasis").textContent    = fmt$(g.totalCostBasis);
    document.getElementById("pd-currentValue").textContent = fmt$(g.totalCurrentValue);
    document.getElementById("pd-buyDate").textContent      = `${g.lots.length} purchase${g.lots.length !== 1 ? "s" : ""}`;

    const pnlDollarEl = document.getElementById("pd-pnlDollar");
    pnlDollarEl.textContent = `${isPos ? "+" : ""}${fmt$(g.totalUnrealizedPnl)}`;
    pnlDollarEl.className   = `pos-detail-val mono ${pctClass}`;

    const priceChgEl = document.getElementById("pd-priceChange");
    priceChgEl.textContent = `${priceChg >= 0 ? "+" : ""}${fmt$(priceChg)} (${priceChg >= 0 ? "+" : ""}${priceChgPct.toFixed(2)}%)`;
    priceChgEl.className   = `pos-detail-val mono ${priceChg >= 0 ? "val-pos" : "val-neg"}`;

    document.getElementById("pd-breakEven").textContent = fmt$(g.avgBuyPrice);

    // Gain bar
    const barWidth = (Math.min(Math.abs(pct), 50) / 50) * 50;
    const fillEl   = document.getElementById("pd-gainFill");
    fillEl.style.width = `${barWidth.toFixed(1)}%`;
    fillEl.className   = `pos-gain-fill ${isPos ? "pos" : "neg"}`;
    document.getElementById("pd-gainLabel").textContent = `${isPos ? "+" : ""}${pct.toFixed(2)}%`;
    document.getElementById("pd-gainLabel").className = pctClass;

    // Purchase history lot table inside modal
    const lotsHtml = g.lots.map(lot => {
      const lotPnl    = (g.livePrice - Number(lot.buyPrice)) * Number(lot.quantity);
      const lotPnlPct = Number(lot.buyPrice) > 0
        ? ((g.livePrice - Number(lot.buyPrice)) / Number(lot.buyPrice)) * 100 : 0;
      const lotIsPos  = lotPnl >= 0;
      return `
        <tr class="lot-row">
          <td class="mono" style="color:var(--text-muted);">${lot.buyDate || "—"}</td>
          <td class="mono">${fmtUnits(lot.quantity)}</td>
          <td class="mono">${fmt$(lot.buyPrice)}</td>
          <td class="mono ${lotIsPos ? 'val-pos' : 'val-neg'}">
            ${lotIsPos ? "+" : ""}${fmt$(lotPnl)}
            (${lotIsPos ? "+" : ""}${lotPnlPct.toFixed(2)}%)
          </td>
          <td style="text-align:right;">
            <button class="btn btn-danger-outline btn-xs"
              onclick="closeModal('modal-posDetail'); Portfolio.removePosition(${lot.holdingId}, '${lot.assetSymbol}')"
              title="Remove this lot">✕</button>
          </td>
        </tr>`;
    }).join("");

    // Inject lot history into modal (replace pd-buyDate row with lot table)
    let lotsSection = document.getElementById("pd-lotsSection");
    if (!lotsSection) {
      // Create it once, insert after the gain bar wrap
      lotsSection = document.createElement("div");
      lotsSection.id = "pd-lotsSection";
      lotsSection.className = "pd-lots-wrap";
      const gainBar = document.querySelector("#modal-posDetail .pos-gain-bar-wrap");
      if (gainBar) gainBar.insertAdjacentElement("afterend", lotsSection);
    }
    lotsSection.innerHTML = `
      <div class="pd-lots-title">Purchase History — ${g.lots.length} purchase${g.lots.length !== 1 ? "s" : ""}</div>
      <table class="lot-table">
        <thead>
          <tr><th>Date</th><th>Qty</th><th>Bought At</th><th>P&amp;L on Purchase</th><th></th></tr>
        </thead>
        <tbody>${lotsHtml}</tbody>
      </table>`;

    // Wire action buttons
    document.getElementById("pd-btnSignal").onclick = () => {
      closeModal("modal-posDetail");
      Signals.quickAnalyze(g.symbol, g.assetType);
    };
    // Remove all lots = remove entire position
    document.getElementById("pd-btnRemove").onclick = () => {
      if (!confirm(`Remove ALL ${g.lots.length} lot(s) of ${g.symbol}?`)) return;
      closeModal("modal-posDetail");
      Promise.all(g.lots.map(lot =>
        Api.fetch(`/api/holdings/${lot.holdingId}`, { method: "DELETE" })
      )).then(() => {
        Toast.show(`All ${g.symbol} positions removed.`, "info");
        Portfolio.load();
      });
    };

    openModal("modal-posDetail");
  },

  async removePosition(holdingId, symbol) {
    if (!confirm(`Remove ${symbol} position from your portfolio ledger?`)) return;
    const { ok, data } = await Api.fetch(`/api/holdings/${holdingId}`, { method: "DELETE" });
    if (ok) {
      Toast.show(`Position ${symbol} removed.`, "info");
      this.load();
    } else {
      Toast.show(data.error || "Failed to remove position.", "error");
    }
  },

  async loadComparison() {
    const { ok, data } = await Api.fetch("/api/portfolio/comparison");
    if (!ok) return;

    if (data.stock) {
      const pnl = data.stock.totalPnl || 0;
      const el = document.getElementById("stat-stockPnl");
      el.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
      el.className = `metric-data mono ${pnl >= 0 ? "val-pos" : "val-neg"}`;
      document.getElementById("stat-stockCount").textContent = `${data.stock.holdingCount} position(s)`;
    }

    if (data.crypto) {
      const pnl = data.crypto.totalPnl || 0;
      const el = document.getElementById("stat-cryptoPnl");
      el.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
      el.className = `metric-data mono ${pnl >= 0 ? "val-pos" : "val-neg"}`;
      document.getElementById("stat-cryptoCount").textContent = `${data.crypto.holdingCount} position(s)`;
    }
  },

  searchDebounceTimer: null,
  currentSpotPrice: null,

  openAddModal() {
    const today = new Date().toISOString().split("T")[0];
    const dateInput = document.getElementById("txt-holdDate");
    if (dateInput) {
      dateInput.value = today;
      dateInput.max = today;
    }
    document.getElementById("txt-holdSymbol").value = "";
    document.getElementById("txt-holdQty").value = "";
    document.getElementById("txt-holdPrice").value = "";
    document.getElementById("box-holdSpotPrice").style.display = "none";
    document.getElementById("dropdown-holdSuggestions").style.display = "none";
    const hint = document.getElementById("hint-priceAutoSet");
    if (hint) hint.style.display = "none";
    openModal("modal-addHolding");
    // Show initial top asset suggestions
    this.onSymbolInput("");
  },

  onSymbolInput(query) {
    clearTimeout(this.searchDebounceTimer);
    const dropdown = document.getElementById("dropdown-holdSuggestions");
    if (!dropdown) return;

    this.searchDebounceTimer = setTimeout(async () => {
      const q = query.trim().toLowerCase();
      const { ok, data } = await Api.fetch(`/api/assets/search?q=${encodeURIComponent(q)}`);
      if (!ok || !data || data.length === 0) {
        dropdown.style.display = "none";
        return;
      }

      dropdown.innerHTML = data.map(item => `
        <div class="suggestion-item" onclick="Portfolio.selectAsset('${item.symbol}', '${item.type}', '${item.name.replace(/'/g, "\\'")}')">
          <div class="suggestion-item-main">
            <span class="suggestion-sym">${item.symbol}</span>
            <span class="suggestion-name">${item.name}</span>
          </div>
          <span class="tag ${item.type === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${item.type}</span>
        </div>
      `).join("");
      dropdown.style.display = "block";

      // If user typed an exact symbol, fetch spot price directly
      const exactMatch = data.find(item => item.symbol.toLowerCase() === q);
      if (exactMatch) {
        this.fetchLivePrice(exactMatch.symbol, exactMatch.type);
      }
    }, 180);
  },

  selectAsset(symbol, type, name) {
    document.getElementById("txt-holdSymbol").value = symbol;
    document.getElementById("cmb-holdType").value = type;
    document.getElementById("dropdown-holdSuggestions").style.display = "none";
    this.fetchLivePrice(symbol, type);
  },

  fetchLivePriceForCurrentInput() {
    const symbol = document.getElementById("txt-holdSymbol").value.trim().toUpperCase();
    const type = document.getElementById("cmb-holdType").value;
    if (symbol) {
      this.fetchLivePrice(symbol, type);
    }
  },

  async fetchLivePrice(symbol, type) {
    const banner = document.getElementById("box-holdSpotPrice");
    const valEl = document.getElementById("lbl-holdSpotPrice");
    const priceInput = document.getElementById("txt-holdPrice");
    const hint = document.getElementById("hint-priceAutoSet");

    banner.style.display = "flex";
    valEl.textContent = "Fetching live price...";

    const { ok, data } = await Api.fetch(`/api/price/spot?assetSymbol=${encodeURIComponent(symbol)}&assetType=${type}`);
    if (ok && data.price !== undefined) {
      this.currentSpotPrice = data.price;
      const formatted = data.price >= 1 ? `$${data.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${data.price.toFixed(4)}`;
      valEl.textContent = formatted;
      // Pre-fill purchase price input if empty or matching prior fetched price
      if (!priceInput.value || priceInput.dataset.autoFilled === "true") {
        priceInput.value = data.price >= 1 ? data.price.toFixed(2) : data.price.toFixed(4);
        priceInput.dataset.autoFilled = "true";
        if (hint) hint.style.display = "inline";
      }
    } else {
      valEl.textContent = "Price unavailable";
    }
  },

  useCurrentPrice() {
    if (this.currentSpotPrice !== null) {
      const priceInput = document.getElementById("txt-holdPrice");
      priceInput.value = this.currentSpotPrice >= 1 ? this.currentSpotPrice.toFixed(2) : this.currentSpotPrice.toFixed(4);
      priceInput.dataset.autoFilled = "true";
      const hint = document.getElementById("hint-priceAutoSet");
      if (hint) hint.style.display = "inline";
      Toast.show(`Updated purchase price to current market spot ($${priceInput.value})`, "info", 2000);
    }
  },

  async submitAdd() {
    const symbol = document.getElementById("txt-holdSymbol").value.trim().toUpperCase();
    const assetType = document.getElementById("cmb-holdType").value;
    const quantity = parseFloat(document.getElementById("txt-holdQty").value);
    const buyPrice = parseFloat(document.getElementById("txt-holdPrice").value);
    const buyDate = document.getElementById("txt-holdDate").value;

    if (!symbol || !buyDate || Number.isNaN(quantity) || Number.isNaN(buyPrice)) {
      Toast.show("Please enter valid position details.", "error");
      return;
    }

    if (quantity <= 0) {
      Toast.show("Quantity must be greater than zero.", "error");
      return;
    }

    if (buyPrice <= 0) {
      Toast.show("Purchase price must be greater than zero.", "error");
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    if (buyDate > today) {
      Toast.show("Execution date cannot be in the future.", "error");
      return;
    }

    const { ok, data } = await Api.fetch("/api/holdings", {
      method: "POST",
      body: JSON.stringify({ assetSymbol: symbol, assetType, quantity, buyPrice, buyDate })
    });

    if (!ok) {
      Toast.show(data.error || "Failed to record holding.", "error");
      return;
    }

    Toast.show(`Recorded position for ${symbol}`, "success");
    closeModal("modal-addHolding");
    document.getElementById("txt-holdSymbol").value = "";
    document.getElementById("txt-holdQty").value = "";
    document.getElementById("txt-holdPrice").value = "";
    document.getElementById("box-holdSpotPrice").style.display = "none";
    document.getElementById("dropdown-holdSuggestions").style.display = "none";
    this.load();
  },

  openCsvModal() {
    openModal("modal-csv");
  },

  async submitCsv() {
    const fileInput = document.getElementById("file-csvUpload");
    if (!fileInput.files.length) {
      Toast.show("Select a CSV file first.", "error");
      return;
    }

    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    try {
      const res = await fetch(`${API_BASE}/api/holdings/import`, {
        method: "POST",
        credentials: "include",
        body: formData
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        Toast.show(data.error || "Import error", "error");
        return;
      }
      Toast.show(`Imported ${data.imported} position(s)`, "success");
      closeModal("modal-csv");
      fileInput.value = "";
      this.load();
    } catch (err) {
      Toast.show(`Import failed: ${err.message}`, "error");
    }
  },

  reset() {
    document.getElementById("stat-totalPnl").textContent = "—";
    document.getElementById("stat-stockPnl").textContent = "—";
    document.getElementById("stat-cryptoPnl").textContent = "—";
    document.getElementById("tbl-holdings-body").innerHTML = `
      <tr><td colspan="8" style="text-align: center; color: var(--text-dim); padding: 24px;">Log in to access your positions.</td></tr>
    `;
    document.getElementById("tabCountHoldings").textContent = "0";
  }
};

/* --- AI SIGNAL ENGINE & DIVERGENCE DETECTOR (FR-3) --- */
const Signals = {
  _searchDebounce: null,

  quickAnalyze(symbol, type) {
    document.getElementById("txt-signalSymbol").value = symbol;
    document.getElementById("cmb-signalType").value = type || "stock";
    document.getElementById("dropdown-signalSuggestions").style.display = "none";
    switchTab("signal");
    this.generate();
  },

  // ---- Asset search dropdown (mirrors Portfolio.onSymbolInput) ----
  onSymbolInput(query) {
    clearTimeout(this._searchDebounce);
    const dropdown = document.getElementById("dropdown-signalSuggestions");
    if (!dropdown) return;

    this._searchDebounce = setTimeout(async () => {
      const q = (query || "").trim().toLowerCase();
      const { ok, data } = await Api.fetch(`/api/assets/search?q=${encodeURIComponent(q)}`);
      if (!ok || !data || data.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.innerHTML = data.map(item => `
        <div class="suggestion-item"
          onclick="Signals.selectAsset('${item.symbol}', '${item.type}', '${item.name.replace(/'/g, "\\'")}')">
          <div class="suggestion-item-main">
            <span class="suggestion-sym">${item.symbol}</span>
            <span class="suggestion-name">${item.name}</span>
          </div>
          <span class="tag ${item.type === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${item.type}</span>
        </div>
      `).join("");
      dropdown.style.display = "block";
    }, 160);
  },

  selectAsset(symbol, type) {
    document.getElementById("txt-signalSymbol").value = symbol;
    document.getElementById("cmb-signalType").value = type;
    document.getElementById("dropdown-signalSuggestions").style.display = "none";
  },

  // ---- Loading state helpers ----
  _STEPS: [
    "Fetching historical price data",
    "Computing technical indicators",
    "Training Random Forest model",
    "Training Shallow LSTM model",
    "Running SHAP explainability",
  ],

  _showLoader(symbol) {
    const container = document.getElementById("modelsMatrix");
    const stepsHtml = this._STEPS.map((label, i) => `
      <div class="sig-step" id="sig-step-${i}">
        <span class="sig-step-icon"></span>
        <span>${label}</span>
      </div>
    `).join("");

    container.innerHTML = `
      <div class="sig-loading-panel">
        <div class="sig-spinner-ring"></div>
        <div class="sig-loading-label">Analysing ${symbol}</div>
        <div class="sig-loading-sub">Cold start may take ~15–20 s on first run per asset</div>
        <div class="sig-steps">${stepsHtml}</div>
      </div>
    `;
    // Activate the first step immediately
    this._advanceStep(0);
  },

  _stepTimer: null,
  _currentStep: 0,

  _advanceStep(idx) {
    clearTimeout(this._stepTimer);
    // Mark previous steps done
    for (let i = 0; i < idx; i++) {
      const el = document.getElementById(`sig-step-${i}`);
      if (el) { el.classList.remove("active"); el.classList.add("done"); }
    }
    // Mark current step active
    const cur = document.getElementById(`sig-step-${idx}`);
    if (cur) { cur.classList.add("active"); }

    // Schedule next step advance if not last
    // Approximate timings: prices ~2s, features ~1s, RF ~5s, LSTM ~8s, SHAP ~3s
    const delays = [2000, 3000, 8000, 16000, 19000];
    if (idx < this._STEPS.length - 1) {
      this._stepTimer = setTimeout(() => {
        this._advanceStep(idx + 1);
      }, delays[idx]);
    }
  },

  _allStepsDone() {
    clearTimeout(this._stepTimer);
    for (let i = 0; i < this._STEPS.length; i++) {
      const el = document.getElementById(`sig-step-${i}`);
      if (el) { el.classList.remove("active"); el.classList.add("done"); }
    }
  },

  // ---- Main generate call ----
  async generate() {
    const symbol = document.getElementById("txt-signalSymbol").value.trim().toUpperCase();
    const assetType = document.getElementById("cmb-signalType").value;
    const btn = document.getElementById("btn-genSignals");
    const divAlert = document.getElementById("divergenceAlert");

    if (!symbol) {
      Toast.show("Search for and select an asset first.", "error");
      return;
    }

    // Close dropdown if still open
    document.getElementById("dropdown-signalSuggestions").style.display = "none";

    btn.disabled = true;
    divAlert.style.display = "none";

    // Show animated loading state immediately — user knows something is happening
    this._showLoader(symbol);

    const { ok, data } = await Api.fetch(
      `/api/signal?assetSymbol=${encodeURIComponent(symbol)}&assetType=${assetType}`
    );

    this._allStepsDone();
    btn.disabled = false;

    if (!ok) {
      const container = document.getElementById("modelsMatrix");
      container.innerHTML = `
        <div class="sig-error-cell">
          <strong>Signal generation failed</strong><br>
          <span style="font-size:12px; opacity:0.85;">${data.error || "Unknown error — check server logs."}</span>
        </div>`;
      Toast.show(data.error || "Signal generation error.", "error");
      return;
    }

    Toast.show(`Signals ready for ${symbol}`, "success");
    this.renderMatrix(data.signals, symbol, data.newsMood);
    Watchlist.load();
  },

  // ---- Plain-English translations for feature names ----
  _featureExplain(featureName, contribution, verdictDir) {
    const pos = contribution >= 0;
    const map = {
      rsi: pos
        ? "The momentum indicator (RSI) shows the asset still has room to grow — it is not overbought yet."
        : "The momentum indicator (RSI) is in overbought territory, which often precedes a pullback.",
      macd: pos
        ? "The MACD trend line has crossed upward — a classic buy signal in technical analysis."
        : "The MACD trend line has crossed downward — a sign the short-term momentum is fading.",
      sma: pos
        ? "The current price is trading above its 20-day average, showing an upward trend."
        : "The current price has fallen below its 20-day average, suggesting the trend is turning down.",
      volumeChange: pos
        ? "Trading volume has increased, confirming that buyers are actively participating."
        : "Trading volume has dropped off, suggesting weaker conviction in recent price moves.",
    };
    return map[featureName] || (pos
      ? `The ${featureName} factor is pushing the signal in a favourable direction.`
      : `The ${featureName} factor is pushing the signal in an unfavourable direction.`);
  },


  // ---- Compute single consensus verdict from all signals ----
  _computeVerdict(signals) {
    if (!signals || signals.length === 0) return null;

    // Weight each model's vote by its confidence score
    const scores = { up: 0, down: 0, neutral: 0 };
    for (const s of signals) {
      const dir = (s.predictedDirection || "neutral").toLowerCase();
      const conf = Number(s.confidenceScore) || 0;
      scores[dir] = (scores[dir] || 0) + conf;
    }

    // Check if all models agree
    const nonZero = Object.entries(scores).filter(([, v]) => v > 0);
    const allAgree = nonZero.length === 1;
    const totalWeight = signals.reduce((a, s) => a + (Number(s.confidenceScore) || 0), 0);
    const avgConf = totalWeight / signals.length;

    // Dominant direction = highest weighted vote
    const dominant = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];

    // If models disagree AND avg confidence is below 55%, call it uncertain
    const uncertain = !allAgree && avgConf < 0.55;

    return {
      direction: uncertain ? "uncertain" : dominant,
      agree: allAgree,
      avgConfidence: avgConf,
      scores,
      uncertain,
    };
  },

  // ---- Build the plain-English summary sentence ----
  _buildSummaryText(verdict, symbol, horizonDays) {
    const h = horizonDays || 3;
    const asset = symbol || "this asset";
    if (verdict.uncertain) {
      return `The two AI models disagree on <strong>${asset}</strong> right now. One points up, the other points down. This means the market signals are mixed — it is best to <strong>wait and watch</strong> rather than act immediately.`;
    }
    const dirText = {
      up:      `likely to <strong>go up</strong> over the next ${h} days`,
      down:    `likely to <strong>go down</strong> over the next ${h} days`,
      neutral: `likely to stay <strong>flat (no major move)</strong> over the next ${h} days`,
    }[verdict.direction] || "unclear";

    const confLabel = verdict.avgConfidence >= 0.70 ? "high confidence"
      : verdict.avgConfidence >= 0.55 ? "moderate confidence"
      : "low confidence";

    return `The AI models are saying <strong>${asset}</strong> is ${dirText}. Both models ${verdict.agree ? "agree" : "lean in this direction"} with <strong>${confLabel}</strong> (${Math.round(verdict.avgConfidence * 100)}%).`;
  },

  // ---- Toggle technical details visibility ----
  toggleTechDetail() {
    const section = document.getElementById("sig-tech-section");
    const btn     = document.getElementById("sig-tech-toggle-btn");
    if (!section || !btn) return;
    const isOpen = section.classList.contains("open");
    section.classList.toggle("open", !isOpen);
    btn.textContent = isOpen
      ? "▸ Show Technical Details (for advanced users)"
      : "▾ Hide Technical Details";
  },

  renderMatrix(signals, symbol, newsMood) {
    const container = document.getElementById("modelsMatrix");
    const divAlert  = document.getElementById("divergenceAlert");
    // Always hide the old divergence bar — verdict card replaces it
    divAlert.style.display = "none";
    container.innerHTML = "";

    if (!signals || signals.length === 0) {
      container.innerHTML = `<div class="matrix-cell" style="grid-column: 1 / -1; text-align: center;">No signals generated.</div>`;
      return;
    }

    const verdict    = this._computeVerdict(signals);
    const horizonDays = signals[0].horizonDays || 3;
    const vDir       = verdict.direction; // up | down | neutral | uncertain
    const summaryText = this._buildSummaryText(verdict, symbol, horizonDays);
    const avgConfPct  = Math.round(verdict.avgConfidence * 100);

    // --- News mood context indicator (Task 1d: context only, not used by models) ---
    let newsMoodHtml = "";
    if (newsMood) {
      const isDegraded = (newsMood.status || "").startsWith("degraded");
      const label = (newsMood.label || "neutral").toUpperCase();
      const scoreVal = Number(newsMood.score) || 0;
      const scoreStr = (scoreVal >= 0 ? "+" : "") + scoreVal.toFixed(2);
      const moodClass = isDegraded ? "degraded" : (newsMood.label || "neutral").toLowerCase();
      const chipText = isDegraded
        ? "News mood unavailable"
        : `News mood: ${label} (${scoreStr})`;
      newsMoodHtml = `
        <div class="news-mood-block">
          <span class="news-mood-chip chip-${moodClass}">${chipText}</span>
          <span class="news-mood-caption">Shown for context only. Not used by the models.</span>
        </div>`;
    }

    // --- Model agreement chips ---
    const modelChips = signals.map(s => {
      const d = (s.predictedDirection || "neutral").toLowerCase();
      const label = s.modelUsed === "lstm" ? "Neural Net (LSTM)" : "Decision Trees (RF)";
      const conf  = Math.round((s.confidenceScore || 0) * 100);
      return `<span class="verdict-model-chip">${label}: <span class="chip-dir ${d}">${d.toUpperCase()}</span> · ${conf}% sure</span>`;
    }).join("");

    // --- Top contributing factors in plain English (deduplicate across models) ---
    const seenFeatures = new Set();
    const allFactors = [];
    for (const s of signals) {
      for (const f of (s.topContributingFeatures || [])) {
        if (!seenFeatures.has(f.feature) && Math.abs(f.contribution) > 0.001) {
          seenFeatures.add(f.feature);
          allFactors.push({ feature: f.feature, contribution: f.contribution });
        }
      }
    }
    // Sort by absolute contribution, take top 3
    allFactors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    const topFactors = allFactors.slice(0, 3);

    const factorItems = topFactors.map(f => {
      const pos = f.contribution >= 0;
      const dotClass = pos ? "pos" : "neg";
      return `
        <div class="verdict-factor-item">
          <span class="verdict-factor-dot ${dotClass}"></span>
          <span>${this._featureExplain(f.feature, f.contribution, vDir)}</span>
        </div>`;
    }).join("") || `<div class="verdict-factor-item"><span class="verdict-factor-dot neu"></span><span>No key factors identified for this signal.</span></div>`;

    // --- Action recommendation text ---
    const actionMap = {
      up:        "Consider it a <strong>potential buying opportunity</strong>, but always do your own research.",
      down:      "This could be a <strong>good time to be cautious</strong> — avoid buying and consider protecting existing positions.",
      neutral:   "The AI sees <strong>no strong reason to buy or sell</strong> right now. Holding is a reasonable choice.",
      uncertain: "When signals conflict, the safest move is to <strong>do nothing and wait</strong> for clarity.",
    };
    const actionText = actionMap[vDir] || "";

    // ================================================================
    //  BUILD THE VERDICT CARD (full-width, above tech detail)
    // ================================================================
    const verdictCardHtml = `
      <div class="verdict-card verdict-${vDir}" style="grid-column: 1 / -1;">
        <div class="verdict-top">
          <div>
            <div class="verdict-asset-label">AI Signal Analysis</div>
            <div class="verdict-asset-name">${symbol}</div>
            ${newsMoodHtml}
          </div>
          <div class="verdict-pill">
            <div class="verdict-pill-label">Overall Verdict</div>
            <div class="verdict-badge ${vDir}">${
              vDir === "up" ? "▲ LIKELY UP"
              : vDir === "down" ? "▼ LIKELY DOWN"
              : vDir === "neutral" ? "— HOLD / FLAT"
              : "? UNCERTAIN"
            }</div>
          </div>
        </div>


        <!-- Plain-English summary -->
        <div class="verdict-summary-text">${summaryText} ${actionText}</div>

        <!-- Confidence meter -->
        <div class="verdict-conf-wrap">
          <div class="verdict-conf-label">
            <span>AI Confidence Level</span>
            <strong>${avgConfPct}%</strong>
          </div>
          <div class="verdict-conf-track">
            <div class="verdict-conf-fill ${vDir}" style="width: ${avgConfPct}%;"></div>
          </div>
        </div>

        <!-- Which models said what -->
        <div class="verdict-models-row">${modelChips}</div>

        <!-- Top factors in plain English -->
        <div class="verdict-factors">
          <div class="verdict-factors-title">Why the AI thinks this (in plain words)</div>
          ${factorItems}
        </div>

        <!-- Disclaimer -->
        <div class="verdict-disclaimer">
          ⚠ This is AI-generated decision support, not financial advice. Never invest solely based on these signals. Always consider your own research and risk tolerance.
        </div>

        <!-- Toggle to expand technical cards -->
        <div class="verdict-toggle-row">
          <button class="verdict-toggle-btn" id="sig-tech-toggle-btn"
            onclick="Signals.toggleTechDetail()">
            ▸ Show Technical Details (for advanced users)
          </button>
        </div>
      </div>`;

    // ================================================================
    //  BUILD TECHNICAL MODEL CARDS (collapsible, hidden by default)
    // ================================================================
    const techCards = signals.map(s => {
      const isLstm   = s.modelUsed === "lstm";
      const modelName = isLstm ? "Shallow LSTM (Deep Neural Net)" : "Random Forest (Baseline)";
      const dir       = (s.predictedDirection || "neutral").toLowerCase();
      const confPct   = Math.round((s.confidenceScore || 0) * 100);

      const maxContr = Math.max(...(s.topContributingFeatures || []).map(f => Math.abs(f.contribution)), 0.001);
      const shapItems = (s.topContributingFeatures || []).map(f => {
        const val   = f.contribution;
        const isPos = val >= 0;
        const pct   = Math.min(Math.round((Math.abs(val) / maxContr) * 100), 100);
        return `
          <div class="shap-row">
            <span class="shap-label" title="${f.feature}">${f.feature}</span>
            <div class="shap-track">
              <div class="shap-bar ${isPos ? 'pos' : 'neg'}" style="width: ${pct}%;"></div>
            </div>
            <span class="mono ${isPos ? 'val-pos' : 'val-neg'}" style="text-align: right;">${isPos ? '+' : ''}${val.toFixed(3)}</span>
          </div>`;
      }).join("");

      return `
        <div class="matrix-cell">
          <div class="matrix-head">
            <span class="model-title">${modelName}</span>
            <span class="model-spec mono">${s.horizonDays}D Horizon</span>
          </div>
          <div class="signal-callout">
            <div>
              <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Directional Bias</div>
              <div class="callout-dir ${dir}">${dir.toUpperCase()}</div>
            </div>
            <div style="text-align: right;">
              <div style="font-size: 11px; color: var(--text-dim); text-transform: uppercase;">Confidence</div>
              <div class="mono" style="font-size: 18px; font-weight: 700;">${confPct}%</div>
            </div>
          </div>
          <div class="shap-box">
            <div class="shap-legend"><span>SHAP Factor Impact</span><span>Weight</span></div>
            ${shapItems || '<span style="color:var(--text-dim); font-size:12px;">No feature attribution.</span>'}
          </div>
        </div>`;
    }).join("");

    // Inject everything: verdict card + collapsible tech wrapper
    container.innerHTML = `
      ${verdictCardHtml}
      <div class="tech-detail-section" id="sig-tech-section" style="grid-column: 1 / -1;">
        <div class="models-matrix" style="margin-top: 0;">
          ${techCards}
        </div>
      </div>`;
  }
};

/* --- STRATEGY BACKTESTER MODULE (FR-4) --- */
const Backtest = {
  _searchDebounce: null,

  // ---- Asset search dropdown (identical UX to Signal Engine & Portfolio) ----
  onSymbolInput(query) {
    clearTimeout(this._searchDebounce);
    const dropdown = document.getElementById("dropdown-backtestSuggestions");
    if (!dropdown) return;

    this._searchDebounce = setTimeout(async () => {
      const q = (query || "").trim().toLowerCase();
      const { ok, data } = await Api.fetch(`/api/assets/search?q=${encodeURIComponent(q)}`);
      if (!ok || !data || data.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.innerHTML = data.map(item => `
        <div class="suggestion-item"
          onclick="Backtest.selectAsset('${item.symbol}', '${item.type}', '${item.name.replace(/'/g, "\\'")}')">
          <div class="suggestion-item-main">
            <span class="suggestion-sym">${item.symbol}</span>
            <span class="suggestion-name">${item.name}</span>
          </div>
          <span class="tag ${item.type === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${item.type}</span>
        </div>
      `).join("");
      dropdown.style.display = "block";
    }, 160);
  },

  selectAsset(symbol, type) {
    document.getElementById("txt-backtestSymbol").value = symbol;
    document.getElementById("cmb-backtestType").value = type;
    document.getElementById("dropdown-backtestSuggestions").style.display = "none";
  },

  // ---- Loading state helpers (identical UX to Signal Engine) ----
  _STEPS: [
    "Fetching historical price & candle feed",
    "Initializing feature pipeline & indicators",
    "Executing walk-forward strategy model inference",
    "Computing Annualized Sharpe, Win Rate & Drawdown",
    "Compiling cumulative mark-to-market equity curve",
  ],

  _stepTimer: null,

  _showLoader(symbol, modelName) {
    const loadingArea = document.getElementById("backtestLoadingArea");
    const resultsArea = document.getElementById("backtestResultsArea");
    if (resultsArea) resultsArea.style.display = "none";
    if (!loadingArea) return;

    const stepsHtml = this._STEPS.map((label, i) => `
      <div class="sig-step" id="bt-step-${i}">
        <span class="sig-step-icon"></span>
        <span>${label}</span>
      </div>
    `).join("");

    loadingArea.innerHTML = `
      <div class="sig-loading-panel">
        <div class="sig-spinner-ring"></div>
        <div class="sig-loading-label">Backtesting Strategy for ${symbol}</div>
        <div class="sig-loading-sub">Simulating historical walk-forward execution (${modelName})</div>
        <div class="sig-steps">${stepsHtml}</div>
      </div>
    `;
    loadingArea.style.display = "block";
    this._advanceStep(0);
  },

  _advanceStep(idx) {
    clearTimeout(this._stepTimer);
    for (let i = 0; i < idx; i++) {
      const el = document.getElementById(`bt-step-${i}`);
      if (el) { el.classList.remove("active"); el.classList.add("done"); }
    }
    const cur = document.getElementById(`bt-step-${idx}`);
    if (cur) { cur.classList.add("active"); }

    const delays = [1500, 2500, 4500, 6000];
    if (idx < this._STEPS.length - 1) {
      this._stepTimer = setTimeout(() => {
        this._advanceStep(idx + 1);
      }, delays[idx] || 2000);
    }
  },

  _allStepsDone() {
    clearTimeout(this._stepTimer);
    for (let i = 0; i < this._STEPS.length; i++) {
      const el = document.getElementById(`bt-step-${i}`);
      if (el) { el.classList.remove("active"); el.classList.add("done"); }
    }
  },

  _hideLoader() {
    clearTimeout(this._stepTimer);
    const loadingArea = document.getElementById("backtestLoadingArea");
    const resultsArea = document.getElementById("backtestResultsArea");
    if (loadingArea) loadingArea.style.display = "none";
    if (resultsArea) resultsArea.style.display = "block";
  },

  _showError(msg) {
    clearTimeout(this._stepTimer);
    const loadingArea = document.getElementById("backtestLoadingArea");
    const resultsArea = document.getElementById("backtestResultsArea");
    if (resultsArea) resultsArea.style.display = "none";
    if (loadingArea) {
      loadingArea.innerHTML = `
        <div class="sig-error-cell" style="padding: 32px 24px; text-align: center;">
          <div style="color: var(--fin-down); font-weight: 700; font-size: 15px; margin-bottom: 8px;">Backtest Notice</div>
          <div style="color: var(--text-dim); font-size: 13px; max-width: 480px; margin: 0 auto 16px;">${msg}</div>
          <button class="btn btn-subtle btn-xs" onclick="Backtest._hideLoader()">Dismiss</button>
        </div>
      `;
      loadingArea.style.display = "block";
    }
  },

  async run() {
    const assetSymbol = document.getElementById("txt-backtestSymbol").value.trim().toUpperCase();
    const assetType = document.getElementById("cmb-backtestType").value;
    const modelUsed = document.getElementById("cmb-backtestModel").value;
    const btn = document.getElementById("btn-runBacktest");

    if (!assetSymbol) {
      Toast.show("Search for and select an asset first.", "error");
      return;
    }

    // Close dropdown
    const dropdown = document.getElementById("dropdown-backtestSuggestions");
    if (dropdown) dropdown.style.display = "none";

    const modelLabel = modelUsed === "lstm" ? "Shallow LSTM" : "Random Forest Baseline";
    btn.disabled = true;

    this._showLoader(assetSymbol, modelLabel);

    try {
      const { ok, data } = await Api.fetch("/api/backtest", {
        method: "POST",
        body: JSON.stringify({ assetSymbol, assetType, modelUsed })
      });

      if (!ok) {
        this._showError(data.error || "Backtest evaluation encountered an issue.");
        Toast.show(data.error || "Backtest error.", "error");
        return;
      }

      this._allStepsDone();
      Toast.show(`Backtest complete for ${assetSymbol}.`, "success");

      setTimeout(() => {
        this._hideLoader();

        document.getElementById("stat-sharpeRatio").textContent = Number(data.sharpeRatio).toFixed(2);
        document.getElementById("stat-winRate").textContent = `${(Number(data.winRate) * 100).toFixed(1)}%`;
        document.getElementById("stat-maxDrawdown").textContent = `${(Number(data.maxDrawdown) * 100).toFixed(1)}%`;
        document.getElementById("stat-totalTrades").textContent = data.totalTrades;

        this._buildSummaryCard(assetSymbol, modelLabel, data);

        State.equityPoints = data.equityCurve || [];
        this.drawChart(State.equityPoints);
      }, 350);
    } catch (err) {
      this._showError(`Network/Server error: ${err.message}`);
      Toast.show(`Backtest failed: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
    }
  },

  // ---- Plain-English Summary Card for non-trading users ----
  _buildSummaryCard(symbol, modelLabel, data) {
    const card = document.getElementById("backtestSummaryCard");
    if (!card) return;

    const sharpe    = Number(data.sharpeRatio);
    const winRate   = Number(data.winRate);
    const drawdown  = Number(data.maxDrawdown);
    const trades    = Number(data.totalTrades);
    const equity    = data.equityCurve || [];
    const finalVal  = equity.length > 0 ? equity[equity.length - 1] : 1;
    const returnPct = ((finalVal - 1) * 100).toFixed(1);

    // --- Overall Grade ---
    let grade, gradeClass, gradeEmoji;
    if (sharpe >= 1.0 && winRate >= 0.50 && drawdown > -0.15) {
      grade = "Strong"; gradeClass = "up"; gradeEmoji = "🟢";
    } else if (sharpe >= 0.5 && winRate >= 0.40 && drawdown > -0.25) {
      grade = "Moderate"; gradeClass = "neutral"; gradeEmoji = "🟡";
    } else if (sharpe >= 0 && winRate >= 0.30) {
      grade = "Weak"; gradeClass = "uncertain"; gradeEmoji = "🟠";
    } else {
      grade = "Poor"; gradeClass = "down"; gradeEmoji = "🔴";
    }

    // --- Sharpe explanation ---
    let sharpeExplain;
    if (sharpe >= 1.5)      sharpeExplain = "Excellent risk-adjusted returns — for every unit of risk the AI took, it earned very strong returns.";
    else if (sharpe >= 1.0) sharpeExplain = "Good risk-adjusted returns — the strategy earned solid returns relative to the risk involved.";
    else if (sharpe >= 0.5) sharpeExplain = "Acceptable returns for the risk taken — the strategy made some money but wasn't highly efficient.";
    else if (sharpe >= 0)   sharpeExplain = "The strategy barely broke even relative to the risk it took — not a reliable approach.";
    else                    sharpeExplain = "The strategy lost money on a risk-adjusted basis — it performed worse than simply holding cash.";

    // --- Win Rate explanation ---
    let winExplain;
    if (winRate >= 0.65)      winExplain = `Out of <strong>${trades} trades</strong>, about <strong>${Math.round(winRate * 100)}%</strong> made money — the AI picked more winners than losers.`;
    else if (winRate >= 0.50) winExplain = `About <strong>half the trades</strong> were profitable — the AI's predictions were roughly a coin flip, but the winning trades may have been larger.`;
    else if (winRate >= 0.35) winExplain = `Only <strong>${Math.round(winRate * 100)}%</strong> of trades were profitable — more trades lost money than gained it.`;
    else                      winExplain = `Very few trades made money (<strong>${Math.round(winRate * 100)}%</strong>) — the AI's predictions were mostly wrong during this period.`;

    // --- Drawdown explanation ---
    const ddPct = Math.abs(drawdown * 100).toFixed(1);
    let ddExplain;
    if (Math.abs(drawdown) <= 0.05)      ddExplain = `The worst dip was only <strong>${ddPct}%</strong> — the strategy was relatively safe with small drops.`;
    else if (Math.abs(drawdown) <= 0.15) ddExplain = `At its worst, the portfolio dropped <strong>${ddPct}%</strong> from its peak — a noticeable but manageable loss.`;
    else if (Math.abs(drawdown) <= 0.30) ddExplain = `The portfolio dropped as much as <strong>${ddPct}%</strong> at one point — this is a significant loss that could be stressful.`;
    else                                  ddExplain = `The worst drop was a severe <strong>${ddPct}%</strong> — this means the strategy carried very high risk.`;

    // --- Return explanation ---
    const returnSign = finalVal >= 1 ? "+" : "";
    let returnExplain;
    if (finalVal >= 1.10)     returnExplain = `If you had followed this strategy, a ₹10,000 investment would have grown to about <strong>₹${(10000 * finalVal).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</strong> — a solid gain.`;
    else if (finalVal >= 1.0) returnExplain = `The strategy ended with a small <strong>${returnSign}${returnPct}%</strong> gain — the portfolio value stayed roughly the same or grew a little.`;
    else if (finalVal >= 0.90) returnExplain = `The strategy ended at a <strong>${returnPct}%</strong> loss — a ₹10,000 investment would have shrunk to about <strong>₹${(10000 * finalVal).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</strong>.`;
    else                       returnExplain = `The strategy ended with a significant <strong>${returnPct}%</strong> loss — following these AI signals would have caused a real money loss.`;

    // --- Build the card ---
    card.style.display = "block";
    card.innerHTML = `
      <div class="verdict-card verdict-${gradeClass}" style="margin-bottom: 10px;">
        <div class="verdict-top">
          <div>
            <div class="verdict-asset-label">AI Backtest Analysis</div>
            <div class="verdict-asset-name">${symbol}</div>
          </div>
          <div class="verdict-pill">
            <div class="verdict-pill-label">Strategy Grade</div>
            <div class="verdict-badge ${gradeClass}">${gradeEmoji} ${grade.toUpperCase()}</div>
          </div>
        </div>

        <!-- Plain-English overall summary -->
        <div class="verdict-summary-text">
          The <strong>${modelLabel}</strong> model was tested on <strong>${symbol}</strong> by replaying its predictions against real historical prices.
          The result: a <strong>${returnSign}${returnPct}%</strong> simulated return over <strong>${trades} trades</strong>.
        </div>

        <!-- Metric explanations in plain words -->
        <div class="verdict-factors" style="margin-top: 14px;">
          <div class="verdict-factors-title">What the numbers mean (in plain words)</div>

          <div class="verdict-factor-item">
            <span class="verdict-factor-dot ${sharpe >= 0.5 ? 'pos' : 'neg'}"></span>
            <span><strong>Sharpe Ratio (${sharpe.toFixed(2)}):</strong> ${sharpeExplain}</span>
          </div>
          <div class="verdict-factor-item">
            <span class="verdict-factor-dot ${winRate >= 0.5 ? 'pos' : 'neg'}"></span>
            <span><strong>Win Rate:</strong> ${winExplain}</span>
          </div>
          <div class="verdict-factor-item">
            <span class="verdict-factor-dot ${Math.abs(drawdown) <= 0.15 ? 'pos' : 'neg'}"></span>
            <span><strong>Max Drawdown:</strong> ${ddExplain}</span>
          </div>
          <div class="verdict-factor-item">
            <span class="verdict-factor-dot ${finalVal >= 1 ? 'pos' : 'neg'}"></span>
            <span><strong>Final Return:</strong> ${returnExplain}</span>
          </div>
        </div>

        <!-- Chart explanation -->
        <div class="verdict-factors" style="margin-top: 10px;">
          <div class="verdict-factors-title">How to read the chart below</div>
          <div class="verdict-factor-item">
            <span class="verdict-factor-dot neu"></span>
            <span>The chart below shows how your portfolio value would have changed over time if you followed every AI signal. The <strong>baseline is 1.00×</strong> (your starting capital). Above the line = profit, below = loss.</span>
          </div>
        </div>

        <!-- Disclaimer -->
        <div class="verdict-disclaimer">
          ⚠ Past performance in backtesting does NOT guarantee future results. This is a simulation on historical data, not real trading. Always do your own research before investing.
        </div>
      </div>`;
  },

  drawChart(points) {
    const canvas = document.getElementById("tbl-equityCanvas");
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 800;
    const height = 220;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Read active CSS variables
    const computedStyles = getComputedStyle(document.documentElement);
    const colorGrid = computedStyles.getPropertyValue("--chart-grid").trim() || "#202534";
    const colorBaseline = computedStyles.getPropertyValue("--chart-baseline").trim() || "rgba(245, 158, 11, 0.45)";
    const colorLine = computedStyles.getPropertyValue("--chart-line").trim() || "#38bdf8";
    const colorFillStart = computedStyles.getPropertyValue("--chart-fill-start").trim() || "rgba(56, 189, 248, 0.28)";
    const colorFillEnd = computedStyles.getPropertyValue("--chart-fill-end").trim() || "rgba(56, 189, 248, 0.0)";
    const colorText = computedStyles.getPropertyValue("--text-dim").trim() || "#64748b";

    if (!points || points.length < 2) {
      ctx.fillStyle = colorText;
      ctx.font = "12.5px Plus Jakarta Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Run a backtest above to render cumulative equity curve.", width / 2, height / 2);
      return;
    }

    const padX = 42;
    const padY = 20;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = (max - min) || 0.01;

    const getX = (i) => padX + (i / (points.length - 1)) * (width - padX * 2);
    const getY = (val) => height - padY - ((val - min) / range) * (height - padY * 2);

    // 1. Gridlines
    ctx.strokeStyle = colorGrid;
    ctx.lineWidth = 1;
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillStyle = colorText;
    ctx.textAlign = "right";

    const steps = 4;
    for (let s = 0; s <= steps; s++) {
      const val = min + (range * s) / steps;
      const y = getY(val);
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(width - padX, y);
      ctx.stroke();
      ctx.fillText(val.toFixed(2), padX - 8, y + 4);
    }

    // 2. Baseline at 1.0 (starting equity)
    const baseLineY = getY(1.0);
    ctx.strokeStyle = colorBaseline;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, baseLineY);
    ctx.lineTo(width - padX, baseLineY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Area Fill
    const gradient = ctx.createLinearGradient(0, padY, 0, height - padY);
    gradient.addColorStop(0, colorFillStart);
    gradient.addColorStop(1, colorFillEnd);

    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0]));
    for (let i = 1; i < points.length; i++) ctx.lineTo(getX(i), getY(points[i]));
    ctx.lineTo(getX(points.length - 1), height - padY);
    ctx.lineTo(getX(0), height - padY);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 4. Stroke
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0]));
    for (let i = 1; i < points.length; i++) ctx.lineTo(getX(i), getY(points[i]));
    ctx.strokeStyle = colorLine;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
};

// Canvas Hover Tooltip
const chartCanvas = document.getElementById("tbl-equityCanvas");
if (chartCanvas) {
  chartCanvas.addEventListener("mousemove", (e) => {
    if (!State.equityPoints || State.equityPoints.length < 2) return;
    const rect = chartCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padX = 42;
    const width = rect.width;

    if (x < padX || x > width - padX) return;

    const idx = Math.round(((x - padX) / (width - padX * 2)) * (State.equityPoints.length - 1));
    const val = State.equityPoints[idx];
    if (val !== undefined) {
      document.getElementById("lbl-chartHoverVal").innerHTML = `Trade #${idx + 1}: <strong>${val.toFixed(3)}x</strong> equity`;
    }
  });
}

/* --- WATCHLIST MODULE (FR-5) --- */
const Watchlist = {
  _searchDebounce: null,

  onSymbolInput(query) {
    clearTimeout(this._searchDebounce);
    const dropdown = document.getElementById("dropdown-watchSuggestions");
    if (!dropdown) return;

    this._searchDebounce = setTimeout(async () => {
      const q = (query || "").trim().toLowerCase();
      const { ok, data } = await Api.fetch(`/api/assets/search?q=${encodeURIComponent(q)}`);
      if (!ok || !data || data.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.innerHTML = data.map(item => `
        <div class="suggestion-item"
          onclick="Watchlist.selectAsset('${item.symbol}', '${item.type}')">
          <div class="suggestion-item-main">
            <span class="suggestion-sym">${item.symbol}</span>
            <span class="suggestion-name">${item.name}</span>
          </div>
          <span class="tag ${item.type === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${item.type}</span>
        </div>
      `).join("");
      dropdown.style.display = "block";
    }, 160);
  },

  selectAsset(symbol, type) {
    document.getElementById("txt-watchSymbol").value = symbol;
    if (type) document.getElementById("cmb-watchType").value = type;
    const dropdown = document.getElementById("dropdown-watchSuggestions");
    if (dropdown) dropdown.style.display = "none";
  },

  async load() {
    const { ok, data } = await Api.fetch("/api/watchlist");
    if (!ok) return;

    const list = data || [];
    const countEl = document.getElementById("tabCountWatchlist");
    if (countEl) countEl.textContent = list.length;

    const pillCount = document.getElementById("watchPill-count");
    if (pillCount) {
      pillCount.textContent = `${list.length} tracked`;
      pillCount.style.display = "inline-flex";
    }

    const alertCount = list.filter(item => item.signalChanged).length;
    const statAlerts = document.getElementById("stat-alertsCount");
    if (statAlerts) statAlerts.textContent = alertCount;

    const pillAlerts = document.getElementById("watchPill-alerts");
    if (pillAlerts) {
      pillAlerts.textContent = `${alertCount} shift${alertCount !== 1 ? "s" : ""}`;
      pillAlerts.style.display = alertCount > 0 ? "inline-flex" : "none";
    }

    // Populate dynamic quick audit pills in Feedback Loop card
    const quickAuditWrap = document.getElementById("auditQuickPills");
    if (quickAuditWrap && list.length > 0) {
      const topSymbols = list.slice(0, 5).map(i => i.assetSymbol);
      quickAuditWrap.innerHTML = `<span>Quick Audit:</span>` + topSymbols.map(sym => `
        <button type="button" class="btn btn-subtle btn-xs" onclick="Audit.loadFor('${sym}')">${sym}</button>
      `).join("");
    }

    const tbody = document.getElementById("tbl-watchlist-body");
    if (!tbody) return;

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 24px;">Watchlist is empty. Search or select an asset above to start tracking.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(item => {
      const typeTag = item.assetType === "crypto" ? "tag-crypto" : "tag-stock";
      const sig = (item.latestSignal || "—").toUpperCase();
      let sigBadge = `<span class="mono">${sig}</span>`;
      if (sig === "UP") sigBadge = `<span class="tag tag-up">UP ▲</span>`;
      else if (sig === "DOWN") sigBadge = `<span class="tag tag-down">DOWN ▼</span>`;
      else if (sig === "NEUTRAL") sigBadge = `<span class="tag tag-neu">NEUTRAL ▬</span>`;

      const alertBadge = item.signalChanged
        ? `<span class="tag tag-alert">Shift Detected</span>`
        : `<span style="color:var(--text-dim); font-size:12px;">Unchanged</span>`;

      return `
        <tr>
          <td><strong class="mono">${item.assetSymbol}</strong></td>
          <td><span class="tag ${typeTag}">${item.assetType}</span></td>
          <td>${sigBadge}</td>
          <td>${alertBadge}</td>
          <td>
            <div class="control-row" style="gap: 5px;">
              <button class="btn btn-subtle btn-xs" title="Inspect model audit history" onclick="Audit.loadFor('${item.assetSymbol}')">Audit</button>
              <button class="btn btn-subtle btn-xs" title="Evaluate live signal" onclick="Signals.quickAnalyze('${item.assetSymbol}', '${item.assetType}')">Evaluate</button>
              <button class="btn btn-danger-outline btn-xs" title="Remove from watchlist" onclick="Watchlist.remove(${item.watchlistId}, '${item.assetSymbol}')">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  },

  async add() {
    const symbol = document.getElementById("txt-watchSymbol").value.trim().toUpperCase();
    const assetType = document.getElementById("cmb-watchType").value;

    if (!symbol) {
      Toast.show("Asset symbol required.", "error");
      return;
    }

    const { ok, data } = await Api.fetch("/api/watchlist", {
      method: "POST",
      body: JSON.stringify({ assetSymbol: symbol, assetType })
    });

    if (!ok) {
      Toast.show(data.error || "Failed to add asset.", "error");
      return;
    }

    Toast.show(`Added ${symbol} to watchlist`, "success");
    document.getElementById("txt-watchSymbol").value = "";
    const drop = document.getElementById("dropdown-watchSuggestions");
    if (drop) drop.style.display = "none";
    this.load();
  },

  async remove(id, symbol) {
    const { ok } = await Api.fetch(`/api/watchlist/${id}`, { method: "DELETE" });
    if (ok) {
      Toast.show(`Removed ${symbol || 'asset'} from watchlist.`, "info");
      this.load();
    }
  }
};

/* --- AUDIT FEEDBACK LOOP MODULE (FR-6.2) --- */
const Audit = {
  _searchDebounce: null,
  _currentSymbol: "",
  _currentData: [],

  onSymbolInput(query) {
    clearTimeout(this._searchDebounce);
    const dropdown = document.getElementById("dropdown-auditSuggestions");
    if (!dropdown) return;

    this._searchDebounce = setTimeout(async () => {
      const q = (query || "").trim().toLowerCase();
      const { ok, data } = await Api.fetch(`/api/assets/search?q=${encodeURIComponent(q)}`);
      if (!ok || !data || data.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.innerHTML = data.map(item => `
        <div class="suggestion-item"
          onclick="Audit.selectAsset('${item.symbol}')">
          <div class="suggestion-item-main">
            <span class="suggestion-sym">${item.symbol}</span>
            <span class="suggestion-name">${item.name}</span>
          </div>
          <span class="tag ${item.type === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${item.type}</span>
        </div>
      `).join("");
      dropdown.style.display = "block";
    }, 160);
  },

  selectAsset(symbol) {
    document.getElementById("txt-historySymbol").value = symbol;
    const drop = document.getElementById("dropdown-auditSuggestions");
    if (drop) drop.style.display = "none";
    this.load();
  },

  loadFor(symbol) {
    document.getElementById("txt-historySymbol").value = symbol;
    this.load();
  },

  filterChanged() {
    this.render();
  },

  async load() {
    const symbol = document.getElementById("txt-historySymbol").value.trim().toUpperCase();
    if (!symbol) {
      Toast.show("Please enter an asset symbol to audit.", "warning");
      return;
    }

    const drop = document.getElementById("dropdown-auditSuggestions");
    if (drop) drop.style.display = "none";

    this._currentSymbol = symbol;
    const loadingArea = document.getElementById("auditLoadingArea");
    const summaryCard = document.getElementById("auditSummaryCard");
    const tbody = document.getElementById("tbl-history-body");

    if (loadingArea) loadingArea.style.display = "block";
    if (summaryCard) summaryCard.style.display = "none";
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 24px;">Auditing historical outcomes for ${symbol}…</td></tr>`;

    try {
      const { ok, data } = await Api.fetch(`/api/signal-history?assetSymbol=${encodeURIComponent(symbol)}`);
      if (loadingArea) loadingArea.style.display = "none";

      if (!ok || !data || data.length === 0) {
        this._currentData = [];
        if (summaryCard) summaryCard.style.display = "none";
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 24px;">No historical prediction audit records found for <strong>${symbol}</strong>.<br><span style="font-size:12px; color:var(--text-muted);">Run evaluations in the Signal Engine first to log auditable trajectories.</span></td></tr>`;
        }
        return;
      }

      this._currentData = data;
      this.render();
    } catch (err) {
      if (loadingArea) loadingArea.style.display = "none";
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-down); padding: 24px;">Error retrieving audit history for ${symbol}.</td></tr>`;
    }
  },

  render() {
    const rawData = this._currentData || [];
    const modelFilter = (document.getElementById("cmb-auditModelFilter") || {}).value || "all";

    const filtered = modelFilter === "all"
      ? rawData
      : rawData.filter(r => r.modelUsed === modelFilter);

    // Compute empirical accuracy metrics
    const resolvedAll = rawData.filter(r => r.status !== "pending");
    const correctAll = resolvedAll.filter(r => r.wasCorrect === true);
    const overallAcc = resolvedAll.length > 0 ? (correctAll.length / resolvedAll.length * 100) : null;

    const rfResolved = rawData.filter(r => r.modelUsed === "random_forest" && r.status !== "pending");
    const rfCorrect = rfResolved.filter(r => r.wasCorrect === true);
    const rfAcc = rfResolved.length > 0 ? (rfCorrect.length / rfResolved.length * 100) : null;

    const lstmResolved = rawData.filter(r => r.modelUsed === "lstm" && r.status !== "pending");
    const lstmCorrect = lstmResolved.filter(r => r.wasCorrect === true);
    const lstmAcc = lstmResolved.length > 0 ? (lstmCorrect.length / lstmResolved.length * 100) : null;

        // Render plain-English summary card
    const summaryCard = document.getElementById("auditSummaryCard");
    if (summaryCard) {
      let gradeText = "⚪ VERIFICATION PENDING";
      let gradeColor = "var(--text-dim)";
      let gradeBg = "rgba(148,163,184,0.12)";
      let plainText = `Predictions for <strong>${this._currentSymbol}</strong> have been recorded, but subsequent market price candles are still unfolding to verify directional ground truth.`;

      if (resolvedAll.length > 0) {
        // Neutral wording: hit rate with sample size, no "reliably", "strong", "proven"
        const hitRateLabel = `${overallAcc.toFixed(1)}%`;
        if (overallAcc >= 70) {
          gradeText = "🟢 CONFIRMED HIT RATE";
          gradeColor = "var(--fin-pos)";
          gradeBg = "rgba(16,185,129,0.12)";
          plainText = `Of <strong>${resolvedAll.length}</strong> resolved forecasts for <strong>${this._currentSymbol}</strong>, <strong>${hitRateLabel}</strong> matched the realised direction. Small samples are unreliable and past results do not predict future ones.`;
        } else if (overallAcc >= 50) {
          gradeText = "🟡 MODERATE HIT RATE";
          gradeColor = "var(--fin-alert)";
          gradeBg = "rgba(245,158,11,0.12)";
          plainText = `Of <strong>${resolvedAll.length}</strong> resolved forecasts for <strong>${this._currentSymbol}</strong>, <strong>${hitRateLabel}</strong> matched the realised direction. Use with confirming technical indicators; no guarantee of future direction.`;
        } else {
          gradeText = "🔴 INSUFFICIENT HIT RATE";
          gradeColor = "var(--fin-neg)";
          gradeBg = "rgba(239,68,68,0.12)";
          plainText = `Of <strong>${resolvedAll.length}</strong> resolved forecasts for <strong>${this._currentSymbol}</strong>, <strong>${hitRateLabel}</strong> matched the realised direction. High volatility or regime shifts caused repeated forecast misses; past performance does not guarantee future results.`;
        }
      }

      summaryCard.innerHTML = `
        <div class="audit-summary-box">
          <div class="audit-summary-header">
            <div>
              <span style="font-size: 13px; font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: 0.04em;">
                Empirical Model Audit: ${this._currentSymbol}
              </span>
            </div>
            <span class="audit-grade-pill" style="color: ${gradeColor}; background: ${gradeBg}; border: 1px solid ${gradeColor}40;">
              ${gradeText}
            </span>
          </div>

          <p style="font-size: 12px; color: var(--text-muted); line-height: 1.5; margin: 0 0 10px;">
            ${plainText}
          </p>

          <div class="audit-grid">
            <div class="audit-tile">
              <div class="audit-tile-lbl">Hit rate</div>
              <div class="audit-tile-val mono ${overallAcc !== null && overallAcc >= 60 ? 'val-pos' : (overallAcc !== null && overallAcc < 50 ? 'val-neg' : 'val-neu')}">
                ${overallAcc !== null ? `${overallAcc.toFixed(1)}% (n = ${resolvedAll.length})` : 'Pending'}
              </div>
            </div>
            <div class="audit-tile">
              <div class="audit-tile-lbl">Resolved / Total</div>
              <div class="audit-tile-val mono">${resolvedAll.length} / ${rawData.length}</div>
            </div>
            <div class="audit-tile">
              <div class="audit-tile-lbl">Random Forest</div>
              <div class="audit-tile-val mono ${rfAcc !== null && rfAcc >= 60 ? 'val-pos' : ''}">
                ${rfAcc !== null ? `${rfAcc.toFixed(1)}% (n = ${rfResolved.length})` : '—'}
              </div>
            </div>
            <div class="audit-tile">
              <div class="audit-tile-lbl">Shallow LSTM</div>
              <div class="audit-tile-val mono ${lstmAcc !== null && lstmAcc >= 60 ? 'val-pos' : ''}">
                ${lstmAcc !== null ? `${lstmAcc.toFixed(1)}% (n = ${lstmResolved.length})` : '—'}
              </div>
            </div>
          </div>
        </div>
      `;
      summaryCard.style.display = "block";
    }

    // Render table rows
    const tbody = document.getElementById("tbl-history-body");
    if (!tbody) return;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 20px;">No audit records found matching model filter "${modelFilter}".</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(row => {
      let outcomeTag = `<span class="tag" style="background:var(--bg-input); color:var(--text-dim); border:1px solid var(--border-subtle);">PENDING</span>`;
      if (row.status !== "pending") {
        outcomeTag = row.wasCorrect
          ? `<span class="tag tag-up" style="font-weight:700;">CORRECT ✓</span>`
          : `<span class="tag tag-down" style="font-weight:700;">MISSED ✕</span>`;
      }

      const modelLabel = row.modelUsed === "lstm" ? "PyTorch LSTM" : "Random Forest";
      const modelTag = row.modelUsed === "lstm" ? "tag-crypto" : "tag-stock";

      return `
        <tr>
          <td class="mono" style="font-size: 12px;">${row.generatedAt ? row.generatedAt.slice(0, 10) : '—'}</td>
          <td><span class="tag ${modelTag}">${modelLabel}</span></td>
          <td class="mono"><strong>${(row.predictedDirection || '—').toUpperCase()}</strong></td>
          <td class="mono">${(row.actualDirection || '—').toUpperCase()}</td>
          <td>${outcomeTag}</td>
        </tr>
      `;
    }).join("");
  }
};

/* --- ADMIN MODULE (FR-7) --- */
const Admin = {
  async loadTracked() {
    const { ok, data } = await Api.fetch("/api/admin/tracked-assets");
    const tbody = document.getElementById("tbl-tracked-body");
    if (!ok || !data) return;

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-dim); padding: 18px;">No tracked assets in registry.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(a => `
      <tr>
        <td><strong class="mono">${a.assetSymbol}</strong></td>
        <td><span class="tag ${a.assetType === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${a.assetType}</span></td>
        <td><button class="btn btn-danger-outline btn-xs" onclick="Admin.removeTracked(${a.trackedAssetId})">Remove</button></td>
      </tr>
    `).join("");
  },

  async addTracked() {
    const symbol = document.getElementById("txt-adminSymbol").value.trim().toUpperCase();
    const assetType = document.getElementById("cmb-adminType").value;
    if (!symbol) return;

    const { ok } = await Api.fetch("/api/admin/tracked-assets", {
      method: "POST",
      body: JSON.stringify({ assetSymbol: symbol, assetType })
    });

    if (ok) {
      Toast.show(`Tracked asset registered: ${symbol}`, "success");
      document.getElementById("txt-adminSymbol").value = "";
      this.loadTracked();
    }
  },

  async removeTracked(id) {
    const { ok } = await Api.fetch(`/api/admin/tracked-assets/${id}`, { method: "DELETE" });
    if (ok) {
      Toast.show("Asset unregistered.", "info");
      this.loadTracked();
    }
  },

  async loadConfig() {
    const { ok, data } = await Api.fetch("/api/admin/config");
    if (ok && data.retrainIntervalDays) {
      document.getElementById("txt-retrainDays").value = data.retrainIntervalDays;
    }
  },

  async saveConfig() {
    const days = parseInt(document.getElementById("txt-retrainDays").value, 10);
    if (!days) return;

    const { ok } = await Api.fetch("/api/admin/config", {
      method: "POST",
      body: JSON.stringify({ retrainIntervalDays: days })
    });

    if (ok) Toast.show(`Retrain interval configured to ${days} days.`, "success");
  },

  async retrainNow() {
    const btn = document.getElementById("btn-retrainNow");
    const origText = btn ? btn.innerHTML : "⚡ Retrain Now";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" style="width:12px;height:12px;display:inline-block;margin-right:4px;"></span> Retraining...`;
    }
    Toast.show("Batch retraining initiated for tracked assets...", "info");

    const healthBox = document.getElementById("box-feedHealth");
    if (healthBox) {
      healthBox.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; color: var(--text-dim);">
          <div class="spinner" style="width: 16px; height: 16px;"></div>
          <span style="font-size: 13px;">Executing model retraining sweep across tracked assets...</span>
        </div>
      `;
    }

    const { ok, data } = await Api.fetch("/api/admin/retrain", { method: "POST" });
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }

    if (!ok) {
      Toast.show("Retraining request failed.", "error");
      if (healthBox) {
        healthBox.innerHTML = `
          <div style="padding: 14px; background: rgba(255, 59, 92, 0.1); border: 1px solid rgba(255, 59, 92, 0.25); border-radius: 6px; color: #ff3b5c; font-size: 12px;">
            ⚠️ Retraining sweep failed to execute on server.
          </div>
        `;
      }
      return;
    }

    if (data.status === "no_tracked_assets") {
      Toast.show("No tracked assets registered to retrain.", "warning");
      if (healthBox) {
        healthBox.innerHTML = `
          <div style="text-align: center; color: var(--text-dim); padding: 24px; font-size: 12px;">
            ℹ️ No tracked assets registered in registry.
          </div>
        `;
      }
      return;
    }

    const results = data.results || [];
    const okCount = results.filter(r => r.status === "retrained").length;
    const failCount = results.length - okCount;
    const timeStr = new Date().toLocaleTimeString();

    Toast.show(`Successfully retrained ${okCount} tracked asset model(s).`, "success");

    if (healthBox) {
      let html = `
        <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--border-subtle); font-size: 12px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="color: var(--text-dim);">Retrain Sweep Summary</span>
            <span style="font-size: 10px; color: var(--text-dim); background: var(--bg-card); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-subtle);">${timeStr}</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <span style="font-size: 11px; font-weight: 600; background: rgba(0, 214, 143, 0.15); color: #00d68f; border: 1px solid rgba(0, 214, 143, 0.3); padding: 2px 8px; border-radius: 12px;">
              ✓ ${okCount} Retrained
            </span>
            ${failCount > 0 ? `
              <span style="font-size: 11px; font-weight: 600; background: rgba(255, 59, 92, 0.15); color: #ff3b5c; border: 1px solid rgba(255, 59, 92, 0.3); padding: 2px 8px; border-radius: 12px;">
                ✕ ${failCount} Failed
              </span>
            ` : ''}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
      `;

      html += results.map(r => {
        const isOk = r.status === "retrained";
        const statusBg = isOk ? "rgba(0, 214, 143, 0.1)" : "rgba(255, 59, 92, 0.1)";
        const statusBorder = isOk ? "rgba(0, 214, 143, 0.25)" : "rgba(255, 59, 92, 0.25)";
        const statusColor = isOk ? "#00d68f" : "#ff3b5c";
        const icon = isOk ? "✓" : "✕";
        const statusLabel = isOk ? "RETRAINED" : "FAILED";
        const modelNames = r.models && r.models.length > 0 ? r.models.join(", ") : "N/A";

        return `
          <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card, rgba(255,255,255,0.02)); border: 1px solid var(--border-subtle); border-radius: 6px; font-family: var(--font-sans);">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 26px; height: 26px; border-radius: 50%; background: ${statusBg}; border: 1px solid ${statusBorder}; color: ${statusColor}; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex-shrink: 0;">
                ${icon}
              </div>
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-weight: 700; color: var(--text-main); font-size: 13px;">${r.assetSymbol}</span>
                  <span style="font-size: 10px; padding: 1px 6px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; color: var(--text-dim);">${modelNames}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px;">
                  Data points: <strong style="color: var(--text-muted);">${r.dataPoints || 0}</strong> • Sentiment: <strong style="color: var(--text-muted);">${r.sentiment ?? 'N/A'}</strong>
                </div>
              </div>
            </div>
            <div style="text-align: right;">
              <span style="font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; letter-spacing: 0.3px;">
                ${statusLabel}
              </span>
            </div>
          </div>
        `;
      }).join("");

      html += `</div>`;
      healthBox.innerHTML = html;
    }
  },

  async checkHealth() {
    const el = document.getElementById("box-feedHealth");
    if (!el) return;
    el.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; gap: 10px; padding: 24px; color: var(--text-dim);">
        <div class="spinner" style="width: 16px; height: 16px;"></div>
        <span style="font-size: 13px;">Pinging data feed endpoints (Yahoo Finance & Binance REST)...</span>
      </div>
    `;

    const { ok, data } = await Api.fetch("/api/admin/health");
    if (!ok) {
      el.innerHTML = `
        <div style="padding: 14px; background: rgba(255, 59, 92, 0.1); border: 1px solid rgba(255, 59, 92, 0.25); border-radius: 6px; color: #ff3b5c; font-size: 12px; display: flex; align-items: center; gap: 8px;">
          <span>⚠️</span> <span>Diagnostic call failed: Unable to connect to administrative server endpoint.</span>
        </div>
      `;
      return;
    }

    if (!data || data.length === 0) {
      el.innerHTML = `
        <div style="text-align: center; color: var(--text-dim); padding: 24px; font-size: 12px;">
          ℹ️ No tracked assets registered in registry. Add assets to test live connectivity.
        </div>
      `;
      return;
    }

    const okCount = data.filter(h => h.status === "ok").length;
    const failCount = data.length - okCount;
    const timeStr = new Date().toLocaleTimeString();

    let html = `
      <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--border-subtle); font-size: 12px;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="color: var(--text-dim);">Diagnostic Summary</span>
          <span style="font-size: 10px; color: var(--text-dim); background: var(--bg-card); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border-subtle);">${timeStr}</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <span style="font-size: 11px; font-weight: 600; background: rgba(0, 214, 143, 0.15); color: #00d68f; border: 1px solid rgba(0, 214, 143, 0.3); padding: 2px 8px; border-radius: 12px;">
            ✓ ${okCount} Operational
          </span>
          ${failCount > 0 ? `
            <span style="font-size: 11px; font-weight: 600; background: rgba(255, 59, 92, 0.15); color: #ff3b5c; border: 1px solid rgba(255, 59, 92, 0.3); padding: 2px 8px; border-radius: 12px;">
              ✕ ${failCount} Issues
            </span>
          ` : ''}
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
    `;

    html += data.map(h => {
      const isOk = h.status === "ok";
      const isDegraded = h.status === "empty_response";
      const statusBg = isOk ? "rgba(0, 214, 143, 0.1)" : isDegraded ? "rgba(255, 170, 0, 0.1)" : "rgba(255, 59, 92, 0.1)";
      const statusBorder = isOk ? "rgba(0, 214, 143, 0.25)" : isDegraded ? "rgba(255, 170, 0, 0.25)" : "rgba(255, 59, 92, 0.25)";
      const statusColor = isOk ? "#00d68f" : isDegraded ? "#ffaa00" : "#ff3b5c";
      const icon = isOk ? "✓" : isDegraded ? "!" : "✕";
      const statusLabel = isOk ? "ONLINE (Active)" : isDegraded ? "NO DATA (Empty)" : "OFFLINE (Error)";
      const providerLabel = h.source === "yfinance" ? "Yahoo Finance API" : h.source === "binance" ? "Binance REST API" : (h.source || "External Provider");

      return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card, rgba(255,255,255,0.02)); border: 1px solid var(--border-subtle); border-radius: 6px; font-family: var(--font-sans);">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 26px; height: 26px; border-radius: 50%; background: ${statusBg}; border: 1px solid ${statusBorder}; color: ${statusColor}; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; flex-shrink: 0;">
              ${icon}
            </div>
            <div>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-weight: 700; color: var(--text-main); font-size: 13px;">${h.assetSymbol}</span>
                <span class="tag ${h.assetType === 'crypto' ? 'tag-crypto' : 'tag-stock'}" style="font-size: 10px; padding: 1px 5px;">${h.assetType}</span>
              </div>
              <div style="font-size: 11px; color: var(--text-dim); margin-top: 1px;">
                Feed: <strong style="color: var(--text-muted);">${providerLabel}</strong>
                ${h.sentimentSource ? ` | Sentiment: <strong style="color: var(--text-muted);">${h.sentimentSource === "newsapi" ? "NewsAPI" : "Reddit/PRAW"}</strong> (${h.sentimentStatus === "ok" ? '<span style="color: #00d68f; font-weight: 600;">ACTIVE</span>' : `<span style="color: #ffaa00; font-weight: 600;">${h.sentimentStatus}</span>`})` : ''}
              </div>
            </div>
          <div style="text-align: right;">
            <span style="font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; letter-spacing: 0.3px;">
              ${statusLabel}
            </span>
          </div>
        </div>
      `;
    }).join("");

    html += `</div>`;
    el.innerHTML = html;
  },

  // Copy the current feed health log to clipboard
  copyLog() {
    const el = document.getElementById("box-feedHealth");
    if (!el) return;
    const text = el.innerText || el.textContent;
    navigator.clipboard.writeText(text).then(() => {
      Toast.show("Connectivity log copied to clipboard.", "info");
    }).catch(() => {
      Toast.show("Failed to copy log.", "error");
    });
  },

  adminSearchDebounceTimer: null,
  onSymbolInput(query) {
    clearTimeout(this.adminSearchDebounceTimer);
    const dropdown = document.getElementById("dropdown-adminSuggestions");
    if (!dropdown) return;
    this.adminSearchDebounceTimer = setTimeout(async () => {
      const q = query.trim().toLowerCase();
      const { ok, data } = await Api.fetch(`/api/assets/search?q=${encodeURIComponent(q)}`);
      if (!ok || !data || data.length === 0) {
        dropdown.style.display = "none";
        return;
      }
      dropdown.innerHTML = data.map(item => `
        <div class="suggestion-item" onclick="Admin.selectAsset('${item.symbol}', '${item.type}', '${item.name.replace(/'/g, "\\'")}')">
          <div class="suggestion-item-main">
            <span class="suggestion-sym">${item.symbol}</span>
            <span class="suggestion-name">${item.name}</span>
          </div>
          <span class="tag ${item.type === 'crypto' ? 'tag-crypto' : 'tag-stock'}">${item.type}</span>
        </div>
      `).join("");
      dropdown.style.display = "block";
    }, 180);
  },

  selectAsset(symbol, type, name) {
    document.getElementById("txt-adminSymbol").value = symbol;
    document.getElementById("cmb-adminType").value = type;
    const dropdown = document.getElementById("dropdown-adminSuggestions");
    if (dropdown) dropdown.style.display = "none";
  }
};

/* --- LIVE MARKET RIBBON (Fix #6) --- */
// Ribbon symbols + types match the HTML ribbon items order.
const RIBBON_ASSETS = [
  { symbol: "BTC",  type: "crypto", display: "BTC/USD" },
  { symbol: "NVDA", type: "stock",  display: "NVDA"    },
  { symbol: "AAPL", type: "stock",  display: "AAPL"    },
  { symbol: "ETH",  type: "crypto", display: "ETH/USD" },
  { symbol: "MSFT", type: "stock",  display: "MSFT"    },
  { symbol: "SPY",  type: "stock",  display: "SPY"     },
];

async function refreshMarketRibbon() {
  const items = document.querySelectorAll(".market-ribbon .ribbon-item");
  if (!items || items.length === 0) return;

  const assetsParam = RIBBON_ASSETS.map(a => `${a.symbol}:${a.type}`).join(",");
  const { ok, data } = await Api.fetch(`/api/price/batch?assets=${encodeURIComponent(assetsParam)}`);
  if (!ok || !data) return;

  RIBBON_ASSETS.forEach((asset, idx) => {
    const item = items[idx];
    if (!item) return;

    const res = data[asset.symbol];
    if (!res || res.price === undefined) return;

    const price = Number(res.price);
    const valEl = item.querySelector(".val");
    if (valEl) {
      valEl.textContent = price >= 1
        ? `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `$${price.toFixed(4)}`;
    }
    const changeEl = item.querySelector(".val-pos, .val-neg");
    if (changeEl) {
      changeEl.textContent = "● live";
      changeEl.className = "val-live";
    }
  });
}

/* --- INITIAL BOOT SEQUENCE --- */
function loadAllTerminalData() {
  // Execute all initial view loading in parallel for instantaneous rendering
  Promise.allSettled([
    Portfolio.load(),
    Watchlist.load(),
    Admin.loadTracked(),
    Admin.loadConfig(),
    refreshMarketRibbon()
  ]);
}

window.addEventListener("DOMContentLoaded", () => {
  Theme.init();

  const cached = localStorage.getItem("tradesage_user");
  let cachedUser = null;
  if (cached) {
    try { cachedUser = JSON.parse(cached); } catch (e) {}
  }

  // Check active session with lightweight /api/me endpoint
  Api.fetch("/api/me").then(({ ok, data }) => {
    const gateway = document.getElementById("authGateway");
    const workspace = document.getElementById("mainWorkspace");

    if (ok && data && (data.email || data.userId)) {
      const email = data.email || (cachedUser ? cachedUser.email : "Active Session");
      document.getElementById("userPill").innerHTML = `Trader: <strong>${email}</strong>`;
      document.getElementById("btn-openAuth").style.display = "none";
      document.getElementById("btn-logout").style.display = "inline-flex";
      if (gateway) gateway.style.display = "none";
      if (workspace) workspace.style.display = "block";
      loadAllTerminalData();
    } else if (cachedUser && cachedUser.email) {
      // Seamless fallback if user just authenticated on auth.html
      document.getElementById("userPill").innerHTML = `Trader: <strong>${cachedUser.email}</strong>`;
      document.getElementById("btn-openAuth").style.display = "none";
      document.getElementById("btn-logout").style.display = "inline-flex";
      if (gateway) gateway.style.display = "none";
      if (workspace) workspace.style.display = "block";
      loadAllTerminalData();
    } else {
      // Not logged in — redirect to dedicated auth page
      const target = window.location.pathname.includes("/static/") ? "auth.html?mode=login" : "/auth?mode=login";
      window.location.href = target;
    }
  });

  // Empty canvas baseline
  Backtest.drawChart([]);
});

window.addEventListener("resize", () => {
  if (State.equityPoints.length > 0) {
    Backtest.drawChart(State.equityPoints);
  }
});

document.addEventListener("click", (e) => {
  // Portfolio asset dropdown
  const holdDrop = document.getElementById("dropdown-holdSuggestions");
  const holdInput = document.getElementById("txt-holdSymbol");
  if (holdDrop && holdInput && !holdDrop.contains(e.target) && e.target !== holdInput) {
    holdDrop.style.display = "none";
  }
  // Signal Engine asset dropdown
  const sigDrop = document.getElementById("dropdown-signalSuggestions");
  const sigInput = document.getElementById("txt-signalSymbol");
  if (sigDrop && sigInput && !sigDrop.contains(e.target) && e.target !== sigInput) {
    sigDrop.style.display = "none";
  }
  // Backtest asset dropdown
  const btDrop = document.getElementById("dropdown-backtestSuggestions");
  const btInput = document.getElementById("txt-backtestSymbol");
  if (btDrop && btInput && !btDrop.contains(e.target) && e.target !== btInput) {
    btDrop.style.display = "none";
  }
  // Watchlist asset dropdown
  const watchDrop = document.getElementById("dropdown-watchSuggestions");
  const watchInput = document.getElementById("txt-watchSymbol");
  if (watchDrop && watchInput && !watchDrop.contains(e.target) && e.target !== watchInput) {
    watchDrop.style.display = "none";
  }
  // Audit asset dropdown
  const auditDrop = document.getElementById("dropdown-auditSuggestions");
  const auditInput = document.getElementById("txt-historySymbol");
  if (auditDrop && auditInput && !auditDrop.contains(e.target) && e.target !== auditInput) {
    auditDrop.style.display = "none";
  }
  // Admin asset dropdown
  const adminDrop = document.getElementById("dropdown-adminSuggestions");
  const adminInput = document.getElementById("txt-adminSymbol");
  if (adminDrop && adminInput && !adminDrop.contains(e.target) && e.target !== adminInput) {
    adminDrop.style.display = "none";
  }
});
