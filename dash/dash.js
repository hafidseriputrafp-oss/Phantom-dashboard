const SERIES_COLORS = ["#d95926", "#3987e5", "#199e70"];
const LEVEL_OPTIONS = [["ok", "Hijau (OK)"], ["warn", "Kuning (waspada)"], ["danger", "Merah (bahaya)"], ["info", "Biru (info)"]];
const SIZE_OPTIONS = [["S", "S — kecil"], ["M", "M — sedang"], ["L", "L — lebar penuh"]];
const OP_OPTIONS = [["", "— tidak dipakai —"], [">", "di atas (>)"], ["<", "di bawah (<)"]];

const WIDGET_TYPES = {
  number: { label: "Kartu angka", icon: "🔢", latest: true, defaults: { title: "Angka", size: "S", unit: "", decimals: 1, icon: "📟", color: "#3987e5", contextKey: "" } },
  text: { label: "Waktu/teks dari context", icon: "🕒", latest: true, defaults: { title: "Waktu", size: "S", key: "waktu", icon: "🕒" } },
  code: { label: "Indikator kode", icon: "🚦", latest: true, defaults: { title: "Kode", size: "S", map: DEFAULT_CODE_MAP } },
  chart: { label: "Grafik garis", icon: "📈", latest: false, defaults: { title: "Grafik", size: "L", series: [{ variable: "", color: SERIES_COLORS[0] }], points: 50 } },
  table: { label: "Tabel riwayat", icon: "📋", latest: false, defaults: { title: "Riwayat", size: "L", rows: 20, contextKey: "waktu" } },
  status: { label: "Status online", icon: "🟢", latest: true, defaults: { title: "Status", size: "S", variable: "", onlineS: 30 } },
  control: { label: "Kontrol (tombol/toggle/slider)", icon: "🎛️", latest: true, defaults: { title: "Kontrol", size: "S", kind: "button", value: 1, buttonLabel: "Kirim", onLabel: "ON", onValue: 1, offLabel: "OFF", offValue: 0, min: 0, max: 100, step: 1, unit: "", color: "" } },
  link: { label: "Link / kamera", icon: "🔗", latest: false, defaults: { title: "Kamera", size: "S", url: "", linkKind: "camera", buttonLabel: "Buka ↗" } },
  note: { label: "Teks catatan", icon: "📝", latest: false, defaults: { title: "Catatan", size: "M", text: "" } },
};

const state = {
  id: new URLSearchParams(location.search).get("id") || "",
  cfg: null,
  editing: false,
  changed: false,
  latest: {},
  deviceErr: {},
  history: {},
  historyErr: {},
  charts: new Map(),
  ui: new Map(),
  sendQ: {},
  valuesTimer: null,
  historyTimer: null,
  loadingValues: false,
  loadingHistory: false,
};

/* ---------- Kebutuhan data ---------- */

const fmtNum = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const histKey = (device, variable) => `${device}|${variable}`;

function widgetsOf() {
  return (state.cfg && state.cfg.widgets) || [];
}

function latestDevices() {
  return [...new Set(widgetsOf().filter((w) => WIDGET_TYPES[w.type]?.latest && w.device).map((w) => w.device))];
}

function historyNeeds() {
  const needs = new Map();
  const add = (device, variable, n) => {
    if (!device || !variable) return;
    const k = histKey(device, variable);
    needs.set(k, { device, variable, n: Math.max(n, needs.get(k)?.n || 0) });
  };
  for (const w of widgetsOf()) {
    if (w.type === "chart") (w.series || []).forEach((s) => add(w.device, s.variable, w.points || 50));
    if (w.type === "table") add(w.device, w.variable, w.rows || 20);
    if (w.type === "text") {
      const dot = latestDot(w);
      if (dot && !dot.hasContext) add(w.device, w.variable, 1);
    }
  }
  return [...needs.values()];
}

function latestDot(w) {
  const vars = state.latest[w.device];
  return vars ? vars[w.variable] : undefined;
}

async function refreshValues() {
  clearTimeout(state.valuesTimer);
  if (!getToken() || document.hidden || !state.cfg || state.loadingValues) return;
  state.loadingValues = true;
  let firstTextFallback = false;
  for (const device of latestDevices()) {
    try {
      const hadContextInfo = Object.values(state.latest[device] || {}).length > 0;
      state.latest[device] = await readDevice(device);
      state.deviceErr[device] = null;
      if (!hadContextInfo) firstTextFallback = true;
      if (bannerKind === "ratelimit" || bannerKind === "auth") setBanner("");
    } catch (e) {
      state.deviceErr[device] = e;
      if (e.kind === "ratelimit" || e.kind === "auth" || e.kind === "network" || e.kind === "offline") setBanner(errorText(e), e.kind);
    }
  }
  state.loadingValues = false;
  updateAll();
  if (firstTextFallback && widgetsOf().some((w) => w.type === "text")) refreshHistory();
  state.valuesTimer = setTimeout(refreshValues, (state.cfg.refreshS || 5) * 1000);
}

async function refreshHistory() {
  clearTimeout(state.historyTimer);
  if (!getToken() || document.hidden || !state.cfg || state.loadingHistory) return;
  state.loadingHistory = true;
  for (const need of historyNeeds()) {
    const k = histKey(need.device, need.variable);
    try {
      state.history[k] = await readHistory(need.device, need.variable, need.n);
      state.historyErr[k] = null;
    } catch (e) {
      state.historyErr[k] = e;
      if (e.kind === "ratelimit" || e.kind === "auth") setBanner(errorText(e), e.kind);
    }
    updateAll();
  }
  state.loadingHistory = false;
  state.historyTimer = setTimeout(refreshHistory, (state.cfg.historyS || 30) * 1000);
}

function refreshSoon() {
  setTimeout(() => {
    refreshValues();
    refreshHistory();
  }, 300);
}

/* ---------- Render widget ---------- */

function widgetError(w, keyErr) {
  const e = keyErr || state.deviceErr[w.device];
  if (!e) return "";
  if (e.kind === "notfound") return `Device "${w.device}" atau variabel "${w.variable || "-"}" belum ada.`;
  return errorText(e);
}

