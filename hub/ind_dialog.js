// TradeX indicators, part 2: the "Indicators, metrics, and strategies" dialog.
// Left: Personal (Favorites, My scripts, On chart) / Built-in (Vela native). Right: list. Clicking a row adds it to the chart.
// Your own Pine Script (v1-v6) comes in through the Pine Editor ("My scripts").
const SECTIONS = [
  ["PERSONAL", [["fav", "Favorites"], ["mine", "My scripts"], ["chart", "On chart"]]],
  ["BUILT-IN", [["vela", "Vela native"]]],
];
let dlg = { sec: "vela", chip: "1", q: "", search: null, rowMsg: {} };
const CAT = {};  // loaded lists, by "sec:chip"

function openIndDlg(sec, openId) {
  if (sec) { dlg.sec = sec; dlg.search = null; dlg.q = ""; }
  dlg.openId = openId || null;
  let d = $("indDlg");
  if (!d) {
    d = document.createElement("div"); d.id = "indDlg"; d.hidden = true;
    d.innerHTML = `<div class="dlg" role="dialog" aria-label="Indicators, metrics, and strategies">
      <div class="dlg-h"><span>Indicators, metrics, and strategies</span><button class="dlg-x" title="Close">&times;</button></div>
      <div class="dlg-s"><input placeholder="Search" spellcheck="false" autocomplete="off"></div>
      <div class="dlg-b"><nav class="dlg-nav"></nav><div class="dlg-main"><div class="dlg-chips"></div><div class="dlg-list"></div></div></div></div>`;
    document.body.appendChild(d);
    d.onclick = (e) => { if (e.target === d) closeIndDlg(); };
    d.querySelector(".dlg-x").onclick = closeIndDlg;
    const inp = d.querySelector(".dlg-s input");
    inp.oninput = () => { dlg.q = inp.value.trim(); if (!dlg.q) dlg.search = null; renderIndList(); };
    inp.onkeydown = (e) => { if (e.key === "Escape") closeIndDlg(); };
  }
  d.hidden = false; renderIndDialog(); setTimeout(() => d.querySelector(".dlg-s input").focus(), 0);
}
function closeIndDlg() { const d = $("indDlg"); if (d) d.hidden = true; }

function renderIndDialog() {
  const nav = $("indDlg").querySelector(".dlg-nav"); nav.innerHTML = "";
  SECTIONS.forEach(([title, items]) => {
    nav.insertAdjacentHTML("beforeend", `<div class="dlg-gh">${title}</div>`);
    items.forEach(([id, label]) => {
      const b = document.createElement("button"); b.className = "dlg-ni" + (dlg.sec === id && !dlg.search ? " on" : "");
      b.textContent = label + (id === "chart" ? ` (${INDS.length})` : id === "fav" && FAVS.length ? ` (${FAVS.length})` : id === "mine" && MINE.length ? ` (${MINE.length})` : "");
      b.onclick = () => { dlg.sec = id; dlg.search = null; dlg.q = ""; $("indDlg").querySelector(".dlg-s input").value = ""; renderIndDialog(); };
      nav.appendChild(b);
    });
  });
  const pe = document.createElement("button"); pe.className = "dlg-ni dlg-pine"; pe.textContent = "Open Pine Editor";
  pe.onclick = () => { closeIndDlg(); openPanelByName("pine"); }; nav.appendChild(pe);
  renderIndList();
}

// ---- data per section, normalised to rows {src, id, name, sub, likes, open, kind, type} ----
async function loadCat(sec, chip) {
  const k = sec + ":" + chip; if (CAT[k]) return CAT[k];
  let rows = [];
  if (sec === "vela") {
    const r = await ask("native:list");
    rows = (r.list || []).map((n) => ({ src: "vela", id: "vela:" + n.type, type: n.type, name: n.title, sub: "Vela built-in, computed natively", open: n.supported, kind: "indicator", beta: n.beta, present: n.present, multi: n.multi }));
    if (!r.ok) rows.err = st.engine === "vela" ? (r.error || "Vela did not answer") : "Vela native indicators need the Vela engine.";
  } else {
    rows.err = "Unknown list.";
  }
  if (!rows.err) CAT[k] = rows; return rows;
}

// ---- right side: chips + list ----
const isFav = (r) => FAVS.some((f) => f.id === r.id);
function toggleFav(r) { if (isFav(r)) FAVS = FAVS.filter((f) => f.id !== r.id); else FAVS.push({ src: r.src, id: r.id, type: r.type, name: r.name, sub: r.sub, open: r.open, kind: r.kind, likes: r.likes }); keep("chartHubFavs", FAVS); renderIndDialog(); }

