/*
 * KONFIGURASI DASHBOARD — tambah/ubah komponen cukup di array di bawah ini.
 *
 * SENSORS: { label, variable, unit, decimals, chart, color, thresholds: [{ above | below, level: "warn"|"danger", note }] }
 * CONTROLS: { type: "button"|"hold"|"toggle"|"slider", group, label, variable, ... }
 *   button : value                         -> kirim value saat diklik
 *   hold   : value, release, key           -> kirim value selama ditahan, release saat dilepas
 *   toggle : on:{label,value}, off:{label,value}, value (awal)
 *   slider : min, max, step, value (awal), unit
 *   pad    : "up"|"down"|"left"|"right"|"center"|"upleft"|... -> ditaruh di D-pad grup
 */
const SENSORS = [
  {
    label: "Suhu Objek", variable: "suhu_objek", unit: "°C", decimals: 1, chart: true, color: "#d95926",
    thresholds: [{ above: 35, level: "danger", note: "Kemungkinan korban terdeteksi" }],
  },
  { label: "Suhu Ambient", variable: "suhu_ambient", unit: "°C", decimals: 1, chart: true, color: "#3987e5" },
  {
    label: "Baterai Motor", variable: "batt_motor", unit: "V", decimals: 2, chart: false,
    thresholds: [
      { below: 6.6, level: "danger", note: "Baterai kritis" },
      { below: 7.0, level: "warn", note: "Baterai lemah" },
    ],
  },
  {
    label: "Baterai Servo", variable: "batt_servo", unit: "V", decimals: 2, chart: false,
    thresholds: [
      { below: 4.6, level: "danger", note: "Baterai kritis" },
      { below: 5.0, level: "warn", note: "Baterai lemah" },
    ],
  },
];

const CONTROLS = [
  { type: "hold", group: "Gerak", pad: "up", label: "▲", title: "Maju", variable: "gerak", value: 1, release: 0, key: ["ArrowUp", "w"] },
  { type: "hold", group: "Gerak", pad: "left", label: "◀", title: "Kiri", variable: "gerak", value: 3, release: 0, key: ["ArrowLeft", "a"] },
  { type: "button", group: "Gerak", pad: "center", label: "■", title: "Stop", variable: "gerak", value: 0, style: "stop" },
  { type: "hold", group: "Gerak", pad: "right", label: "▶", title: "Kanan", variable: "gerak", value: 4, release: 0, key: ["ArrowRight", "d"] },
  { type: "hold", group: "Gerak", pad: "down", label: "▼", title: "Mundur", variable: "gerak", value: 2, release: 0, key: ["ArrowDown", "s"] },
  { type: "slider", group: "Gerak", label: "Kecepatan (PWM)", variable: "speed", min: 0, max: 255, step: 1, value: 180 },
  { type: "slider", group: "Gripper", label: "Lengan (naik/turun)", variable: "lengan", min: 0, max: 180, step: 1, value: 90, unit: "°" },
  { type: "toggle", group: "Gripper", label: "Capit", variable: "capit", on: { label: "Buka", value: 1 }, off: { label: "Tutup", value: 0 }, value: 0 },
];

const EMERGENCY = { variable: "gerak", value: 0 };
const DEFAULTS = { device: "phantom", camera: "", pollInterval: 1 };
const API_BASE = "https://industrial.api.ubidots.com/api";
const CAMERA_DEFAULT_PATH = ":81/stream";
const HOLD_REPEAT_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;
const ERROR_RETRY_MS = 3000;
const ROBOT_ONLINE_MS = 5000;
const ROBOT_LATE_MS = 30000;
const STALE_MS = 10000;
const CHART_POINTS = 60;

const KEY_TOKEN = "phantom.token";
const KEY_SETTINGS = "phantom.settings";

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};

const state = {
  token: store.get(KEY_TOKEN, ""),
  settings: { ...DEFAULTS, ...store.get(KEY_SETTINGS, {}) },
  pollTimer: null,
  polling: false,
  readMode: "v2",
  firstSync: true,
  lastSeen: 0,
  lastPoll: 0,
  chart: null,
  chartSeries: [],
  lastChartTs: 0,
  holds: new Map(),
  sendQ: {},
  ui: {},
  levels: {},
};

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ApiError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

function kindFromStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notfound";
  if (status === 429) return "ratelimit";
  if (status >= 500) return "server";
  return "bad";
}

function errorText(e) {
  switch (e && e.kind) {
    case "auth": return "Token Ubidots ditolak. Periksa token di Pengaturan.";
    case "notfound": return `Device "${state.settings.device}" belum ada di Ubidots. Periksa device label atau nyalakan robot.`;
    case "ratelimit": return "Terlalu banyak permintaan (rate limit Ubidots). Perbesar interval polling di Pengaturan.";
    case "offline": return "HP/laptop ini sedang offline. Periksa koneksi internet.";
    case "timeout": return "Ubidots tidak merespons (timeout). Koneksi lambat?";
    case "network": return "Tidak dapat menghubungi Ubidots. Periksa koneksi internet.";
    case "server": return `Server Ubidots bermasalah (HTTP ${e.status}). Coba lagi sebentar.`;
    case "bad": return `Permintaan ditolak Ubidots (HTTP ${e.status}).`;
    default: return "Terjadi kesalahan tak terduga.";
  }
}

async function api(method, path, body, token = state.token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const headers = { "X-Auth-Token": token };
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new ApiError("timeout");
    throw new ApiError(navigator.onLine === false ? "offline" : "network");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(kindFromStatus(res.status), res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const deviceLabel = () => encodeURIComponent(state.settings.device);

function postValues(values) {
  return api("POST", `/v1.6/devices/${deviceLabel()}/`, values);
}

async function readValues(token) {
  if (state.readMode === "v2") {
    try {
      const data = await api("GET", `/v2.0/devices/~${deviceLabel()}/variables/?page_size=200`, null, token);
      if (data && Array.isArray(data.results)) {
        const out = {};
        for (const v of data.results) {
          const lv = v.lastValue;
          if (lv && lv.value !== undefined && lv.value !== null) {
            out[v.label] = { value: Number(lv.value), ts: Number(lv.timestamp) || 0 };
          }
        }
        return out;
      }
    } catch (e) {
      if (e.kind !== "bad") throw e;
    }
    state.readMode = "v1.6";
  }

  const labels = SENSORS.map((s) => s.variable);
  const results = await Promise.all(labels.map((label) =>
    api("GET", `/v1.6/devices/${deviceLabel()}/${encodeURIComponent(label)}/values/?page_size=1`, null, token)
      .catch((e) => (e.kind === "notfound" ? null : Promise.reject(e)))
  ));
  if (results.every((r) => r === null)) throw new ApiError("notfound", 404);
  const out = {};
  results.forEach((r, i) => {
    const dot = r && r.results && r.results[0];
    if (dot) out[labels[i]] = { value: Number(dot.value), ts: Number(dot.timestamp) || 0 };
  });
  return out;
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false });

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
}

function setBanner(message, warn = false) {
  const b = $("#banner");
  b.hidden = !message;
  b.textContent = message || "";
  b.classList.toggle("warn", warn);
}

/* ---------- Monitoring ---------- */

function renderSensors() {
  const grid = $("#sensor-grid");
  grid.innerHTML = "";
  for (const s of SENSORS) {
    const card = el("div", "card sensor");
    const value = el("span", "value", "—");
    const valueRow = el("div");
    valueRow.append(value, el("span", "unit", s.unit || ""));
    const note = el("div", "note");
    const age = el("div", "age", "belum ada data");
    card.append(el("div", "label", s.label), valueRow, note, age);
    grid.append(card);
    state.ui[`sensor:${s.variable}`] = { card, value, note, age };
  }
}

function levelOf(s, v) {
  const hit = (s.thresholds || []).find((t) =>
    (t.above !== undefined && v > t.above) || (t.below !== undefined && v < t.below));
  if (hit) return hit;
  return s.thresholds && s.thresholds.length ? { level: "ok", note: "" } : { level: "", note: "" };
}