function srcText(w) {
  if (w.type === "chart") return `${w.device} · ${(w.series || []).map((s) => s.variable).join(", ")}`;
  if (w.type === "link" || w.type === "note") return "";
  return w.variable ? `${w.device} · ${w.variable}` : w.device || "";
}

function baseCard(w, extraClass = "") {
  const card = el("div", `card widget w-${w.size || "S"} ${extraClass}`.trim());
  card.dataset.id = w.id;
  return card;
}

function head(w, icon) {
  const h = el("div", "w-head");
  if (icon) h.append(el("span", "sensor-icon", icon));
  h.append(el("span", "w-title", w.title || WIDGET_TYPES[w.type].label));
  return h;
}

const builders = {
  number(w) {
    const card = baseCard(w, "sensor");
    card.style.setProperty("--c", w.color || "#3987e5");
    const reading = el("div", "reading");
    const value = el("span", "value", "—");
    reading.append(value, el("span", "unit", w.unit || ""));
    const note = el("div", "note");
    const ctx = el("div", "ctx");
    const age = el("div", "age");
    const err = el("div", "w-error");
    card.append(head(w, w.icon || "📟"), reading, note, ctx, age, err);
    return { card, update: () => updateNumber(w, { card, value, note, ctx, age, err }) };
  },
  text(w) {
    const card = baseCard(w);
    const big = el("div", "big-text", "—");
    const sub = el("div", "ctx");
    const err = el("div", "w-error");
    card.append(head(w, w.icon || "🕒"), el("div", "w-body"), el("div", "w-src", srcText(w)), err);
    card.querySelector(".w-body").append(big, sub);
    return { card, update: () => updateText(w, { big, sub, err }) };
  },
  code(w) {
    const card = baseCard(w);
    const num = el("div", "code-num", "—");
    const badge = el("div", "code-badge");
    const badgeText = el("span", "", "Menunggu data");
    badge.append(el("span", "dot"), badgeText);
    const age = el("div", "ctx");
    const err = el("div", "w-error");
    const body = el("div", "w-body");
    body.append(num, badge, age);
    card.append(head(w, "🚦"), body, el("div", "w-src", srcText(w)), err);
    return { card, update: () => updateCode(w, { num, badge, badgeText, age, err }) };
  },
  status(w) {
    const card = baseCard(w);
    const big = el("div", "status-big");
    const label = el("span", "", "—");
    big.append(el("span", "dot"), label);
    const sub = el("div", "ctx");
    const err = el("div", "w-error");
    const body = el("div", "w-body");
    body.append(big, sub);
    card.append(head(w, "📡"), body, el("div", "w-src", `${srcText(w)} · online < ${w.onlineS || 30} dtk`), err);
    return { card, update: () => updateStatus(w, { big, label, sub, err }) };
  },
  chart(w) {
    const card = baseCard(w);
    const box = el("div", "chart-box");
    const canvas = el("canvas");
    canvas.setAttribute("aria-label", w.title || "Grafik");
    box.append(canvas);
    const err = el("div", "w-error");
    card.append(head(w, "📈"), box, el("div", "w-src", `${srcText(w)} · ${w.points || 50} titik`), err);
    return { card, mount: () => mountChart(w, canvas), update: () => updateChart(w, err) };
  },
  table(w) {
    const card = baseCard(w);
    const wrap = el("div", "table-wrap");
    const table = el("table", "hist-table");
    table.innerHTML = `<thead><tr><th>Waktu (${w.contextKey || "context"})</th><th class="num">Nilai</th><th>Diterima server (WIB)</th><th class="num">Selisih (dtk)</th></tr></thead><tbody></tbody>`;
    wrap.append(table);
    const err = el("div", "w-error");
    const actions = el("div", "w-actions");
    actions.append(el("span", "w-src", `${srcText(w)} · ${w.rows || 20} data terakhir`), button("⬇ Export CSV", "btn ghost", () => exportCsv(w)));
    card.append(head(w, "📋"), wrap, actions, err);
    return { card, update: () => updateTable(w, table.tBodies[0], err) };
  },
  control(w) {
    const card = baseCard(w);
    const row = el("div", "ctl-row");
    if (w.color) row.style.setProperty("--c", w.color);
    const valueText = el("span", "ctl-value", "");
    const headRow = el("div", "ctl-head");
    headRow.append(el("span", "", w.variable), valueText);
    row.append(headRow);
    const err = el("div", "w-error");
    let sync = () => {};
    if (w.kind === "toggle") {
      const seg = el("div", "segmented");
      const opts = [{ label: w.onLabel, value: Number(w.onValue) }, { label: w.offLabel, value: Number(w.offValue) }];
      const btns = opts.map((o) => {
        const b = button(o.label, "btn", () => {
          if (state.editing) return;
          set(o.value);
          sendControl(w, o.value);
        });
        seg.append(b);
        return b;
      });
      const set = (v) => {
        opts.forEach((o, i) => btns[i].setAttribute("aria-pressed", String(o.value === v)));
        const cur = opts.find((o) => o.value === v);
        valueText.textContent = cur ? cur.label : Number.isFinite(v) ? String(v) : "";
      };
      row.append(seg);
      sync = set;
    } else if (w.kind === "slider") {
      const input = el("input");
      input.type = "range";
      input.min = w.min;
      input.max = w.max;
      input.step = w.step || 1;
      input.value = w.min;
      input.setAttribute("aria-label", w.title || w.variable);
      let dragging = false;
      let synced = false;
      input.addEventListener("pointerdown", () => { dragging = true; });
      for (const ev of ["pointerup", "pointercancel", "change"]) input.addEventListener(ev, () => { dragging = false; });
      input.addEventListener("input", () => {
        valueText.textContent = `${input.value}${w.unit || ""}`;
        if (!state.editing) sendControl(w, Number(input.value));
      });
      row.append(input);
      sync = (v) => {
        if (dragging || synced || !Number.isFinite(v)) return;
        synced = true;
        input.value = v;
        valueText.textContent = `${input.value}${w.unit || ""}`;
      };
    } else {
      const b = button(w.buttonLabel || "Kirim", "btn primary big", () => {
        if (!state.editing) sendControl(w, Number(w.value));
      });
      if (w.color) b.style.cssText = `background:${w.color};border-color:${w.color}`;
      row.append(b);
      sync = (v) => { valueText.textContent = Number.isFinite(v) ? `terakhir: ${v}` : ""; };
    }
    card.append(head(w, "🎛️"), row, el("div", "w-src", srcText(w)), err);
    return {
      card,
      update: () => {
        err.textContent = widgetError(w);
        const dot = latestDot(w);
        const q = state.sendQ[histKey(w.device, w.variable)];
        if (dot && !(q && (q.busy || Date.now() - q.changedAt < 5000))) sync(dot.value);
      },
    };
  },
  link(w) {
    const card = baseCard(w);
    const url = w.linkKind === "camera" ? cameraUrl(w.url) : safeUrl(w.url);
    const info = el("p", "muted", url || "URL belum diisi. Klik Edit untuk mengatur.");
    info.style.margin = "0";
    info.style.overflowWrap = "anywhere";
    const b = button(w.buttonLabel || "Buka ↗", "btn primary big", () => {
      if (state.editing) return;
      if (!url) return toast("URL belum diisi.", true);
      window.open(url, "_blank", "noopener");
    });
    card.append(head(w, w.linkKind === "camera" ? "◉" : "🔗"), info, b);
    return { card, update: () => {} };
  },
  note(w) {
    const card = baseCard(w);
    card.append(head(w, "📝"), el("div", "note-text", w.text || "(kosong)"));
    return { card, update: () => {} };
  },
};