async function renderIndList() {
  const D = $("indDlg"); if (!D || D.hidden) return;
  const chips = D.querySelector(".dlg-chips"), L = D.querySelector(".dlg-list"), sec = dlg.search ? "search" : dlg.sec;
  const chipSecs = [];
  chips.innerHTML = "";
  if (chipSecs.includes(sec)) [["1", "Indicators"], ["2", "Strategies"]].forEach(([c, n]) => {
    const b = document.createElement("button"); b.textContent = n; b.className = dlg.chip === c ? "on" : "";
    b.onclick = () => { dlg.chip = c; renderIndList(); }; chips.appendChild(b);
  });
  if (sec === "chart") return renderOnChart(L);
  let rows;
  if (sec === "fav") rows = FAVS;
  else if (sec === "mine") rows = MINE.map((m) => ({ src: "mine", id: "mine:" + m.id, mineId: m.id, name: m.name, sub: "your Pine" + (m.pine ? " v" + m.pine : ""), open: true, kind: "indicator" }));
  else { L.innerHTML = '<div class="dlg-empty">Loading...</div>'; rows = await loadCat(sec, sec === "vela" ? "1" : dlg.chip); if ((dlg.search ? "search" : dlg.sec) !== sec) return; }
  if (rows.err) { L.innerHTML = `<div class="dlg-empty">${esc(rows.err)}</div>`; return; }
  if (dlg.q) { const q = dlg.q.toLowerCase(); rows = rows.filter((r) => (r.name + " " + (r.sub || "")).toLowerCase().includes(q)); }
  L.innerHTML = `<div class="dlg-colh">SCRIPT NAME</div>`;
  if (!rows.length) L.insertAdjacentHTML("beforeend", `<div class="dlg-empty">${sec === "fav" ? "No favourites yet. Star any script to keep it here." : sec === "mine" ? "No scripts yet. Write or import one in the Pine Editor." : dlg.q ? `Nothing here matches "${esc(dlg.q)}".` : "Nothing in this list."}</div>`);
  rows.forEach((r) => {
    const row = document.createElement("div"); row.className = "dlg-row" + (r.open === false ? " locked" : ""); const msg = dlg.rowMsg[r.id];
    row.innerHTML = `<button class="star${isFav(r) ? " on" : ""}" title="Favourite"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg></button>
      <div class="nm">${esc(r.name)}${r.beta ? '<span class="badge">beta</span>' : ""}${r.open === false ? `<span class="badge">${r.src === "vela" ? "not for this symbol" : "protected"}</span>` : ""}</div>
      <div class="sub">${esc(r.sub || "")}${r.likes ? " · " + Number(r.likes).toLocaleString() + " boosts" : ""}</div>
      ${msg ? `<div class="msg ${msg.bad ? "bad" : ""}">${esc(msg.text)}</div>` : ""}`;
    row.querySelector(".star").onclick = (e) => { e.stopPropagation(); toggleFav(r); };
    row.onclick = () => addRow(r);
    L.appendChild(row);
  });
}

