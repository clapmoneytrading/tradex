// Paper Trading & TradingView-style Strategy Tester for TradeX
window.TradingPanel = (() => {
  const STORE_KEY = "tradexPaperV1";
  const DEFAULT_CAP = 100000;
  let state = loadState();
  let prices = {};
  let reports = [];
  let activeReportIdx = 0;
  let activeMainTab = "paper";     // "paper" | "strategy"
  let activePaperTab = "positions"; // "positions" | "history"
  let activeStratTab = "overview";  // "overview" | "summary" | "trades"
  let bottomOpen = false;
  let lastRenderAt = 0;

  function loadState() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (d && typeof d.balance === "number") return d;
    } catch (_) {}
    return { balance: DEFAULT_CAP, realizedPnl: 0, positions: [], history: [] };
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
  }

  const curSym = () => (window.getActiveMarket && window.getActiveMarket().ticker) || (window.st && window.st.ticker) || "BTCUSD";
  const curTf = () => (window.getActiveMarket && window.getActiveMarket().tf) || (window.st && window.st.tf) || "";
  const ccy = (sym) => (/^NSE:|-EQ$|-INDEX$/i.test(sym || "") ? "₹" : "$");
  const fmtNum = (n, d = 2) => Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "-";
  const fmtMoney = (n, sym) => {
    if (!Number.isFinite(n)) return "-";
    const sign = n < 0 ? "-" : "";
    return `${sign}${ccy(sym)}${fmtNum(Math.abs(n), 2)}`;
  };
  const fmtTime = (t) => {
    if (!t) return "-";
    const ms = t > 1e12 ? t : t * 1000;
    const d = new Date(ms);
    return d.toISOString().slice(0, 16).replace("T", " ");
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function livePrice(sym) {
    return prices[sym];
  }

  function calcUnrealized(p) {
    const ltp = prices[p.symbol];
    if (!Number.isFinite(ltp)) return 0;
    return (p.side === "long" ? ltp - p.entryPrice : p.entryPrice - ltp) * p.qty;
  }

  function closePosition(id, exitPrice, reason = "Manual") {
    const idx = state.positions.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const p = state.positions[idx];
    const px = Number.isFinite(exitPrice) ? exitPrice : (prices[p.symbol] ?? p.entryPrice);
    const pnl = (p.side === "long" ? px - p.entryPrice : p.entryPrice - px) * p.qty;
    state.balance += pnl;
    state.realizedPnl += pnl;
    state.history.unshift({
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      qty: p.qty,
      entryPrice: p.entryPrice,
      exitPrice: px,
      pnl,
      pct: p.entryPrice ? (pnl / (p.entryPrice * p.qty)) * 100 : 0,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      reason,
    });
    if (state.history.length > 200) state.history.length = 200;
    state.positions.splice(idx, 1);
    saveState();
    render();
  }

  function placeOrder(side, qtyInput, slInput, tpInput) {
    const sym = curSym();
    const px = prices[sym];
    if (!Number.isFinite(px) || px <= 0) {
      alert("Waiting for live price on " + sym + "...");
      return;
    }
    const qty = Math.max(0.0001, Number(qtyInput) || 1);
    const sl = slInput ? Number(slInput) : null;
    const tp = tpInput ? Number(tpInput) : null;

    // Check if there is an existing position on the same symbol
    const oppSide = side === "long" ? "short" : "long";
    const oppIdx = state.positions.findIndex((p) => p.symbol === sym && p.side === oppSide);
    if (oppIdx >= 0) {
      const opp = state.positions[oppIdx];
      if (qty >= opp.qty) {
        const rem = qty - opp.qty;
        closePosition(opp.id, px, "Reverse/Close");
        if (rem > 1e-8) {
          state.positions.unshift({ id: Date.now() + Math.random(), symbol: sym, side, qty: rem, entryPrice: px, sl, tp, openedAt: Date.now() });
        }
      } else {
        const pnl = (opp.side === "long" ? px - opp.entryPrice : opp.entryPrice - px) * qty;
        state.balance += pnl;
        state.realizedPnl += pnl;
        opp.qty -= qty;
        state.history.unshift({
          id: Date.now(), symbol: sym, side: opp.side, qty, entryPrice: opp.entryPrice, exitPrice: px, pnl,
          pct: opp.entryPrice ? (pnl / (opp.entryPrice * qty)) * 100 : 0, openedAt: opp.openedAt, closedAt: Date.now(), reason: "Partial Close",
        });
      }
    } else {
      const same = state.positions.find((p) => p.symbol === sym && p.side === side);
      if (same) {
        const tot = same.qty + qty;
        same.entryPrice = (same.entryPrice * same.qty + px * qty) / tot;
        same.qty = tot;
        if (sl) same.sl = sl;
        if (tp) same.tp = tp;
      } else {
        state.positions.unshift({ id: Date.now() + Math.random(), symbol: sym, side, qty, entryPrice: px, sl, tp, openedAt: Date.now() });
      }
    }
    saveState();
    if (!bottomOpen) open("paper");
    else render();
  }

  function resetAccount() {
    state = { balance: DEFAULT_CAP, realizedPnl: 0, positions: [], history: [] };
    saveState();
    render();
  }

  function onTick(symbol, price) {
    if (!symbol || !Number.isFinite(price)) return;
    prices[symbol] = price;
    // Update quick-trade price badge
    const qp = document.getElementById("qtPrice");
    if (qp && symbol === curSym()) {
      qp.textContent = fmtNum(price, price < 10 ? 4 : 2);
    }
    // Check SL / TP triggers
    const toClose = [];
    for (const p of state.positions) {
      if (p.symbol !== symbol) continue;
      if (p.side === "long") {
        if (p.sl && price <= p.sl) toClose.push([p.id, p.sl, "Stop Loss"]);
        else if (p.tp && price >= p.tp) toClose.push([p.id, p.tp, "Take Profit"]);
      } else {
        if (p.sl && price >= p.sl) toClose.push([p.id, p.sl, "Stop Loss"]);
        else if (p.tp && price <= p.tp) toClose.push([p.id, p.tp, "Take Profit"]);
      }
    }
    toClose.forEach(([id, px, r]) => closePosition(id, px, r));
    if (bottomOpen && activeMainTab === "paper" && Date.now() - lastRenderAt > 400) {
      lastRenderAt = Date.now();
      renderPaperDynamic();
    }
  }

  // ---- Strategy Tester metrics (TradingView style) ----
  function normTrade(t) {
    const isLong = t.side ? t.side === "long" : (t.size || 0) >= 0;
    const qty = t.qty != null ? Math.abs(Number(t.qty)) : Math.abs(Number(t.size || 0));
    const entryId = (t.entry && t.entry.id) || t.entry_id || "";
    const entryTime = (t.entry && t.entry.time) ?? t.entry_time;
    const entryPrice = (t.entry && t.entry.price) ?? t.entry_price;
    const exitId = (t.exit && t.exit.id) || t.exit_id || "";
    const exitTime = (t.exit && t.exit.time) ?? t.exit_time;
    const exitPrice = (t.exit && t.exit.price) ?? t.exit_price;
    const isOpen = t.open != null ? !!t.open : (t.status === "open" || exitTime == null);
    const comm = Number(t.commission || 0);
    let profit = t.pnl != null ? Number(t.pnl) : (t.profit != null ? Number(t.profit) : NaN);
    if (!Number.isFinite(profit) && !isOpen && Number.isFinite(entryPrice) && Number.isFinite(exitPrice)) {
      profit = (isLong ? exitPrice - entryPrice : entryPrice - exitPrice) * qty - comm;
    }
    return {
      isLong, qty, entryId, entryTime, entryPrice, exitId, exitTime, exitPrice, isOpen, comm,
      profit: Number.isFinite(profit) ? profit : 0,
      maxRunup: Number(t.maxRunup ?? t.max_runup ?? 0),
      maxDrawdown: Number(t.maxDrawdown ?? t.max_drawdown ?? 0),
    };
  }

  function computeStats(rawTrades, initialCap = DEFAULT_CAP) {
    const trades = rawTrades.map(normTrade);
    const closed = trades.filter((t) => !t.isOpen);
    const open = trades.filter((t) => t.isOpen);

    function subset(list) {
      let net = 0, gp = 0, gl = 0, wins = 0, losses = 0, comm = 0, maxWin = 0, maxLoss = 0;
      let peak = initialCap, eq = initialCap, maxDD = 0, maxDDPct = 0;
      const curve = [initialCap];
      for (const t of list) {
        const p = t.profit;
        comm += t.comm;
        net += p;
        if (p > 0) { wins++; gp += p; if (p > maxWin) maxWin = p; }
        else if (p < 0) { losses++; gl += Math.abs(p); if (p < maxLoss) maxLoss = p; }
        eq += p;
        curve.push(eq);
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        if (dd > maxDD) maxDD = dd;
        const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
        if (ddPct > maxDDPct) maxDDPct = ddPct;
      }
      const n = list.length;
      const avg = n ? net / n : 0;
      const avgWin = wins ? gp / wins : 0;
      const avgLoss = losses ? gl / losses : 0;
      return {
        n, wins, losses,
        winRate: n ? (wins / n) * 100 : 0,
        net, netPct: initialCap ? (net / initialCap) * 100 : 0,
        gp, gl,
        pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0),
        maxDD, maxDDPct,
        avg, avgWin, avgLoss,
        ratio: avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0),
        maxWin, maxLoss, comm, curve,
      };
    }

    const all = subset(closed);
    const longs = subset(closed.filter((t) => t.isLong));
    const shorts = subset(closed.filter((t) => !t.isLong));
    const openPnl = open.reduce((s, t) => s + t.profit, 0);
    return { all, longs, shorts, trades, closed, open, openPnl, initialCap };
  }

  function onStrategyReport(rep, isActivePane = true) {
    if (!rep || !Array.isArray(rep.trades)) return;
    let idx = reports.findIndex((r) => r.title === rep.title && r.symbol === rep.symbol && r.tf === rep.tf);
    if (idx >= 0) {
      reports[idx] = rep;
    } else {
      reports.unshift(rep);
      idx = 0;
    }
    const matchesCurrent = rep.symbol === curSym() && (!curTf() || rep.tf === curTf());
    if (isActivePane || matchesCurrent || reports.length === 1) {
      activeReportIdx = idx;
    }
    const activeRep = reports[activeReportIdx] || rep;
    const badge = document.getElementById("stratBadge");
    if (badge) badge.textContent = String(activeRep.trades.length);
    if (bottomOpen) render();
  }

  function onSymbolChange(sym, tf) {
    if (!reports.length || !sym) return;
    const idx = reports.findIndex((r) => r.symbol === sym && (!tf || r.tf === tf));
    const fallback = idx >= 0 ? idx : reports.findIndex((r) => r.symbol === sym);
    if (fallback >= 0) {
      activeReportIdx = fallback;
      const badge = document.getElementById("stratBadge");
      if (badge) badge.textContent = String(reports[fallback].trades.length);
    }
    if (bottomOpen && activeMainTab === "strategy") render();
  }

  function open(tab) {
    if (tab) activeMainTab = tab;
    bottomOpen = true;
    const el = document.getElementById("bottom");
    if (el) el.hidden = false;
    updateToggleButtons();
    render();
  }

  function close() {
    bottomOpen = false;
    const el = document.getElementById("bottom");
    if (el) el.hidden = true;
    updateToggleButtons();
  }

  function toggle(tab) {
    if (bottomOpen && activeMainTab === tab) close();
    else open(tab);
  }

  function updateToggleButtons() {
    const bp = document.getElementById("btnPaper");
    const bs = document.getElementById("btnStrat");
    if (bp) bp.classList.toggle("on", bottomOpen && activeMainTab === "paper");
    if (bs) bs.classList.toggle("on", bottomOpen && activeMainTab === "strategy");
  }

  function renderPaperDynamic() {
    const sym = curSym();
    const unrl = state.positions.reduce((s, p) => s + calcUnrealized(p), 0);
    const eq = state.balance + unrl;
    const eqEl = document.getElementById("ptEquity");
    const unEl = document.getElementById("ptUnrl");
    if (eqEl) eqEl.textContent = fmtMoney(eq, sym);
    if (unEl) {
      unEl.textContent = fmtMoney(unrl, sym);
      unEl.className = unrl >= 0 ? "pos" : "neg";
    }
    state.positions.forEach((p) => {
      const ltpEl = document.querySelector(`[data-pt-ltp="${p.id}"]`);
      const pnlEl = document.querySelector(`[data-pt-pnl="${p.id}"]`);
      const ltp = prices[p.symbol];
      if (ltpEl) ltpEl.textContent = Number.isFinite(ltp) ? fmtNum(ltp, ltp < 10 ? 4 : 2) : "-";
      if (pnlEl) {
        const u = calcUnrealized(p);
        pnlEl.textContent = fmtMoney(u, p.symbol);
        pnlEl.className = u >= 0 ? "pos" : "neg";
      }
    });
  }

  function renderEquitySvg(curve, initialCap) {
    if (!curve || curve.length < 2) return `<div class="tp-empty">Not enough trades for equity curve.</div>`;
    const w = 680, h = 115, pad = 8;
    const min = Math.min(...curve, initialCap);
    const max = Math.max(...curve, initialCap);
    const span = max - min || 1;
    const pts = curve.map((v, i) => {
      const x = pad + (i / (curve.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const baseY = (h - pad - ((initialCap - min) / span) * (h - pad * 2)).toFixed(1);
    const up = curve[curve.length - 1] >= initialCap;
    const col = up ? "var(--ok, #34d399)" : "var(--bad, #f87171)";
    return `<svg viewBox="0 0 ${w} ${h}" class="st-svg" preserveAspectRatio="none">
      <line x1="${pad}" y1="${baseY}" x2="${w - pad}" y2="${baseY}" stroke="var(--line)" stroke-dasharray="3 3"/>
      <polyline fill="none" stroke="${col}" stroke-width="2" points="${pts}"/>
    </svg>`;
  }

  function render() {
    const box = document.getElementById("bottom");
    if (!box || !bottomOpen) return;
    const sym = curSym();
    const ltp = prices[sym];
    const unrl = state.positions.reduce((s, p) => s + calcUnrealized(p), 0);
    const eq = state.balance + unrl;

    box.innerHTML = `
      <div class="tp-hdr">
        <div class="tp-tabs">
          <button type="button" data-mt="paper" class="${activeMainTab === "paper" ? "on" : ""}">Paper Trading (${state.positions.length})</button>
          <button type="button" data-mt="strategy" class="${activeMainTab === "strategy" ? "on" : ""}">Strategy Tester (${reports.length})</button>
        </div>
        <div class="tp-acts">
          <button type="button" class="tp-close" title="Close panel">×</button>
        </div>
      </div>
      <div class="tp-body" id="tpBody"></div>
    `;

    box.querySelectorAll("[data-mt]").forEach((b) => {
      b.onclick = () => { activeMainTab = b.dataset.mt; updateToggleButtons(); render(); };
    });
    box.querySelector(".tp-close").onclick = close;

    const body = document.getElementById("tpBody");
    if (activeMainTab === "paper") {
      body.innerHTML = `
        <div class="pt-bar">
          <div class="pt-stats">
            <span>Balance: <b>${fmtMoney(state.balance, sym)}</b></span>
            <span>Equity: <b id="ptEquity">${fmtMoney(eq, sym)}</b></span>
            <span>Open P&amp;L: <b id="ptUnrl" class="${unrl >= 0 ? "pos" : "neg"}">${fmtMoney(unrl, sym)}</b></span>
            <span>Realized: <b class="${state.realizedPnl >= 0 ? "pos" : "neg"}">${fmtMoney(state.realizedPnl, sym)}</b></span>
          </div>
          <div class="pt-order">
            <span class="pt-sym">${esc(sym)} @ <b>${Number.isFinite(ltp) ? fmtNum(ltp, ltp < 10 ? 4 : 2) : "..."}</b></span>
            <label>Qty <input id="ptQty" type="number" min="0.001" step="any" value="1"></label>
            <label>SL <input id="ptSL" type="number" step="any" placeholder="Optional"></label>
            <label>TP <input id="ptTP" type="number" step="any" placeholder="Optional"></label>
            <button type="button" class="btn-buy" id="ptBuy">Buy</button>
            <button type="button" class="btn-sell" id="ptSell">Sell</button>
            <button type="button" class="btn" id="ptReset" title="Reset paper account to 100,000">Reset</button>
          </div>
        </div>
        <div class="tp-subtabs">
          <button type="button" data-pt="positions" class="${activePaperTab === "positions" ? "on" : ""}">Positions (${state.positions.length})</button>
          <button type="button" data-pt="history" class="${activePaperTab === "history" ? "on" : ""}">Trade History (${state.history.length})</button>
        </div>
        <div class="tp-scroll" id="ptTable"></div>
      `;
      body.querySelectorAll("[data-pt]").forEach((b) => { b.onclick = () => { activePaperTab = b.dataset.pt; render(); }; });
      document.getElementById("ptBuy").onclick = () => placeOrder("long", document.getElementById("ptQty").value, document.getElementById("ptSL").value, document.getElementById("ptTP").value);
      document.getElementById("ptSell").onclick = () => placeOrder("short", document.getElementById("ptQty").value, document.getElementById("ptSL").value, document.getElementById("ptTP").value);
      document.getElementById("ptReset").onclick = resetAccount;

      const tbl = document.getElementById("ptTable");
      if (activePaperTab === "positions") {
        if (!state.positions.length) {
          tbl.innerHTML = `<div class="tp-empty">No open paper positions. Click Buy or Sell above to place a simulated trade on ${esc(sym)}.</div>`;
        } else {
          tbl.innerHTML = `<table class="tp-tbl"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg Entry</th><th>LTP</th><th>SL</th><th>TP</th><th>Unrealized P&amp;L</th><th></th></tr></thead><tbody>${
            state.positions.map((p) => {
              const u = calcUnrealized(p);
              const cl = prices[p.symbol];
              return `<tr>
                <td><b>${esc(p.symbol)}</b></td>
                <td class="${p.side === "long" ? "pos" : "neg"}">${p.side.toUpperCase()}</td>
                <td>${p.qty}</td>
                <td>${fmtNum(p.entryPrice, p.entryPrice < 10 ? 4 : 2)}</td>
                <td data-pt-ltp="${p.id}">${Number.isFinite(cl) ? fmtNum(cl, cl < 10 ? 4 : 2) : "-"}</td>
                <td>${p.sl ? fmtNum(p.sl, 2) : "-"}</td>
                <td>${p.tp ? fmtNum(p.tp, 2) : "-"}</td>
                <td data-pt-pnl="${p.id}" class="${u >= 0 ? "pos" : "neg"}">${fmtMoney(u, p.symbol)}</td>
                <td><button type="button" class="btn" data-close-pos="${p.id}">Close</button></td>
              </tr>`;
            }).join("")
          }</tbody></table>`;
          tbl.querySelectorAll("[data-close-pos]").forEach((b) => { b.onclick = () => closePosition(Number(b.dataset.closePos)); });
        }
      } else {
        if (!state.history.length) {
          tbl.innerHTML = `<div class="tp-empty">No closed paper trades yet.</div>`;
        } else {
          tbl.innerHTML = `<table class="tp-tbl"><thead><tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Reason</th><th>P&amp;L</th></tr></thead><tbody>${
            state.history.map((h) => `<tr>
              <td>${fmtTime(h.closedAt)}</td>
              <td><b>${esc(h.symbol)}</b></td>
              <td class="${h.side === "long" ? "pos" : "neg"}">${h.side.toUpperCase()}</td>
              <td>${h.qty}</td>
              <td>${fmtNum(h.entryPrice, h.entryPrice < 10 ? 4 : 2)}</td>
              <td>${fmtNum(h.exitPrice, h.exitPrice < 10 ? 4 : 2)}</td>
              <td>${esc(h.reason || "-")}</td>
              <td class="${h.pnl >= 0 ? "pos" : "neg"}">${fmtMoney(h.pnl, h.symbol)} (${h.pct >= 0 ? "+" : ""}${h.pct.toFixed(2)}%)</td>
            </tr>`).join("")
          }</tbody></table>`;
        }
      }
      return;
    }

    // ---- Strategy Tester ----
    if (!reports.length) {
      body.innerHTML = `<div class="tp-empty">No Pine strategy report yet. Add a <code>strategy(...)</code> script (e.g. from Indicators or Pine Editor) on the Vela chart to see the TradingView-style Strategy Report here.</div>`;
      return;
    }
    const rep = reports[activeReportIdx] || reports[0];
    const initCap = (rep.strategy && Number(rep.strategy.initialCapital) > 0) ? Number(rep.strategy.initialCapital) : DEFAULT_CAP;
    const st = computeStats(rep.trades, initCap);
    const sSym = rep.symbol || sym;

    body.innerHTML = `
      <div class="tp-subtabs">
        <select id="stPick" class="st-pick">${reports.map((r, i) => `<option value="${i}" ${i === activeReportIdx ? "selected" : ""}>${esc(r.title)} (${esc(r.symbol)} · ${esc(r.tf || "")})</option>`).join("")}</select>
        <button type="button" data-st="overview" class="${activeStratTab === "overview" ? "on" : ""}">Overview</button>
        <button type="button" data-st="summary" class="${activeStratTab === "summary" ? "on" : ""}">Performance Summary</button>
        <button type="button" data-st="trades" class="${activeStratTab === "trades" ? "on" : ""}">List of Trades (${rep.trades.length})</button>
      </div>
      <div class="tp-scroll" id="stBody"></div>
    `;
    document.getElementById("stPick").onchange = (e) => {
      activeReportIdx = Number(e.target.value);
      const badge = document.getElementById("stratBadge");
      const picked = reports[activeReportIdx];
      if (badge && picked) badge.textContent = String(picked.trades.length);
      render();
    };
    body.querySelectorAll("[data-st]").forEach((b) => { b.onclick = () => { activeStratTab = b.dataset.st; render(); }; });

    const sb = document.getElementById("stBody");
    if (activeStratTab === "overview") {
      const a = st.all;
      sb.innerHTML = `
        <div class="st-kpis">
          <div class="st-kpi"><span>Net Profit</span><b class="${a.net >= 0 ? "pos" : "neg"}">${fmtMoney(a.net, sSym)}</b><small class="${a.netPct >= 0 ? "pos" : "neg"}">${a.netPct >= 0 ? "+" : ""}${a.netPct.toFixed(2)}%</small></div>
          <div class="st-kpi"><span>Total Closed Trades</span><b>${a.n}</b><small>${a.wins}W / ${a.losses}L</small></div>
          <div class="st-kpi"><span>Percent Profitable</span><b>${a.winRate.toFixed(2)}%</b><small>Win rate</small></div>
          <div class="st-kpi"><span>Profit Factor</span><b>${Number.isFinite(a.pf) ? a.pf.toFixed(3) : "∞"}</b><small>GP / GL</small></div>
          <div class="st-kpi"><span>Max Drawdown</span><b class="neg">${fmtMoney(-a.maxDD, sSym)}</b><small class="neg">${a.maxDDPct.toFixed(2)}%</small></div>
          <div class="st-kpi"><span>Avg Trade</span><b class="${a.avg >= 0 ? "pos" : "neg"}">${fmtMoney(a.avg, sSym)}</b><small>Open P&amp;L: ${fmtMoney(st.openPnl, sSym)}</small></div>
        </div>
        <div class="st-chart">${renderEquitySvg(a.curve, st.initialCap)}</div>
      `;
    } else if (activeStratTab === "summary") {
      const { all, longs, shorts } = st;
      const pct = (v) => initCap > 0 ? ` <small>(${v >= 0 ? "+" : ""}${((v / initCap) * 100).toFixed(2)}%)</small>` : "";
      const rows = [
        ["Net Profit", fmtMoney(all.net, sSym) + pct(all.net), fmtMoney(longs.net, sSym) + pct(longs.net), fmtMoney(shorts.net, sSym) + pct(shorts.net)],
        ["Gross Profit", fmtMoney(all.gp, sSym) + pct(all.gp), fmtMoney(longs.gp, sSym) + pct(longs.gp), fmtMoney(shorts.gp, sSym) + pct(shorts.gp)],
        ["Gross Loss", fmtMoney(-all.gl, sSym) + pct(-all.gl), fmtMoney(-longs.gl, sSym) + pct(-longs.gl), fmtMoney(-shorts.gl, sSym) + pct(-shorts.gl)],
        ["Max Drawdown", `${fmtMoney(-all.maxDD, sSym)} <small>(${all.maxDDPct.toFixed(2)}%)</small>`, `${fmtMoney(-longs.maxDD, sSym)} <small>(${longs.maxDDPct.toFixed(2)}%)</small>`, `${fmtMoney(-shorts.maxDD, sSym)} <small>(${shorts.maxDDPct.toFixed(2)}%)</small>`],
        ["Profit Factor", Number.isFinite(all.pf) ? all.pf.toFixed(3) : "∞", Number.isFinite(longs.pf) ? longs.pf.toFixed(3) : "∞", Number.isFinite(shorts.pf) ? shorts.pf.toFixed(3) : "∞"],
        ["Total Closed Trades", all.n, longs.n, shorts.n],
        ["Number Winning Trades", all.wins, longs.wins, shorts.wins],
        ["Number Losing Trades", all.losses, longs.losses, shorts.losses],
        ["Percent Profitable", `${all.winRate.toFixed(2)}%`, `${longs.winRate.toFixed(2)}%`, `${shorts.winRate.toFixed(2)}%`],
        ["Avg Trade", fmtMoney(all.avg, sSym) + pct(all.avg), fmtMoney(longs.avg, sSym) + pct(longs.avg), fmtMoney(shorts.avg, sSym) + pct(shorts.avg)],
        ["Avg Winning Trade", fmtMoney(all.avgWin, sSym) + pct(all.avgWin), fmtMoney(longs.avgWin, sSym) + pct(longs.avgWin), fmtMoney(shorts.avgWin, sSym) + pct(shorts.avgWin)],
        ["Avg Losing Trade", fmtMoney(-all.avgLoss, sSym) + pct(-all.avgLoss), fmtMoney(-longs.avgLoss, sSym) + pct(-longs.avgLoss), fmtMoney(-shorts.avgLoss, sSym) + pct(-shorts.avgLoss)],
        ["Ratio Avg Win / Avg Loss", Number.isFinite(all.ratio) ? all.ratio.toFixed(3) : "∞", Number.isFinite(longs.ratio) ? longs.ratio.toFixed(3) : "∞", Number.isFinite(shorts.ratio) ? shorts.ratio.toFixed(3) : "∞"],
        ["Largest Winning Trade", fmtMoney(all.maxWin, sSym), fmtMoney(longs.maxWin, sSym), fmtMoney(shorts.maxWin, sSym)],
        ["Largest Losing Trade", fmtMoney(all.maxLoss, sSym), fmtMoney(longs.maxLoss, sSym), fmtMoney(shorts.maxLoss, sSym)],
        ["Total Commission", fmtMoney(all.comm, sSym), fmtMoney(longs.comm, sSym), fmtMoney(shorts.comm, sSym)],
      ];
      sb.innerHTML = `<table class="tp-tbl"><thead><tr><th>Metric</th><th>All</th><th>Long</th><th>Short</th></tr></thead><tbody>${
        rows.map((r) => `<tr><td>${r[0]}</td><td><b>${r[1]}</b></td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("")
      }</tbody></table>`;
    } else {
      let cum = 0;
      sb.innerHTML = `<table class="tp-tbl"><thead><tr><th>#</th><th>Type</th><th>Signal</th><th>Entry Time</th><th>Entry Price</th><th>Exit Time</th><th>Exit Price</th><th>Qty</th><th>Profit</th><th>Cum. Profit</th><th>Run-up</th><th>Drawdown</th></tr></thead><tbody>${
        st.trades.map((t, idx) => {
          if (!t.isOpen) cum += t.profit;
          const notional = (Number(t.entryPrice) || 0) * (t.qty || 0);
          const retPct = notional > 0 ? (t.profit / notional) * 100 : 0;
          const cumPct = initCap > 0 ? (cum / initCap) * 100 : 0;
          return `<tr>
            <td>${idx + 1}</td>
            <td class="${t.isLong ? "pos" : "neg"}">${t.isLong ? "Long" : "Short"}${t.isOpen ? " (Open)" : ""}</td>
            <td>${esc(t.entryId)}${t.exitId ? " → " + esc(t.exitId) : ""}</td>
            <td>${fmtTime(t.entryTime)}</td>
            <td>${t.entryPrice != null ? fmtNum(Number(t.entryPrice), t.entryPrice < 10 ? 4 : 2) : "-"}</td>
            <td>${t.exitTime ? fmtTime(t.exitTime) : "-"}</td>
            <td>${t.exitPrice != null ? fmtNum(Number(t.exitPrice), t.exitPrice < 10 ? 4 : 2) : "-"}</td>
            <td>${t.qty.toFixed(t.qty < 1 ? 4 : 2)}</td>
            <td class="${t.profit >= 0 ? "pos" : "neg"}">${fmtMoney(t.profit, sSym)} <small>(${retPct >= 0 ? "+" : ""}${retPct.toFixed(2)}%)</small></td>
            <td class="${cum >= 0 ? "pos" : "neg"}">${fmtMoney(cum, sSym)} <small>(${cumPct >= 0 ? "+" : ""}${cumPct.toFixed(2)}%)</small></td>
            <td>${fmtMoney(t.maxRunup, sSym)}</td>
            <td class="neg">${fmtMoney(-Math.abs(t.maxDrawdown), sSym)}</td>
          </tr>`;
        }).join("")
      }</tbody></table>`;
    }
  }

  return { onTick, onStrategyReport, onSymbolChange, placeOrder, open, close, toggle, render };
})();