function updateSensors(values) {
  const now = Date.now();
  for (const s of SENSORS) {
    const ui = state.ui[`sensor:${s.variable}`];
    const dot = values[s.variable];
    ui.card.classList.remove("ok", "warn", "danger", "stale");
    if (!dot || Number.isNaN(dot.value)) {
      ui.value.textContent = "—";
      ui.note.textContent = "";
      ui.age.textContent = "belum ada data";
      continue;
    }
    ui.value.textContent = dot.value.toFixed(s.decimals ?? 1);
    const lv = levelOf(s, dot.value);
    if (lv.level) ui.card.classList.add(lv.level);
    ui.note.textContent = lv.note || "";
    ui.age.textContent = dot.ts ? ago(now - dot.ts) : "";
    if (dot.ts && now - dot.ts > STALE_MS) ui.card.classList.add("stale");

    const prev = state.levels[s.variable];
    if (lv.level === "danger" && prev !== "danger") {
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      toast(`${s.label}: ${lv.note || "di luar ambang"}`, true);
    }
    state.levels[s.variable] = lv.level;
  }
}

function updateRobotStatus(values) {
  if (values) {
    for (const s of SENSORS) {
      const dot = values[s.variable];
      if (dot && dot.ts > state.lastSeen) state.lastSeen = dot.ts;
    }
  }
  const pill = $("#robot-status");
  pill.classList.remove("online", "late", "offline");
  if (!state.lastSeen) {
    pill.textContent = "Robot: belum ada data";
    pill.classList.add("offline");
    return;
  }
  const age = Date.now() - state.lastSeen;
  if (age < ROBOT_ONLINE_MS) {
    pill.textContent = "Robot online";
    pill.classList.add("online");
  } else if (age < ROBOT_LATE_MS) {
    pill.textContent = `Tertunda · ${ago(age)}`;
    pill.classList.add("late");
  } else {
    pill.textContent = `Offline · ${ago(age)}`;
    pill.classList.add("offline");
  }
}

/* ---------- Grafik ---------- */

function initChart() {
  const charted = SENSORS.filter((s) => s.chart);
  if (!window.Chart || !charted.length) {
    $("#chart").hidden = true;
    $("#chart-fallback").hidden = false;
    return;
  }
  const muted = "#9aa7b4";
  const grid = "rgba(154, 167, 180, 0.12)";
  const series = [];
  const limits = [];
  for (const s of charted) {
    series.push({
      get: (values) => (values[s.variable] ? values[s.variable].value : null),
      ds: { label: s.label, data: [], borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.3, spanGaps: true },
    });
    for (const t of s.thresholds || []) {
      if (t.level !== "danger" || t.above === undefined) continue;
      limits.push({
        get: () => t.above,
        ds: { label: `Ambang ${t.above}${s.unit || ""}`, data: [], borderColor: "#d03b3b", backgroundColor: "#d03b3b", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0 },
      });
    }
  }
  series.push(...limits);
  state.chartSeries = series;
  state.chart = new Chart($("#chart"), {
    type: "line",
    data: { labels: [], datasets: series.map((x) => x.ds) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: muted, usePointStyle: true, pointStyle: "line", boxWidth: 24 } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y === null ? "—" : ctx.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: grid } },
        y: { title: { display: true, text: charted[0].unit || "", color: muted }, ticks: { color: muted }, grid: { color: grid } },
      },
    },
  });
}

function resetChart() {
  state.lastChartTs = 0;
  if (!state.chart) return;
  state.chart.data.labels = [];
  state.chart.data.datasets.forEach((d) => { d.data = []; });
  state.chart.update("none");
}

function updateChart(values) {
  if (!state.chart) return;
  const ts = Math.max(0, ...SENSORS.filter((s) => s.chart && values[s.variable]).map((s) => values[s.variable].ts));
  if (!ts || ts <= state.lastChartTs) return;
  state.lastChartTs = ts;
  const { labels } = state.chart.data;
  labels.push(clock(ts));
  state.chartSeries.forEach((x) => x.ds.data.push(x.get(values)));
  while (labels.length > CHART_POINTS) {
    labels.shift();
    state.chartSeries.forEach((x) => x.ds.data.shift());
  }
  state.chart.update("none");
}

/* ---------- Pengiriman ---------- */

function markPending(variable, busy) {
  document.querySelectorAll(`[data-variable="${CSS.escape(variable)}"]`).forEach((n) => n.classList.toggle("pending", busy));
}