// Click a row: add one instance (clicking again adds another).
async function addRow(r) {
  const flash = (text, bad) => { dlg.rowMsg[r.id] = { text, bad }; renderIndList(); };
  if (r.open === false) return flash("This Vela indicator needs data this symbol does not have.", true);
  if (r.src !== "vela" && r.kind === "library") return flash("Libraries are building blocks for other scripts, not indicators.", true);
  if (r.src === "vela" && st.engine !== "vela") return flash("Switch the engine to Vela to use Vela native indicators.", true);
  if (r.src === "vela") {  // single-instance natives (Volume, VPVR): say so instead of a fake "Added"
    const live = ((await ask("native:list")).list || []).find((n) => n.type === r.type);
    if (live && live.present && !live.multi) return flash("Already on the chart (one per chart). Use its gear on the chart to change it.", true);
  }
  const stamp = Date.now().toString(36);
  let ind;
  const curPane = typeof activePane === "number" ? activePane : 0;
  if (r.src === "vela") ind = { key: `native:${r.type}:${stamp}`, kind: "native", type: r.type, name: r.name, origin: "Vela", pane: curPane, on: true };
  else if (r.src === "mine") { const m = MINE.find((x) => x.id === r.mineId); if (!m) return; ind = { key: `own:${m.id}:${stamp}`, mineId: m.id, name: m.name, origin: "own", source: m.source, pane: curPane, on: true }; }
  else return flash("This script is not available here.", true);
  ind.rowId = r.id; INDS.push(ind); saveInds(); flash("Adding to the chart...");
  if (!["vela", "lightweight"].includes(st.engine)) flash("Pine draws on Vela or Lightweight: switching to Vela...");
  pineAdd(ind);  // on another engine this switches to Vela, which then draws every indicator that is on
}
// Results land here (via indChanged) and show on the row that added them.
function rowResult(ind) {
  if (!ind.rowId) return;
  if (busy[ind.key]) return;
  const conv = ind.convFrom ? ` (converted from Pine v${ind.convFrom})` : "";
  dlg.rowMsg[ind.rowId] = ind.err ? { text: "Could not draw: " + ind.err, bad: true } : ind.wait ? { text: "On, but it draws on the Vela engine only: switch the engine to Vela to see it." } : liveIds[ind.key] ? (ind.pending ? { text: "Placed on the chart, but it has not drawn yet: waiting for chart data (is the feed up?)", bad: true } : { text: "Added to the chart" + conv }) : dlg.rowMsg[ind.rowId];
}