function thresholdLevel(w, v) {
  const hit = (op, limit) => op && limit !== "" && limit !== undefined && limit !== null && Number.isFinite(Number(limit)) && (op === ">" ? v > Number(limit) : v < Number(limit));
  if (hit(w.dangerOp, w.dangerValue)) return { level: "danger", note: w.dangerNote || "Bahaya" };
  if (hit(w.warnOp, w.warnValue)) return { level: "warn", note: w.warnNote || "Waspada" };
  return { level: w.dangerOp || w.warnOp ? "ok" : "", note: "" };
}

function ctxValue(dot, key) {
  if (!dot || !key || !dot.context) return undefined;
  const v = dot.context[key];
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

function seenAt(dot) {
  return dot ? dot.created || dot.ts : 0;
}

function updateNumber(w, ui) {
  const dot = latestDot(w);
  ui.card.classList.remove("ok", "warn", "danger", "stale");
  ui.err.textContent = widgetError(w);
  if (!dot || !Number.isFinite(dot.value)) {
    ui.value.textContent = "—";
    ui.note.textContent = "";
    ui.ctx.textContent = "";
    ui.age.textContent = state.latest[w.device] ? `belum ada data · ${srcText(w)}` : srcText(w);
    return;
  }
  ui.value.textContent = fmtNum(dot.value, Number(w.decimals) || 0);
  const lv = thresholdLevel(w, dot.value);
  if (lv.level) ui.card.classList.add(lv.level);
  ui.note.textContent = lv.note;
  const ctx = ctxValue(dot, w.contextKey);
  ui.ctx.textContent = w.contextKey ? `🕒 ${w.contextKey === "waktu" ? "RTC" : w.contextKey}: ${ctx ?? `${fmtWib(dot.ts)} WIB`}` : "";
  ui.age.textContent = `⏱ ${ago(Date.now() - seenAt(dot))} · ${srcText(w)}`;
}

function updateText(w, ui) {
  const dot = latestDot(w);
  ui.err.textContent = widgetError(w);
  let ctx = ctxValue(dot, w.key);
  if (ctx === undefined && dot && !dot.hasContext) ctx = ctxValue((state.history[histKey(w.device, w.variable)] || [])[0], w.key);
  if (ctx !== undefined) {
    ui.big.textContent = ctx;
    ui.sub.textContent = `context.${w.key}`;
  } else if (dot) {
    ui.big.textContent = `${fmtWib(dot.ts)} WIB`;
    ui.sub.textContent = `context.${w.key} tidak ada — memakai timestamp dot`;
  } else {
    ui.big.textContent = "—";
    ui.sub.textContent = "";
  }
}

function codeRule(w, v) {
  const map = w.map || DEFAULT_CODE_MAP;
  const rule = (map.rules || []).find((r) => Number(r.value) === v);
  return rule || { level: map.other?.level || "danger", text: map.other?.text || "Lainnya" };
}

function updateCode(w, ui) {
  const dot = latestDot(w);
  ui.err.textContent = widgetError(w);
  ui.badge.className = "code-badge";
  ui.num.className = "code-num";
  if (!dot || !Number.isFinite(dot.value)) {
    ui.num.textContent = "—";
    ui.badgeText.textContent = "Menunggu data";
    ui.age.textContent = "";
    return;
  }
  const v = Math.round(dot.value);
  const rule = codeRule(w, v);
  ui.num.textContent = String(v);
  ui.num.classList.add(`lv-${rule.level}`);
  ui.badge.classList.add(`lv-${rule.level}`);
  ui.badgeText.textContent = rule.text;
  ui.age.textContent = `⏱ ${ago(Date.now() - seenAt(dot))}`;
}

function updateStatus(w, ui) {
  const vars = state.latest[w.device];
  ui.err.textContent = widgetError(w);
  ui.big.classList.remove("online", "offline");
  if (!vars) {
    ui.label.textContent = state.deviceErr[w.device] ? "OFFLINE" : "—";
    if (state.deviceErr[w.device]) ui.big.classList.add("offline");
    ui.sub.textContent = "";
    return;
  }
  const dots = w.variable ? [vars[w.variable]].filter(Boolean) : Object.values(vars);
  const last = Math.max(0, ...dots.map(seenAt));
  if (!last) {
    ui.label.textContent = "BELUM ADA DATA";
    ui.big.classList.add("offline");
    ui.sub.textContent = "";
    return;
  }
  const age = Date.now() - last;
  const online = age < (Number(w.onlineS) || 30) * 1000;
  ui.label.textContent = online ? "ONLINE" : "OFFLINE";
  ui.big.classList.add(online ? "online" : "offline");
  ui.sub.textContent = `Data terakhir ${ago(age)} (${fmtWib(last)} WIB)`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function mountChart(w, canvas) {
  if (!window.Chart) {
    canvas.replaceWith(el("p", "muted", "Grafik tidak tersedia (Chart.js gagal dimuat)."));
    return;
  }
  const muted = cssVar("--text-2");
  const grid = cssVar("--border");
  const chart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: (w.series || []).map((s, i) => ({
        label: s.variable,
        data: [],
        borderColor: s.color || SERIES_COLORS[i],
        backgroundColor: s.color || SERIES_COLORS[i],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        tension: 0.25,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { display: (w.series || []).length > 1, labels: { color: muted, usePointStyle: true, pointStyle: "line", boxWidth: 24 } },
        tooltip: { callbacks: { title: (items) => (items[0] ? `${fmtWib(items[0].parsed.x)} WIB` : "") } },
      },
      scales: {
        x: { type: "linear", ticks: { color: muted, maxTicksLimit: 6, maxRotation: 0, callback: (v) => fmtWibTime(v) }, grid: { color: grid } },
        y: { ticks: { color: muted }, grid: { color: grid } },
      },
    },
  });
  state.charts.set(w.id, chart);
}

function updateChart(w, err) {
  const chart = state.charts.get(w.id);
  const errs = [];
  (w.series || []).forEach((s, i) => {
    const k = histKey(w.device, s.variable);
    if (state.historyErr[k]) errs.push(widgetError({ ...w, variable: s.variable }, state.historyErr[k]));
    if (!chart) return;
    const rows = (state.history[k] || []).slice(0, w.points || 50);
    chart.data.datasets[i].data = rows.filter((r) => Number.isFinite(r.value)).map((r) => ({ x: r.ts, y: r.value })).reverse();
  });
  err.textContent = [...new Set(errs)].join(" ");
  if (chart) chart.update("none");
}

function tableRows(w) {
  return (state.history[histKey(w.device, w.variable)] || []).slice(0, w.rows || 20);
}

function delaySec(r) {
  return r.created && r.ts ? ((r.created - r.ts) / 1000).toFixed(1) : "—";
}

function updateTable(w, tbody, err) {
  const k = histKey(w.device, w.variable);
  err.textContent = state.historyErr[k] ? widgetError(w, state.historyErr[k]) : "";
  tbody.innerHTML = "";
  const rows = tableRows(w);
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "muted", state.history[k] ? "Belum ada data" : "Memuat…");
    td.colSpan = 4;
    tr.append(td);
    tbody.append(tr);
    return;
  }
  for (const r of rows) {
    const tr = el("tr");
    tr.append(
      el("td", "", ctxValue(r, w.contextKey) ?? `${fmtWib(r.ts)} WIB`),
      el("td", "num", Number.isFinite(r.value) ? String(Number(r.value.toFixed(3))) : "—"),
      el("td", "", r.created ? fmtWib(r.created) : "—"),
      el("td", "num", delaySec(r)),
    );
    tbody.append(tr);
  }
}