function send(variable, value) {
  const q = state.sendQ[variable] || (state.sendQ[variable] = { busy: false, has: false, value: null, changedAt: 0 });
  q.value = value;
  q.has = true;
  q.changedAt = Date.now();
  if (!q.busy) flush(variable, q);
}

async function flush(variable, q) {
  q.busy = true;
  markPending(variable, true);
  let tries = 0;
  while (q.has) {
    const value = q.value;
    q.has = false;
    try {
      await postValues({ [variable]: value });
      tries = 0;
    } catch (e) {
      if (e.kind !== "auth" && !q.has && ++tries < 3) {
        q.value = value;
        q.has = true;
        await sleep(300);
        continue;
      }
      tries = 0;
      toast(`Gagal kirim ${variable}=${value}. ${errorText(e)}`, true);
    }
  }
  q.busy = false;
  markPending(variable, false);
}

async function emergencyStop() {
  releaseAllHolds();
  if (navigator.vibrate) navigator.vibrate(120);
  send(EMERGENCY.variable, EMERGENCY.value);
  try {
    await postValues({ [EMERGENCY.variable]: EMERGENCY.value });
    toast("STOP terkirim");
  } catch (e) {
    toast(`STOP GAGAL! ${errorText(e)}`, true);
  }
}

/* ---------- Kontrol ---------- */

const holdButtons = new Map();

function startHold(c) {
  if (state.holds.has(c)) return;
  const btn = holdButtons.get(c);
  if (btn) btn.classList.add("active");
  send(c.variable, c.value);
  state.holds.set(c, setInterval(() => send(c.variable, c.value), HOLD_REPEAT_MS));
}

function stopHold(c) {
  if (!state.holds.has(c)) return;
  clearInterval(state.holds.get(c));
  state.holds.delete(c);
  const btn = holdButtons.get(c);
  if (btn) btn.classList.remove("active");
  const other = [...state.holds.keys()].find((h) => h.variable === c.variable);
  send(c.variable, other ? other.value : (c.release ?? 0));
}

function releaseAllHolds() {
  [...state.holds.keys()].forEach(stopHold);
}

function controlButton(c, className) {
  const b = el("button", `btn ${className}`, c.label);
  b.type = "button";
  if (c.title) {
    b.title = c.title;
    b.setAttribute("aria-label", c.title);
  }
  if (c.pad) b.style.gridArea = c.pad;
  if (c.style) b.classList.add(c.style);
  return b;
}

function buildButton(c) {
  const b = controlButton(c, "ctl-button");
  b.addEventListener("click", () => send(c.variable, c.value));
  return b;
}

function buildHold(c) {
  const b = controlButton(c, "ctl-hold");
  holdButtons.set(c, b);
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch {}
    startHold(c);
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
    b.addEventListener(ev, () => stopHold(c));
  }
  b.addEventListener("contextmenu", (e) => e.preventDefault());
  return b;
}

function buildRow(c, valueText) {
  const row = el("div", "ctl-row");
  row.dataset.variable = c.variable;
  const head = el("div", "ctl-head");
  const value = el("span", "ctl-value", valueText);
  head.append(el("span", "", c.label), value);
  row.append(head);
  return { row, value };
}

function buildToggle(c) {
  const { row, value } = buildRow(c, "");
  const seg = el("div", "segmented");
  const opts = [c.on, c.off];
  const buttons = opts.map((o) => {
    const b = el("button", "btn", o.label);
    b.type = "button";
    b.addEventListener("click", () => { set(o.value); send(c.variable, o.value); });
    seg.append(b);
    return b;
  });
  function set(v) {
    opts.forEach((o, i) => buttons[i].setAttribute("aria-pressed", String(o.value === v)));
    const cur = opts.find((o) => o.value === v);
    value.textContent = cur ? cur.label : String(v);
  }
  set(c.value ?? c.off.value);
  row.append(seg);
  state.ui[`control:${c.variable}`] = { sync: set, always: true };
  return row;
}