function renderOnChart(L) {
  L.innerHTML = `<div class="dlg-colh">ON THIS CHART</div>`;
  if (!INDS.length) { L.insertAdjacentHTML("beforeend", '<div class="dlg-empty">Nothing on the chart yet. Pick one from Vela native, or write your own in the Pine Editor.</div>'); return; }
  INDS.forEach((ind) => {
    const row = document.createElement("div"); row.className = "dlg-row chart";
    const status = busy[ind.key] ? "loading..." : ind.on && liveIds[ind.key] ? (ind.pending ? "waiting for chart data" : "on chart") : ind.on ? (st.engine === "vela" ? "waiting for the chart" : "needs the Vela engine") : "hidden";
    const conv = ind.convFrom ? ` · converted from Pine v${ind.convFrom}` : ind.pine ? ` · Pine v${ind.pine}` : "";
    row.innerHTML = `<input type="checkbox" ${ind.on ? "checked" : ""} title="Show on chart">
      <div class="nm">${esc(ind.name)}</div><div class="sub">${esc(ind.origin)}${conv} · ${esc(status)}${ind.license ? " · " + esc(ind.license) : ""}</div>
      ${ind.err ? `<div class="msg bad">${esc(ind.err)}</div>` : ""}${ind.notes && ind.notes.length ? `<div class="msg">Converter: ${esc(ind.notes.join("; "))}</div>` : ""}
      <div class="acts">${ind.source ? '<button class="btn" data-a="style">Settings</button><button class="btn" data-a="edit">Edit a copy</button>' : ""}<button class="btn" data-a="rm">Remove</button></div>`;
    row.querySelector("input").onclick = (e) => { e.stopPropagation(); toggleInd(ind, e.target.checked); };
    row.querySelector('[data-a="rm"]').onclick = (e) => { e.stopPropagation(); removeInd(ind); };
    const ed = row.querySelector('[data-a="edit"]'); if (ed) ed.onclick = (e) => { e.stopPropagation(); closeIndDlg(); editorOpenSource(ind.name + " (copy)", ind.source); };
    const sb = row.querySelector('[data-a="style"]');
    const toggleBox = () => {
      const next = row.nextElementSibling;
      if (next && next.classList.contains("style-box")) { next.remove(); return; }
      const box = document.createElement("div"); box.className = "style-box";
      box.style.cssText = "margin:4px 10px 8px 34px;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:5px;display:flex;flex-direction:column;gap:8px;font-size:12px";
      const cur = ind.style || {};
      const row1 = document.createElement("div"); row1.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;align-items:center";
      row1.innerHTML = `<label>Style <select data-f="ls">
        <option value="default">Default (from script)</option>
        <option value="line">Line</option>
        <option value="line_breaks">Line with breaks</option>
        <option value="stepline">Step line</option>
        <option value="stepline_breaks">Step line with breaks</option>
        <option value="stepline_diamond">Step line with diamonds</option>
        <option value="circles">Circles</option>
        <option value="histogram">Histogram</option>
        <option value="area">Area</option>
      </select></label>
      <label>Colour <input type="color" data-f="col" value="${esc(cur.color || "#5fb3e0")}"></label>
      <label><input type="checkbox" data-f="useCol" ${cur.color ? "checked" : ""}> Custom colour</label>
      <label>Thickness <select data-f="lw"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>`;
      row1.querySelector('[data-f="ls"]').value = cur.lineStyle || "default";
      row1.querySelector('[data-f="lw"]').value = String(cur.lineWidth || 2);
      const applyStyleNow = () => {
        const useCol = row1.querySelector('[data-f="useCol"]').checked;
        setIndStyle(ind, {
          lineStyle: row1.querySelector('[data-f="ls"]').value,
          color: useCol ? row1.querySelector('[data-f="col"]').value : "",
          lineWidth: Number(row1.querySelector('[data-f="lw"]').value) || 2,
        });
      };
      row1.querySelector('[data-f="ls"]').onchange = applyStyleNow;
      row1.querySelector('[data-f="lw"]').onchange = applyStyleNow;
      row1.querySelector('[data-f="useCol"]').onchange = applyStyleNow;
      const onCol = () => {
        row1.querySelector('[data-f="useCol"]').checked = true;
        applyStyleNow();
      };
      row1.querySelector('[data-f="col"]').oninput = onCol;
      row1.querySelector('[data-f="col"]').onchange = onCol;
      box.appendChild(row1);
      const defs = (ind.inputDefs || []).filter((d) => !String(d.id || "").startsWith("__hubS"));
      const inpVals = { ...(ind.inputs || {}) };
      if (defs.length) {
        const row2 = document.createElement("div"); row2.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;align-items:center;border-top:1px solid var(--grid);padding-top:6px";
        defs.forEach((d) => {
          const id = d.id, val = id in inpVals ? inpVals[id] : d.defval;
          const lbl = document.createElement("label"); lbl.textContent = (d.title || id) + " ";
          let el;
          if (d.type === "bool") { el = document.createElement("input"); el.type = "checkbox"; el.checked = !!val; el.onchange = () => { inpVals[id] = el.checked; }; }
          else if (d.type === "color") {
            el = document.createElement("input"); el.type = "color";
            const s = String(val || "#5fb3e0");
            el.value = /^#[0-9a-f]{6}/i.test(s) ? s.slice(0, 7) : "#5fb3e0";
            el.oninput = el.onchange = () => { inpVals[id] = el.value; };
          }
          else if (Array.isArray(d.options) && d.options.length) { el = document.createElement("select"); d.options.forEach((o) => el.add(new Option(String(o), String(o)))); el.value = String(val); el.onchange = () => { inpVals[id] = el.value; }; }
          else if (d.type === "int" || d.type === "float") { el = document.createElement("input"); el.type = "number"; el.style.width = "64px"; if (d.minval != null) el.min = d.minval; if (d.maxval != null) el.max = d.maxval; el.step = d.type === "float" ? "any" : "1"; el.value = val != null ? val : ""; el.oninput = () => { inpVals[id] = d.type === "int" ? parseInt(el.value, 10) : parseFloat(el.value); }; }
          else { el = document.createElement("input"); el.type = "text"; el.style.width = "90px"; el.value = val != null ? String(val) : ""; el.oninput = () => { inpVals[id] = el.value; }; }
          lbl.appendChild(el); row2.appendChild(lbl);
        });
        box.appendChild(row2);
      }
      const applyBtn = document.createElement("button"); applyBtn.className = "btn"; applyBtn.textContent = "Apply"; applyBtn.style.alignSelf = "flex-start";
      applyBtn.onclick = () => {
        const useCol = row1.querySelector('[data-f="useCol"]').checked;
        setIndStyle(ind, {
          lineStyle: row1.querySelector('[data-f="ls"]').value,
          color: useCol ? row1.querySelector('[data-f="col"]').value : "",
          lineWidth: Number(row1.querySelector('[data-f="lw"]').value) || 2,
        });
        if (defs.length) setIndInputs(ind, inpVals);
      };
      box.appendChild(applyBtn);
      row.after(box);
    };
    if (sb) sb.onclick = (e) => { e.stopPropagation(); toggleBox(); };
    L.appendChild(row);
    if (dlg.openId && liveIds[ind.key] === dlg.openId && sb) { dlg.openId = null; toggleBox(); }
  });
  L.insertAdjacentHTML("beforeend", '<div class="dlg-empty">Settings (inputs, colours, visibility): click the indicator name on the chart legend, then the gear.</div>');
}