function exportCsv(w) {
  const rows = tableRows(w);
  if (!rows.length) return toast("Belum ada data untuk diekspor.", true);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [["waktu_context", "nilai", "timestamp_wib", "diterima_server_wib", "selisih_detik"].join(",")];
  for (const r of rows) {
    lines.push([esc(ctxValue(r, w.contextKey) ?? ""), r.value, esc(fmtWib(r.ts)), esc(r.created ? fmtWib(r.created) : ""), delaySec(r)].join(","));
  }
  downloadFile(`${w.device}_${w.variable}_${fmtWib(Date.now()).replace(/[: ]/g, "-")}.csv`, `${lines.join("\n")}\n`, "text/csv");
}

function updateAll() {
  for (const ui of state.ui.values()) ui.update();
}

function renderWidgets() {
  for (const chart of state.charts.values()) chart.destroy();
  state.charts.clear();
  state.ui.clear();
  const grid = $("#widget-grid");
  grid.innerHTML = "";
  const widgets = widgetsOf();
  if (!widgets.length && !state.editing) {
    const empty = el("div", "card empty-state w-L");
    empty.append(el("strong", "", "Dashboard masih kosong"), el("span", "", "Klik ✎ Edit lalu + Widget untuk menambah komponen."));
    grid.append(empty);
  }
  for (const w of widgets) {
    const build = builders[w.type];
    if (!build) continue;
    const ui = build(w);
    if (state.editing) addEditOverlay(ui.card, w);
    grid.append(ui.card);
    if (ui.mount) ui.mount();
    state.ui.set(w.id, ui);
  }
  if (state.editing) grid.append(button("+ Tambah widget", "add-tile w-S", () => openEditor(null)));
  updateAll();
}

/* ---------- Kirim kontrol ---------- */

function sendControl(w, value) {
  if (!w.device || !w.variable) return toast("Device/variabel kontrol belum diisi.", true);
  const k = histKey(w.device, w.variable);
  const q = state.sendQ[k] || (state.sendQ[k] = { busy: false, has: false, value: null, changedAt: 0 });
  q.value = value;
  q.has = true;
  q.changedAt = Date.now();
  if (!q.busy) flushControl(w.device, w.variable, q);
}

async function flushControl(device, variable, q) {
  q.busy = true;
  let tries = 0;
  while (q.has) {
    let sent = null;
    try {
      await limiter.run(() => {
        sent = q.value;
        q.has = false;
        return api("POST", `/v1.6/devices/${encodeURIComponent(device)}/`, { [variable]: sent });
      }, PRIORITY.control);
      tries = 0;
      toast(`${variable} = ${sent} terkirim`);
    } catch (e) {
      if (["ratelimit", "timeout", "network", "server"].includes(e.kind) && ++tries < 4) {
        if (!q.has) {
          q.value = sent;
          q.has = true;
        }
        if (e.kind === "ratelimit") setBanner(errorText(e), "ratelimit");
        continue;
      }
      tries = 0;
      toast(`Gagal kirim ${variable}=${sent}. ${errorText(e)}`, true);
    }
  }
  q.busy = false;
}

/* ---------- Mode edit ---------- */