function buildSlider(c) {
  const fmt = (v) => `${v}${c.unit || ""}`;
  const { row, value } = buildRow(c, fmt(c.value ?? c.min));
  const input = el("input");
  input.type = "range";
  input.min = c.min;
  input.max = c.max;
  input.step = c.step ?? 1;
  input.value = c.value ?? c.min;
  input.setAttribute("aria-label", c.label);
  let dragging = false;
  input.addEventListener("pointerdown", () => { dragging = true; });
  for (const ev of ["pointerup", "pointercancel", "change"]) input.addEventListener(ev, () => { dragging = false; });
  input.addEventListener("input", () => {
    value.textContent = fmt(input.value);
    send(c.variable, Number(input.value));
  });
  row.append(input);
  state.ui[`control:${c.variable}`] = {
    sync: (v) => {
      if (dragging) return;
      input.value = v;
      value.textContent = fmt(input.value);
    },
  };
  return row;
}

function buildControl(c) {
  switch (c.type) {
    case "button": return buildButton(c);
    case "hold": return buildHold(c);
    case "toggle": return buildToggle(c);
    case "slider": return buildSlider(c);
    default:
      console.warn("Tipe kontrol tidak dikenal:", c);
      return el("div", "muted", `Tipe "${c.type}" tidak dikenal`);
  }
}

function renderControls() {
  const root = $("#control-groups");
  root.innerHTML = "";
  const groups = new Map();
  for (const c of CONTROLS) {
    const name = c.group || "Kontrol";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(c);
  }
  for (const [name, items] of groups) {
    const card = el("div", "card group");
    card.append(el("h3", "", name));
    const padItems = items.filter((c) => c.pad);
    const rest = items.filter((c) => !c.pad);
    if (padItems.length) {
      const pad = el("div", "pad");
      padItems.forEach((c) => pad.append(buildControl(c)));
      card.append(pad);
    }
    if (rest.length) {
      const list = el("div", "ctl-list");
      rest.forEach((c) => list.append(buildControl(c)));
      card.append(list);
    }
    root.append(card);
  }
}

function syncControls(values) {
  for (const c of CONTROLS) {
    const ui = state.ui[`control:${c.variable}`];
    const dot = values[c.variable];
    if (!ui || !dot) continue;
    if (!state.firstSync && !ui.always) continue;
    const q = state.sendQ[c.variable];
    if (q && (q.busy || Date.now() - q.changedAt < 3000)) continue;
    ui.sync(dot.value);
  }
  state.firstSync = false;
}

/* ---------- Polling ---------- */

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.token || state.polling) return;
  state.polling = true;
  let delay = state.settings.pollInterval * 1000;
  try {
    const values = await readValues();
    setBanner("");
    updateSensors(values);
    syncControls(values);
    updateChart(values);
    updateRobotStatus(values);
    state.lastPoll = Date.now();
    $("#last-update").textContent = `diperbarui ${clock(state.lastPoll)}`;
  } catch (e) {
    setBanner(errorText(e), e.kind === "notfound" || e.kind === "ratelimit");
    updateRobotStatus();
    delay = Math.max(delay, ERROR_RETRY_MS);
  } finally {
    state.polling = false;
  }
  if (state.token && !document.hidden) schedulePoll(delay);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
}

/* ---------- Kamera ---------- */