function addEditOverlay(card, w) {
  const overlay = el("div", "edit-overlay");
  overlay.title = "Klik untuk mengubah";
  overlay.addEventListener("click", () => openEditor(w));
  const tools = el("div", "edit-tools");
  const handle = button("⠿", "drag-handle", (e) => e.stopPropagation());
  handle.title = "Seret untuk mengurutkan";
  handle.setAttribute("aria-label", "Seret untuk mengurutkan");
  const del = button("✕", "del", (e) => {
    e.stopPropagation();
    if (!confirm(`Hapus widget "${w.title || WIDGET_TYPES[w.type].label}"?`)) return;
    state.cfg.widgets = widgetsOf().filter((x) => x.id !== w.id);
    markChanged();
  });
  del.title = "Hapus";
  del.setAttribute("aria-label", "Hapus widget");
  tools.append(handle, del);
  overlay.append(tools);
  card.append(overlay);
}

function makeSortable(container, itemSelector, onDrop) {
  container.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle) return;
    const item = handle.closest(itemSelector);
    if (!item || item.parentElement !== container) return;
    e.preventDefault();
    item.classList.add("dragging");
    document.body.classList.add("drag-active");
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      if (ev.clientY < 100) window.scrollBy(0, -14);
      else if (ev.clientY > window.innerHeight - 120) window.scrollBy(0, 14);
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = hit && hit.closest(itemSelector);
      if (!target || target === item || target.parentElement !== container) return;
      const items = [...container.children];
      const from = items.indexOf(item);
      const to = items.indexOf(target);
      if (from < to) items.slice(from + 1, to + 1).forEach((n) => item.before(n));
      else items.slice(to, from).reverse().forEach((n) => item.after(n));
    };
    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      item.classList.remove("dragging");
      document.body.classList.remove("drag-active");
      onDrop([...container.children].filter((n) => n.matches(itemSelector)).map((n) => n.dataset.id));
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
}