function cameraUrl() {
  const raw = (state.settings.camera || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `http://${raw}${/[:/]/.test(raw) ? "" : CAMERA_DEFAULT_PATH}`;
}

function updateCameraInfo() {
  const url = cameraUrl();
  $("#camera-info").textContent = url
    ? `Stream: ${url}`
    : "IP kamera belum diisi. Atur di Pengaturan (⚙).";
}

function openCamera() {
  const url = cameraUrl();
  if (!url) {
    toast("Isi IP kamera dulu di Pengaturan.", true);
    openSettings("#set-camera");
    return;
  }
  window.open(url, "_blank", "noopener");
}

/* ---------- Pengaturan & login ---------- */

function saveSettings() {
  store.set(KEY_SETTINGS, state.settings);
}

function openSettings(focusSel) {
  const dlg = $("#settings");
  $("#set-device").value = state.settings.device;
  $("#set-camera").value = state.settings.camera;
  $("#set-interval").value = state.settings.pollInterval;
  $("#set-token").value = state.token;
  $("#set-token").type = "password";
  dlg.returnValue = "";
  dlg.showModal();
  if (focusSel) $(focusSel).focus();
}

function applySettings() {
  const device = $("#set-device").value.trim() || DEFAULTS.device;
  const interval = Math.min(60, Math.max(0.5, Number($("#set-interval").value) || DEFAULTS.pollInterval));
  const token = $("#set-token").value.trim();
  const deviceChanged = device !== state.settings.device;
  state.settings = { device, camera: $("#set-camera").value.trim(), pollInterval: interval };
  saveSettings();
  if (token && token !== state.token) {
    state.token = token;
    store.set(KEY_TOKEN, token);
  }
  if (deviceChanged) {
    state.readMode = "v2";
    state.firstSync = true;
    state.lastSeen = 0;
    state.levels = {};
    resetChart();
  }
  updateCameraInfo();
  toast("Pengaturan disimpan");
  poll();
}

function logout() {
  if (!confirm("Logout dan hapus token Ubidots dari browser ini?")) return;
  releaseAllHolds();
  stopPolling();
  state.token = "";
  store.remove(KEY_TOKEN);
  $("#settings").close();
  showLogin();
}

function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-device").value = state.settings.device;
  $("#login-token").value = "";
  $("#login-error").hidden = true;
}

function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  state.readMode = "v2";
  state.firstSync = true;
  state.lastSeen = 0;
  resetChart();
  updateCameraInfo();
  updateRobotStatus();
  poll();
}

async function handleLogin(e) {
  e.preventDefault();
  const token = $("#login-token").value.trim();
  const device = $("#login-device").value.trim() || DEFAULTS.device;
  const err = $("#login-error");
  const submit = $("#login-submit");
  err.hidden = true;
  submit.disabled = true;
  submit.textContent = "Memeriksa token…";
  state.settings.device = device;
  state.readMode = "v2";
  try {
    await readValues(token);
  } catch (ex) {
    if (ex.kind === "auth") {
      err.textContent = errorText(ex);
      err.hidden = false;
      submit.disabled = false;
      submit.textContent = "Masuk";
      return;
    }
  }
  submit.disabled = false;
  submit.textContent = "Masuk";
  state.token = token;
  store.set(KEY_TOKEN, token);
  saveSettings();
  showApp();
}

/* ---------- Event global ---------- */

function keysOf(c) {
  return [].concat(c.key || []).map((k) => k.toLowerCase());
}

function holdForKey(e) {
  const key = e.key.toLowerCase();
  return CONTROLS.find((c) => c.type === "hold" && keysOf(c).includes(key));
}

function ignoreKeys(e) {
  return $("#app").hidden || $("#settings").open || e.target.closest("input, textarea, select");
}

function bindEvents() {
  $("#login-form").addEventListener("submit", handleLogin);
  $("#estop").addEventListener("click", emergencyStop);
  $("#open-settings").addEventListener("click", () => openSettings());
  $("#open-camera").addEventListener("click", openCamera);
  $("#logout").addEventListener("click", logout);
  $("#settings").addEventListener("close", () => {
    if ($("#settings").returnValue === "save") applySettings();
  });
  document.querySelectorAll("[data-reveal]").forEach((b) => {
    b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.reveal);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.textContent = show ? "Sembunyi" : "Lihat";
    });
  });

  document.addEventListener("keydown", (e) => {
    if (ignoreKeys(e)) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) emergencyStop();
      return;
    }
    const c = holdForKey(e);
    if (!c) return;
    e.preventDefault();
    if (!e.repeat) startHold(c);
  });
  document.addEventListener("keyup", (e) => {
    const c = holdForKey(e);
    if (c) stopHold(c);
  });

  window.addEventListener("blur", releaseAllHolds);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAllHolds();
      stopPolling();
    } else if (state.token && !$("#app").hidden) {
      poll();
    }
  });
  window.addEventListener("online", () => { if (state.token) poll(); });
  window.addEventListener("offline", () => setBanner(errorText({ kind: "offline" })));
}

function init() {
  renderSensors();
  renderControls();
  initChart();
  bindEvents();
  if (state.token) showApp();
  else showLogin();
}

init();