function reorderWidgets(ids) {
  const byId = new Map(widgetsOf().map((w) => [w.id, w]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.map((w) => w.id).join() === widgetsOf().map((w) => w.id).join()) return;
  state.cfg.widgets = next;
  markChanged();
}

function markChanged() {
  state.changed = true;
  saveDashboard(state.cfg, false);
  renderWidgets();
  refreshSoon();
}

function setEditing(on) {
  if (!on && state.changed) {
    state.changed = false;
    saveDashboard(state.cfg, true);
  }
  state.editing = on;
  document.body.classList.toggle("editing", on);
  $("#editbar").hidden = !on;
  $("#edit-toggle").setAttribute("aria-pressed", String(on));
  $("#reset-preset").hidden = !(state.cfg.builtin && state.cfg.id === "logger");
  renderWidgets();
}

/* ---------- Editor widget ---------- */

let editorApply = null;

function input(name, value, type = "text", attrs = {}) {
  const i = el("input");
  i.name = name;
  i.type = type;
  if (value !== undefined && value !== null) i.value = value;
  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  return i;
}

function select(name, options, value) {
  const s = el("select");
  s.name = name;
  for (const [v, label] of options) {
    const o = el("option", "", label);
    o.value = v;
    s.append(o);
  }
  s.value = value ?? options[0][0];
  return s;
}

function field(label, control, full = false, hint = "") {
  const wrap = el("label", `field${full ? " full" : ""}`);
  wrap.append(el("span", "", label), control);
  if (hint) wrap.append(el("small", "muted", hint));
  return wrap;
}

function deviceInput(value) {
  return input("device", value, "text", { list: "device-list", spellcheck: "false", autocapitalize: "off", placeholder: "mis. logger" });
}

function variableInput(name, value, placeholder = "mis. suhu_ambient") {
  return input(name, value, "text", { spellcheck: "false", autocapitalize: "off", placeholder });
}

function seriesRow(s, i) {
  const row = el("div", "series-row");
  row.append(
    variableInput("s-var", s.variable),
    input("s-color", s.color || SERIES_COLORS[i] || SERIES_COLORS[0], "color", { "aria-label": "Warna garis" }),
    button("✕", "btn ghost icon-btn", () => row.remove()),
  );
  return row;
}

function ruleRow(r) {
  const row = el("div", "rule-row");
  const text = input("r-text", r.text, "text", { placeholder: "Teks", "aria-label": "Teks" });
  text.classList.add("rule-text");
  row.append(
    input("r-value", r.value, "number", { step: "any", placeholder: "Nilai", "aria-label": "Nilai kode" }),
    select("r-level", LEVEL_OPTIONS, r.level),
    text,
    button("✕", "btn ghost icon-btn", () => row.remove()),
  );
  return row;
}

function typeFields(w, root) {
  root.innerHTML = "";
  const grid = el("div", "form-grid");
  const needsVar = !["chart", "link", "note"].includes(w.type);
  if (!["link", "note"].includes(w.type)) {
    grid.append(field("Device label", deviceInput(w.device || state.cfg.device || "")));
    if (needsVar) grid.append(field(w.type === "status" ? "Variabel (opsional)" : "Variabel", variableInput("variable", w.variable)));
  }
  switch (w.type) {
    case "number":
      grid.append(
        field("Satuan", input("unit", w.unit, "text", { placeholder: "°C, V, %" })),
        field("Desimal", input("decimals", w.decimals ?? 1, "number", { min: 0, max: 4, step: 1 })),
        field("Ikon (emoji)", input("icon", w.icon, "text", { maxlength: 4 })),
        field("Warna", input("color", w.color || "#3987e5", "color")),
        field("Tampilkan context (kunci)", input("contextKey", w.contextKey || "", "text", { placeholder: "mis. waktu" }), true, "Kosongkan bila tidak perlu."),
        field("Waspada jika", select("warnOp", OP_OPTIONS, w.warnOp || "")),
        field("Nilai waspada", input("warnValue", w.warnValue ?? "", "number", { step: "any" })),
        field("Catatan waspada", input("warnNote", w.warnNote || "", "text", { placeholder: "Waspada" }), true),
        field("Bahaya jika", select("dangerOp", OP_OPTIONS, w.dangerOp || "")),
        field("Nilai bahaya", input("dangerValue", w.dangerValue ?? "", "number", { step: "any" })),
        field("Catatan bahaya", input("dangerNote", w.dangerNote || "", "text", { placeholder: "Bahaya" }), true),
      );
      break;
    case "text":
      grid.append(
        field("Kunci context", input("key", w.key || "waktu", "text", { placeholder: "waktu" }), false, "Fallback: timestamp dot (WIB)."),
        field("Ikon (emoji)", input("icon", w.icon, "text", { maxlength: 4 })),
      );
      break;
    case "status":
      grid.append(field("Online jika data < … detik", input("onlineS", w.onlineS ?? 30, "number", { min: 1, step: 1 })));
      break;
    case "chart":
      grid.append(field("Jumlah titik", input("points", w.points ?? 50, "number", { min: 2, max: 500, step: 1 })));
      break;
    case "table":
      grid.append(
        field("Jumlah baris", input("rows", w.rows ?? 20, "number", { min: 1, max: 500, step: 1 })),
        field("Kolom waktu dari context", input("contextKey", w.contextKey || "waktu", "text")),
      );
      break;
    case "control": {
      const kind = select("kind", [["button", "Tombol"], ["toggle", "Toggle"], ["slider", "Slider"]], w.kind || "button");
      kind.addEventListener("change", () => typeFields({ ...w, ...readLoose(root.closest("form")), kind: kind.value }, root));
      grid.append(field("Jenis kontrol", kind), field("Warna (opsional)", colorOptional(w.color)));
      if ((w.kind || "button") === "button") {
        grid.append(field("Nilai dikirim", input("value", w.value ?? 1, "number", { step: "any" })), field("Teks tombol", input("buttonLabel", w.buttonLabel || "Kirim")));
      } else if (w.kind === "toggle") {
        grid.append(
          field("Label pilihan 1", input("onLabel", w.onLabel || "ON")),
          field("Nilai pilihan 1", input("onValue", w.onValue ?? 1, "number", { step: "any" })),
          field("Label pilihan 2", input("offLabel", w.offLabel || "OFF")),
          field("Nilai pilihan 2", input("offValue", w.offValue ?? 0, "number", { step: "any" })),
        );
      } else {
        grid.append(
          field("Minimum", input("min", w.min ?? 0, "number", { step: "any" })),
          field("Maksimum", input("max", w.max ?? 100, "number", { step: "any" })),
          field("Step", input("step", w.step ?? 1, "number", { step: "any", min: 0 })),
          field("Satuan", input("unit", w.unit || "")),
        );
      }
      break;
    }
    case "link":
      grid.append(
        field("Jenis", select("linkKind", [["camera", "Kamera ESP32-CAM (IP → :81/stream)"], ["url", "URL biasa"]], w.linkKind || "camera"), true),
        field("IP / URL", input("url", w.url || "", "text", { placeholder: "192.168.1.50 atau https://…", spellcheck: "false", autocapitalize: "off" }), true),
        field("Teks tombol", input("buttonLabel", w.buttonLabel || "Buka ↗")),
      );
      break;
    case "note": {
      const ta = el("textarea");
      ta.name = "text";
      ta.value = w.text || "";
      ta.maxLength = 2000;
      grid.append(field("Isi catatan", ta, true));
      break;
    }
  }
  root.append(grid);

  if (w.type === "chart") {
    root.append(el("div", "section-label", "Variabel (1–3)"));
    const list = el("div", "series-list");
    (w.series && w.series.length ? w.series : [{ variable: "", color: SERIES_COLORS[0] }]).forEach((s, i) => list.append(seriesRow(s, i)));
    root.append(list, button("+ Tambah variabel", "btn ghost wide", () => {
      if (list.children.length >= 3) return toast("Maksimal 3 variabel per grafik.", true);
      list.append(seriesRow({ variable: "", color: SERIES_COLORS[list.children.length] }, list.children.length));
    }));
  }
  if (w.type === "code") {
    const map = w.map || DEFAULT_CODE_MAP;
    root.append(el("div", "section-label", "Peta nilai → warna & teks"));
    const list = el("div", "rule-list");
    (map.rules || []).forEach((r) => list.append(ruleRow(r)));
    root.append(list, button("+ Tambah aturan", "btn ghost wide", () => list.append(ruleRow({ value: "", level: "ok", text: "" }))));
    const other = el("div", "form-grid");
    other.style.marginTop = "12px";
    other.append(
      field("Nilai lainnya: warna", select("otherLevel", LEVEL_OPTIONS, map.other?.level || "danger")),
      field("Nilai lainnya: teks", input("otherText", map.other?.text || "Error")),
    );
    root.append(other);
  }
}

function colorOptional(color) {
  const wrap = el("div", "inline");
  const use = input("useColor", undefined, "checkbox", { "aria-label": "Pakai warna khusus" });
  use.checked = Boolean(color);
  wrap.append(use, input("color", color || "#3b8eea", "color"), el("span", "muted", "warna khusus"));
  return wrap;
}

function readLoose(form) {
  const out = {};
  for (const elx of form.elements) {
    if (!elx.name || elx.type === "submit" || elx.type === "button") continue;
    out[elx.name] = elx.type === "checkbox" ? elx.checked : elx.value;
  }
  return out;
}

function readLabel(form, name, label, optional = false) {
  const raw = (form.elements[name]?.value || "").trim().toLowerCase();
  if (!raw && optional) return "";
  if (!LABEL_RE.test(raw)) throw new Error(`${label} wajib diisi (huruf kecil, angka, _ atau -).`);
  return raw;
}

function readNum(form, name, label, { optional = false, min, max } = {}) {
  const raw = (form.elements[name]?.value ?? "").trim();
  if (raw === "" && optional) return "";
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) throw new Error(`${label} harus berupa angka.`);
  if (min !== undefined && n < min) throw new Error(`${label} minimal ${min}.`);
  if (max !== undefined && n > max) throw new Error(`${label} maksimal ${max}.`);
  return n;
}

function readWidget(form, base) {
  const type = form.elements.type.value;
  const v = (name) => (form.elements[name]?.value ?? "").trim();
  const w = { id: base.id || `w-${uid()}`, type, title: v("title") || WIDGET_TYPES[type].label, size: v("size") || "S" };
  if (!["link", "note"].includes(type)) w.device = readLabel(form, "device", "Device label");
  if (!["chart", "link", "note"].includes(type)) w.variable = readLabel(form, "variable", "Variabel", type === "status");
  switch (type) {
    case "number":
      Object.assign(w, {
        unit: v("unit"),
        decimals: readNum(form, "decimals", "Desimal", { min: 0, max: 4 }),
        icon: v("icon"),
        color: v("color"),
        contextKey: v("contextKey"),
        warnOp: v("warnOp"),
        warnValue: readNum(form, "warnValue", "Nilai waspada", { optional: true }),
        warnNote: v("warnNote"),
        dangerOp: v("dangerOp"),
        dangerValue: readNum(form, "dangerValue", "Nilai bahaya", { optional: true }),
        dangerNote: v("dangerNote"),
      });
      if ((w.warnOp && w.warnValue === "") || (w.dangerOp && w.dangerValue === "")) throw new Error("Isi nilai ambang yang dipakai.");
      break;
    case "text":
      Object.assign(w, { key: v("key") || "waktu", icon: v("icon") });
      break;
    case "status":
      w.onlineS = readNum(form, "onlineS", "Batas online", { min: 1 });
      break;
    case "chart": {
      w.points = readNum(form, "points", "Jumlah titik", { min: 2, max: 500 });
      w.series = [...form.querySelectorAll(".series-row")].map((row) => {
        const variable = row.querySelector('[name="s-var"]').value.trim().toLowerCase();
        if (!LABEL_RE.test(variable)) throw new Error("Variabel grafik wajib diisi (huruf kecil, angka, _ atau -).");
        return { variable, color: row.querySelector('[name="s-color"]').value };
      });
      if (!w.series.length || w.series.length > 3) throw new Error("Grafik butuh 1–3 variabel.");
      break;
    }
    case "table":
      Object.assign(w, { rows: readNum(form, "rows", "Jumlah baris", { min: 1, max: 500 }), contextKey: v("contextKey") });
      break;
    case "code": {
      const rules = [...form.querySelectorAll(".rule-row")].map((row) => {
        const raw = row.querySelector('[name="r-value"]').value.trim();
        if (raw === "" || !Number.isFinite(Number(raw))) throw new Error("Nilai pada peta kode harus angka.");
        return { value: Number(raw), level: row.querySelector('[name="r-level"]').value, text: row.querySelector('[name="r-text"]').value.trim() || raw };
      });
      w.map = { rules, other: { level: v("otherLevel") || "danger", text: v("otherText") || "Lainnya" } };
      break;
    }
    case "control":
      w.kind = v("kind") || "button";
      w.color = form.elements.useColor?.checked ? v("color") : "";
      if (w.kind === "button") Object.assign(w, { value: readNum(form, "value", "Nilai"), buttonLabel: v("buttonLabel") || "Kirim" });
      if (w.kind === "toggle") {
        Object.assign(w, {
          onLabel: v("onLabel") || "ON", onValue: readNum(form, "onValue", "Nilai pilihan 1"),
          offLabel: v("offLabel") || "OFF", offValue: readNum(form, "offValue", "Nilai pilihan 2"),
        });
      }
      if (w.kind === "slider") {
        Object.assign(w, { min: readNum(form, "min", "Minimum"), max: readNum(form, "max", "Maksimum"), step: readNum(form, "step", "Step"), unit: v("unit") });
        if (w.min >= w.max) throw new Error("Minimum harus lebih kecil dari maksimum.");
        if (w.step <= 0) throw new Error("Step harus lebih dari 0.");
      }
      break;
    case "link":
      Object.assign(w, { linkKind: v("linkKind"), url: v("url"), buttonLabel: v("buttonLabel") || "Buka ↗" });
      break;
    case "note":
      w.text = form.elements.text.value;
      break;
  }
  return w;
}

function openEditor(widget) {
  const w = widget ? clone(widget) : { ...clone(WIDGET_TYPES.number.defaults), type: "number", device: state.cfg.device || "" };
  $("#editor-title").textContent = widget ? `Ubah widget: ${w.title}` : "Tambah widget";
  const root = $("#editor-fields");
  root.innerHTML = "";
  const top = el("div", "form-grid");
  const typeSel = select("type", Object.entries(WIDGET_TYPES).map(([k, t]) => [k, `${t.icon} ${t.label}`]), w.type);
  top.append(
    field("Jenis widget", typeSel, true),
    field("Judul", input("title", w.title, "text", { maxlength: 40 })),
    field("Ukuran", select("size", SIZE_OPTIONS, w.size || "S")),
  );
  const specific = el("div");
  root.append(top, specific);
  typeFields(w, specific);
  typeSel.addEventListener("change", () => {
    const loose = readLoose($("#editor-form"));
    const next = { ...clone(WIDGET_TYPES[typeSel.value].defaults), type: typeSel.value, device: loose.device || w.device, variable: loose.variable || w.variable };
    root.querySelector('[name="title"]').value = next.title;
    root.querySelector('[name="size"]').value = next.size;
    if (next.type === "chart" && next.variable) next.series = [{ variable: next.variable, color: SERIES_COLORS[0] }];
    typeFields(next, specific);
  });
  editorApply = (form) => {
    const next = readWidget(form, w);
    const list = widgetsOf();
    const i = list.findIndex((x) => x.id === next.id);
    if (i >= 0) list[i] = next;
    else list.push(next);
    state.cfg.widgets = list;
    markChanged();
  };
  $("#editor-error").hidden = true;
  $("#editor").returnValue = "";
  $("#editor").showModal();
}

/* ---------- Export / import / reset ---------- */

function exportDashboard() {
  const data = { app: "phantom-hub-dashboard", version: 1, exportedAt: new Date().toISOString(), dashboard: state.cfg };
  downloadFile(`dashboard-${state.cfg.id}.json`, JSON.stringify(data, null, 2), "application/json");
}

async function importDashboard(file) {
  try {
    const data = JSON.parse(await file.text());
    const cfg = data.app === "phantom-hub" ? (data.dashboards || []).find((d) => d.kind === "builder") : data.dashboard || data;
    if (!cfg || !Array.isArray(cfg.widgets)) throw new Error("butuh objek dashboard dengan array widgets");
    if (!confirm(`Ganti isi dashboard ini dengan "${cfg.name || "impor"}" (${cfg.widgets.length} widget)?`)) return;
    const unknown = cfg.widgets.find((w) => !WIDGET_TYPES[w.type]);
    if (unknown) throw new Error(`jenis widget "${unknown.type}" tidak dikenal`);
    state.cfg = { ...state.cfg, ...cfg, id: state.cfg.id, builtin: state.cfg.builtin, kind: "builder" };
    state.cfg.widgets = cfg.widgets.map((w) => ({ ...w, id: w.id || `w-${uid()}` }));
    markChanged();
    applyHeader();
    toast("Dashboard diimpor");
  } catch (e) {
    toast(`Gagal import JSON: ${e.message}`, true);
  }
}

function resetPreset() {
  const preset = BUILTIN_DASHBOARDS.find((b) => b.id === state.cfg.id);
  if (!preset || !confirm("Kembalikan widget dashboard ini ke preset bawaan?")) return;
  state.cfg.widgets = clone(preset.widgets);
  markChanged();
}

/* ---------- Pengaturan dashboard ---------- */

function openSettings() {
  const form = $("#settings-form");
  const c = state.cfg;
  form.elements.name.value = c.name || "";
  form.elements.icon.value = c.icon || "";
  form.elements.device.value = c.device || "";
  form.elements.refreshS.value = c.refreshS || 5;
  form.elements.historyS.value = c.historyS || 30;
  form.elements.onlineS.value = c.onlineS || 60;
  const look = loadLook();
  form.elements.theme.value = look.theme;
  form.elements.mode.value = look.mode;
  $("#settings-error").hidden = true;
  $("#settings").returnValue = "";
  $("#settings").showModal();
}

function applySettings(form) {
  const name = form.elements.name.value.trim();
  if (!name) throw new Error("Nama wajib diisi.");
  const device = readLabel(form, "device", "Device label utama", true);
  const next = {
    ...state.cfg,
    name,
    icon: form.elements.icon.value.trim() || "📊",
    device,
    refreshS: readNum(form, "refreshS", "Refresh nilai", { min: 1, max: 600 }),
    historyS: readNum(form, "historyS", "Refresh grafik/tabel", { min: 5, max: 3600 }),
    onlineS: readNum(form, "onlineS", "Batas online", { min: 5 }),
  };
  saveLook(form.elements.theme.value, form.elements.mode.value);
  state.cfg = next;
  saveDashboard(state.cfg, true);
  applyHeader();
  renderWidgets();
  refreshSoon();
}

function applyHeader() {
  $("#dash-name").textContent = state.cfg.name;
  $("#dash-icon").textContent = state.cfg.icon || "📊";
  document.title = `${state.cfg.name} · Phantom Hub`;
  const devices = new Set([state.cfg.device, ...widgetsOf().map((w) => w.device)].filter(Boolean));
  const list = $("#device-list");
  list.innerHTML = "";
  devices.forEach((d) => { const o = el("option"); o.value = d; list.append(o); });
}

/* ---------- Awal ---------- */

function showNotFound(text) {
  $("#app").hidden = true;
  $("#login").hidden = true;
  $("#not-found").hidden = false;
  if (text) $("#not-found-text").textContent = text;
}

function loadCfg() {
  const cfg = getDashboard(state.id);
  if (!cfg) return false;
  if (cfg.kind === "link") {
    location.replace(`../${cfg.url}`);
    return false;
  }
  state.cfg = clone(cfg);
  state.cfg.widgets = state.cfg.widgets || [];
  return true;
}

async function start() {
  $("#login").hidden = true;
  if (state.id === "robot") return location.replace("../robot/");
  const known = loadCfg();
  if (known) {
    $("#app").hidden = false;
    applyHeader();
    renderWidgets();
  }
  const { changed } = await syncCloud(state.id);
  if (changed || !known) {
    if (!loadCfg()) return showNotFound(state.id ? `Dashboard "${state.id}" tidak ditemukan atau sudah dihapus.` : "ID dashboard tidak ada di alamat.");
    $("#app").hidden = false;
    applyHeader();
    renderWidgets();
  }
  if (new URLSearchParams(location.search).get("edit") === "1") setEditing(true);
  refreshValues();
  refreshHistory();
}

function bindEvents() {
  bindLogin(start);
  $("#edit-toggle").addEventListener("click", () => setEditing(!state.editing));
  $("#edit-done").addEventListener("click", () => setEditing(false));
  $("#add-widget").addEventListener("click", () => openEditor(null));
  $("#export-dash").addEventListener("click", exportDashboard);
  $("#import-dash").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importDashboard(file);
    e.target.value = "";
  });
  $("#reset-preset").addEventListener("click", resetPreset);
  $("#open-settings").addEventListener("click", openSettings);
  makeSortable($("#widget-grid"), ".widget[data-id]", reorderWidgets);

  $("#editor-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "save" || !editorApply) return;
    try {
      editorApply(e.target);
    } catch (err) {
      e.preventDefault();
      $("#editor-error").textContent = err.message;
      $("#editor-error").hidden = false;
    }
  });
  $("#settings-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "save") return;
    try {
      applySettings(e.target);
    } catch (err) {
      e.preventDefault();
      $("#settings-error").textContent = err.message;
      $("#settings-error").hidden = false;
    }
  });
  $("#settings").addEventListener("close", () => {
    const look = loadLook();
    applyLook(look.theme, look.mode);
    if (state.cfg) renderWidgets();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.cfg && getToken()) {
      refreshValues();
      refreshHistory();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.editing && state.changed) {
      saveDashboard(state.cfg, true);
      e.preventDefault();
    }
  });
}

function init() {
  const look = loadLook();
  applyLook(look.theme, look.mode);
  renderLookControls($("#theme-swatches"), $("#settings-form"));
  ensureBuiltins();
  bindCloudPill($("#cloud-pill"));
  bindEvents();
  startClock();
  if (getToken()) start();
  else {
    $("#login").hidden = false;
  }
}

init();
