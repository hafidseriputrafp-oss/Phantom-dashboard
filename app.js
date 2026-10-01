/*
 * KONFIGURASI DEFAULT — bisa diubah di sini, atau langsung dari halaman lewat "Edit Dashboard"
 * (hasil edit disimpan di localStorage dan bisa di-Export/Import sebagai JSON).
 *
 * Sensor : { label, variable, unit, decimals, icon, color, chart, thresholds: [{ above | below, level: "warn"|"danger", note }] }
 * Kontrol: { type: "button"|"hold"|"toggle"|"slider", group, label, variable, color, ... }
 *   button : value, pad
 *   hold   : value, release, pad, key
 *   toggle : on:{label,value}, off:{label,value}, value (awal)
 *   slider : min, max, step, value (awal), unit
 *   pad    : "up"|"down"|"left"|"right"|"center"|"upleft"|"upright"|"downleft"|"downright"
 */
const DEFAULT_SENSORS = [
  {
    label: "Suhu Objek", variable: "suhu_objek", unit: "°C", decimals: 1, icon: "🎯", color: "#d95926", chart: true,
    thresholds: [{ above: 35, level: "danger", note: "KORBAN TERDETEKSI" }],
  },
  { label: "Suhu Ambient", variable: "suhu_ambient", unit: "°C", decimals: 1, icon: "🌡️", color: "#3987e5", chart: true, thresholds: [] },
  {
    label: "Baterai Motor", variable: "batt_motor", unit: "V", decimals: 2, icon: "🔋", color: "#9085e9", chart: false,
    thresholds: [
      { below: 6.6, level: "danger", note: "Baterai kritis" },
      { below: 7.0, level: "warn", note: "Baterai lemah" },
    ],
  },
  {
    label: "Baterai Servo", variable: "batt_servo", unit: "V", decimals: 2, icon: "⚡", color: "#199e70", chart: false,
    thresholds: [
      { below: 4.6, level: "danger", note: "Baterai kritis" },
      { below: 5.0, level: "warn", note: "Baterai lemah" },
    ],
  },
];

const DEFAULT_CONTROLS = [
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
const THEMES = [
  { id: "garuda", label: "Biru Garuda", swatch: "#3b8eea" },
  { id: "rescue", label: "Merah Rescue", swatch: "#ff5a36" },
  { id: "military", label: "Hijau Militer", swatch: "#8fb04f" },
  { id: "neon", label: "Ungu Neon", swatch: "#a970ff" },
];
const GROUP_ICONS = { Gerak: "✥", Gripper: "✊" };
const DEFAULT_SETTINGS = { v: 2, device: "phantom", camera: "", pollInterval: 3, theme: "garuda", mode: "dark" };

const API_BASE = "https://industrial.api.ubidots.com/api";
const CAMERA_DEFAULT_PATH = ":81/stream";
const REQUEST_GAP_MS = 1100;
const REQUEST_TIMEOUT_MS = 8000;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const HOLD_HEARTBEAT_MS = 1500;
const MIN_POLL_S = 1;
const ROBOT_ONLINE_MS = 15000;
const ROBOT_LATE_MS = 60000;
const STALE_MS = 20000;
const CHART_POINTS = 60;

const PRIORITY = { poll: 1, control: 2, heartbeat: 3, urgent: 9 };
const RETRYABLE = new Set(["ratelimit", "timeout", "network", "server"]);
const PAD_POSITIONS = ["up", "down", "left", "right", "center", "upleft", "upright", "downleft", "downright"];
const CONTROL_TYPES = { button: "Tombol (klik)", hold: "Tahan (hold)", toggle: "Toggle (2 pilihan)", slider: "Slider" };
const VARIABLE_RE = /^[a-z0-9_-]+$/;

const KEY_TOKEN = "phantom.token";
const KEY_SETTINGS = "phantom.settings";
const KEY_CONFIG = "phantom.config";

/* ---------- Penyimpanan & konfigurasi ---------- */

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

const uid = () => Math.random().toString(36).slice(2, 10);
const clone = (x) => JSON.parse(JSON.stringify(x));
const num = (v, fallback) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : Number(v));

function normalizeSensor(s) {
  return {
    id: s.id || uid(),
    label: String(s.label || s.variable || "Sensor"),
    variable: String(s.variable || "").toLowerCase(),
    unit: String(s.unit ?? ""),
    decimals: Math.min(4, Math.max(0, num(s.decimals, 1))),
    icon: String(s.icon ?? "📟"),
    color: /^#[0-9a-f]{6}$/i.test(s.color || "") ? s.color : "#3987e5",
    chart: Boolean(s.chart),
    thresholds: (Array.isArray(s.thresholds) ? s.thresholds : [])
      .filter((t) => t && (t.above !== undefined || t.below !== undefined))
      .map((t) => {
        const out = { level: t.level === "warn" ? "warn" : "danger", note: String(t.note || "") };
        if (t.above !== undefined) out.above = Number(t.above);
        else out.below = Number(t.below);
        return out;
      }),
  };
}

function normalizeControl(c) {
  const type = CONTROL_TYPES[c.type] ? c.type : "button";
  const out = {
    id: c.id || uid(),
    type,
    group: String(c.group || "Kontrol"),
    label: String(c.label || c.variable || "Kontrol"),
    variable: String(c.variable || "").toLowerCase(),
  };
  if (c.title) out.title = String(c.title);
  if (c.color && /^#[0-9a-f]{6}$/i.test(c.color)) out.color = c.color;
  if (c.style) out.style = String(c.style);
  if ((type === "button" || type === "hold") && PAD_POSITIONS.includes(c.pad)) out.pad = c.pad;
  if (type === "button") out.value = num(c.value, 1);
  if (type === "hold") {
    out.value = num(c.value, 1);
    out.release = num(c.release, 0);
    const keys = Array.isArray(c.key) ? c.key : String(c.key || "").split(",");
    out.key = keys.map((k) => String(k).trim()).filter(Boolean);
  }
  if (type === "toggle") {
    out.on = { label: String(c.on?.label || "ON"), value: num(c.on?.value, 1) };
    out.off = { label: String(c.off?.label || "OFF"), value: num(c.off?.value, 0) };
    out.value = num(c.value, out.off.value);
  }
  if (type === "slider") {
    out.min = num(c.min, 0);
    out.max = num(c.max, 100);
    out.step = num(c.step, 1) || 1;
    out.value = Math.min(out.max, Math.max(out.min, num(c.value, out.min)));
    out.unit = String(c.unit ?? "");
  }
  return out;
}

function normalizeConfig(raw) {
  return {
    sensors: (raw && Array.isArray(raw.sensors) ? raw.sensors : DEFAULT_SENSORS).map(normalizeSensor),
    controls: (raw && Array.isArray(raw.controls) ? raw.controls : DEFAULT_CONTROLS).map(normalizeControl),
  };
}

function loadSettings() {
  const saved = store.get(KEY_SETTINGS, {});
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  if (!saved.v) settings.pollInterval = Math.max(settings.pollInterval, DEFAULT_SETTINGS.pollInterval);
  settings.v = DEFAULT_SETTINGS.v;
  if (!THEMES.some((t) => t.id === settings.theme)) settings.theme = DEFAULT_SETTINGS.theme;
  if (settings.mode !== "light") settings.mode = "dark";
  return settings;
}

const state = {
  token: store.get(KEY_TOKEN, ""),
  settings: loadSettings(),
  config: normalizeConfig(store.get(KEY_CONFIG, null)),
  editing: false,
  pollTimer: null,
  polling: false,
  readMode: "v2",
  firstSync: true,
  lastValues: {},
  lastSeen: 0,
  chart: null,
  chartSeries: [],
  lastChartTs: 0,
  holds: new Map(),
  sendQ: {},
  ui: {},
  levels: {},
  bannerKind: "",
};

function saveConfig() {
  store.set(KEY_CONFIG, state.config);
}

/* ---------- Utilitas DOM ---------- */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el("button", className, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function vibrate(pattern) {
  if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(pattern);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
const clock = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
}

function setBanner(message, kind = "") {
  const b = $("#banner");
  state.bannerKind = message ? kind : "";
  b.hidden = !message;
  b.textContent = message || "";
  b.classList.toggle("warn", kind === "notfound" || kind === "ratelimit");
}

/* ---------- API Ubidots + pembatas request ---------- */

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

function rateLimitText() {
  const s = Math.max(1, Math.ceil((limiter.backoffUntil - Date.now()) / 1000));
  return `Batas request Ubidots tercapai (HTTP 429 — akun STEM maks. 1 request/detik). Jeda otomatis, mencoba lagi dalam ${s} dtk. Perbesar interval polling di Pengaturan bila sering terjadi.`;
}

function errorText(e) {
  switch (e && e.kind) {
    case "auth": return "Token Ubidots ditolak. Periksa token di Pengaturan.";
    case "notfound": return `Device "${state.settings.device}" belum ada di Ubidots. Periksa device label atau nyalakan robot.`;
    case "ratelimit": return rateLimitText();
    case "offline": return "HP/laptop ini sedang offline. Periksa koneksi internet.";
    case "timeout": return "Ubidots tidak merespons (timeout). Koneksi lambat?";
    case "network": return "Tidak dapat menghubungi Ubidots. Periksa koneksi internet.";
    case "server": return `Server Ubidots bermasalah (HTTP ${e.status}). Coba lagi sebentar.`;
    case "bad": return `Permintaan ditolak Ubidots (HTTP ${e.status}).`;
    default: return "Terjadi kesalahan tak terduga.";
  }
}

const limiter = {
  queue: [],
  pumping: false,
  last: 0,
  seq: 0,
  backoffUntil: 0,
  backoffMs: 0,
  run(fn, priority = PRIORITY.poll) {
    if (priority >= PRIORITY.urgent) {
      this.last = Date.now();
      return fn();
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, priority, resolve, reject, seq: this.seq++ });
      this.pump();
    });
  },
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length) {
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      const wait = Math.max(this.last + REQUEST_GAP_MS, this.backoffUntil) - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, 200));
        continue;
      }
      const job = this.queue.shift();
      this.last = Date.now();
      Promise.resolve().then(job.fn).then(job.resolve, job.reject);
    }
    this.pumping = false;
  },
  rateLimited(retryAfterS) {
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs ? this.backoffMs * 2 : BACKOFF_START_MS);
    const wait = Math.max(this.backoffMs, (retryAfterS || 0) * 1000);
    this.backoffUntil = Date.now() + wait;
  },
  ok() {
    this.backoffMs = 0;
  },
};

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
  if (res.status === 429) {
    limiter.rateLimited(Number(res.headers.get("Retry-After")));
    throw new ApiError("ratelimit", 429);
  }
  if (!res.ok) throw new ApiError(kindFromStatus(res.status), res.status);
  limiter.ok();
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
      const path = `/v2.0/devices/~${deviceLabel()}/variables/?page_size=200`;
      const data = await limiter.run(() => api("GET", path, null, token), PRIORITY.poll);
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

  const labels = state.config.sensors.map((s) => s.variable);
  const results = [];
  for (const label of labels) {
    const path = `/v1.6/devices/${deviceLabel()}/${encodeURIComponent(label)}/values/?page_size=1`;
    results.push(await limiter.run(() => api("GET", path, null, token), PRIORITY.poll)
      .catch((e) => (e.kind === "notfound" ? null : Promise.reject(e))));
  }
  if (results.length && results.every((r) => r === null)) throw new ApiError("notfound", 404);
  const out = {};
  results.forEach((r, i) => {
    const dot = r && r.results && r.results[0];
    if (dot) out[labels[i]] = { value: Number(dot.value), ts: Number(dot.timestamp) || 0 };
  });
  return out;
}

/* ---------- Monitoring ---------- */

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

function renderSensors() {
  const grid = $("#sensor-grid");
  grid.innerHTML = "";
  for (const s of state.config.sensors) {
    const card = el("div", "card sensor");
    card.dataset.id = s.id;
    card.style.setProperty("--c", s.color);
    const head = el("div", "sensor-head");
    head.append(el("span", "sensor-icon", s.icon || "📟"), el("span", "label", s.label));
    const reading = el("div", "reading");
    const value = el("span", "value", "—");
    reading.append(value, el("span", "unit", s.unit || ""));
    const note = el("div", "note");
    const age = el("div", "age", "belum ada data");
    card.append(head, reading, note, age);
    if (state.editing) {
      addEditOverlay(card, {
        draggable: true,
        onEdit: () => openSensorEditor(s),
        onDelete: () => removeItem("sensors", s),
      });
    }
    grid.append(card);
    state.ui[`sensor:${s.id}`] = { card, value, note, age };
  }
  if (state.editing) {
    grid.append(button("+ Tambah sensor", "add-tile", () => openSensorEditor(null)));
  }
  updateSensors(state.lastValues, true);
}

function levelOf(s, v) {
  const hit = s.thresholds.find((t) =>
    (t.above !== undefined && v > t.above) || (t.below !== undefined && v < t.below));
  return hit || { level: s.thresholds.length ? "ok" : "", note: "" };
}

function updateSensors(values, silent = false) {
  const now = Date.now();
  const alerts = [];
  for (const s of state.config.sensors) {
    const ui = state.ui[`sensor:${s.id}`];
    if (!ui) continue;
    const dot = values[s.variable];
    ui.card.classList.remove("ok", "warn", "danger", "stale");
    if (!dot || Number.isNaN(dot.value)) {
      ui.value.textContent = "—";
      ui.note.textContent = "";
      ui.age.textContent = "belum ada data";
      state.levels[s.id] = "";
      continue;
    }
    ui.value.textContent = dot.value.toFixed(s.decimals);
    const lv = levelOf(s, dot.value);
    if (lv.level) ui.card.classList.add(lv.level);
    ui.note.textContent = lv.note || "";
    ui.age.textContent = dot.ts ? `⏱ ${ago(now - dot.ts)}` : "";
    if (dot.ts && now - dot.ts > STALE_MS) ui.card.classList.add("stale");

    if (lv.level === "danger") {
      alerts.push(`${(lv.note || "Di luar ambang").toUpperCase()} — ${s.label} ${dot.value.toFixed(s.decimals)}${s.unit}`);
      if (!silent && state.levels[s.id] !== "danger") vibrate([200, 100, 200]);
    }
    state.levels[s.id] = lv.level;
  }
  const strip = $("#alert-strip");
  strip.hidden = !alerts.length;
  strip.textContent = alerts.length ? `⚠ ${alerts.join("  ·  ")}` : "";
}

function updateRobotStatus(values) {
  if (values) {
    for (const s of state.config.sensors) {
      const dot = values[s.variable];
      if (dot && dot.ts > state.lastSeen) state.lastSeen = dot.ts;
    }
  }
  const box = $("#link-status");
  const label = $("#robot-status");
  box.classList.remove("online", "late", "offline");
  if (!state.lastSeen) {
    label.textContent = "ROBOT: BELUM ADA DATA";
    box.classList.add("offline");
    return;
  }
  const age = Date.now() - state.lastSeen;
  if (age < ROBOT_ONLINE_MS) {
    label.textContent = "ROBOT ONLINE";
    box.classList.add("online");
  } else if (age < ROBOT_LATE_MS) {
    label.textContent = `TERTUNDA · ${ago(age)}`;
    box.classList.add("late");
  } else {
    label.textContent = `OFFLINE · ${ago(age)}`;
    box.classList.add("offline");
  }
}

const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function tick() {
  const now = new Date();
  $("#clock-time").textContent = clock(now);
  $("#clock-date").textContent = `${DAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  if (!$("#app").hidden) updateRobotStatus();
  if (state.bannerKind === "ratelimit") {
    if (limiter.backoffUntil > Date.now()) $("#banner").textContent = rateLimitText();
    else $("#banner").textContent = "Batas request Ubidots tercapai (HTTP 429). Mencoba lagi…";
  }
}

/* ---------- Grafik ---------- */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function initChart() {
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  state.lastChartTs = 0;
  const charted = state.config.sensors.filter((s) => s.chart);
  const canvas = $("#chart");
  const fallback = $("#chart-fallback");
  if (!window.Chart || !charted.length) {
    canvas.hidden = true;
    fallback.hidden = false;
    fallback.textContent = window.Chart
      ? "Belum ada sensor yang ditampilkan di grafik. Aktifkan lewat Edit Dashboard."
      : "Grafik tidak tersedia (Chart.js gagal dimuat).";
    return;
  }
  canvas.hidden = false;
  fallback.hidden = true;
  const series = [];
  const limits = [];
  for (const s of charted) {
    series.push({
      get: (values) => (values[s.variable] ? values[s.variable].value : null),
      ds: { label: s.label, data: [], borderColor: s.color, backgroundColor: s.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.3, spanGaps: true },
    });
    for (const t of s.thresholds) {
      if (t.level !== "danger" || t.above === undefined) continue;
      limits.push({
        get: () => t.above,
        ds: { label: `Ambang ${t.above}${s.unit}`, data: [], borderColor: "#e5484d", backgroundColor: "#e5484d", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0 },
      });
    }
  }
  series.push(...limits);
  state.chartSeries = series;
  state.chart = new Chart(canvas, {
    type: "line",
    data: { labels: [], datasets: series.map((x) => x.ds) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { usePointStyle: true, pointStyle: "line", boxWidth: 24, font: { family: "Rajdhani", size: 14, weight: "600" } } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y === null ? "—" : ctx.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, maxRotation: 0 } },
        y: { title: { display: true, text: charted[0].unit || "" } },
      },
    },
  });
  applyChartTheme();
}

function applyChartTheme() {
  const c = state.chart;
  if (!c) return;
  const muted = cssVar("--text-2");
  const grid = cssVar("--border");
  c.options.plugins.legend.labels.color = muted;
  for (const axis of ["x", "y"]) {
    c.options.scales[axis].ticks.color = muted;
    c.options.scales[axis].grid = { color: grid };
  }
  c.options.scales.y.title.color = muted;
  c.update("none");
}

function updateChart(values) {
  if (!state.chart) return;
  const stamps = state.config.sensors.filter((s) => s.chart && values[s.variable]).map((s) => values[s.variable].ts);
  const ts = Math.max(0, ...stamps);
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

/* ---------- Pengiriman perintah ---------- */

function markPending(variable, busy) {
  document.querySelectorAll(`[data-variable="${CSS.escape(variable)}"]`).forEach((n) => n.classList.toggle("pending", busy));
}

const isUrgent = (variable, value) => variable === EMERGENCY.variable && value === EMERGENCY.value;

function send(variable, value, priority = PRIORITY.control) {
  const q = state.sendQ[variable] || (state.sendQ[variable] = { busy: false, has: false, value: null, priority, changedAt: 0 });
  q.changedAt = Date.now();
  q.value = value;
  if (isUrgent(variable, value)) {
    sendUrgent(variable, value);
    if (!q.busy) return;
  }
  q.has = true;
  q.priority = priority;
  if (!q.busy) flush(variable, q);
}

async function flush(variable, q) {
  q.busy = true;
  markPending(variable, true);
  let tries = 0;
  while (q.has) {
    let sent = null;
    try {
      await limiter.run(() => {
        sent = q.value;
        q.has = false;
        return postValues({ [variable]: sent });
      }, q.priority);
      tries = 0;
    } catch (e) {
      if (RETRYABLE.has(e.kind) && ++tries < 4) {
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
  markPending(variable, false);
}

async function sendUrgent(variable, value) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await limiter.run(() => postValues({ [variable]: value }), PRIORITY.urgent);
      return true;
    } catch (e) {
      lastErr = e;
      if (e.kind === "auth") break;
      await sleep(1200);
    }
  }
  toast(`Gagal kirim ${variable}=${value}. ${errorText(lastErr)}`, true);
  return false;
}

async function emergencyStop() {
  for (const c of [...state.holds.keys()]) stopHold(c, true);
  vibrate(150);
  const btn = $("#estop");
  btn.classList.add("fired");
  setTimeout(() => btn.classList.remove("fired"), 300);
  send(EMERGENCY.variable, EMERGENCY.value);
  toast("STOP DARURAT dikirim");
}

/* ---------- Kontrol ---------- */

const holdButtons = new Map();

function startHold(c) {
  if (state.editing || state.holds.has(c)) return;
  const btn = holdButtons.get(c.id);
  if (btn) btn.classList.add("active");
  send(c.variable, c.value, PRIORITY.heartbeat);
  state.holds.set(c, setInterval(() => send(c.variable, c.value, PRIORITY.heartbeat), HOLD_HEARTBEAT_MS));
}

function stopHold(c, silent = false) {
  if (!state.holds.has(c)) return;
  clearInterval(state.holds.get(c));
  state.holds.delete(c);
  const btn = holdButtons.get(c.id);
  if (btn) btn.classList.remove("active");
  if (silent) return;
  const other = [...state.holds.keys()].find((h) => h.variable === c.variable);
  send(c.variable, other ? other.value : c.release, other ? PRIORITY.heartbeat : PRIORITY.control);
  if (!state.holds.size) schedulePoll(state.settings.pollInterval * 1000);
}

function releaseAllHolds() {
  [...state.holds.keys()].forEach((c) => stopHold(c));
}

function controlButton(c, className) {
  const b = el("button", `btn ${className}`, c.label);
  b.type = "button";
  if (c.title) {
    b.title = c.title;
    b.setAttribute("aria-label", c.title);
  }
  if (c.style) b.classList.add(c.style);
  if (c.color) b.style.setProperty("--c", c.color);
  return b;
}

function buildButton(c) {
  const b = controlButton(c, "ctl-button");
  b.addEventListener("click", () => {
    if (!state.editing) send(c.variable, c.value);
  });
  return b;
}

function buildHold(c) {
  const b = controlButton(c, "ctl-hold");
  holdButtons.set(c.id, b);
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
  if (c.color) row.style.setProperty("--c", c.color);
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
    const b = button(o.label, "btn", () => {
      if (state.editing) return;
      set(o.value);
      send(c.variable, o.value);
    });
    seg.append(b);
    return b;
  });
  function set(v) {
    opts.forEach((o, i) => buttons[i].setAttribute("aria-pressed", String(o.value === v)));
    const cur = opts.find((o) => o.value === v);
    value.textContent = cur ? cur.label : String(v);
  }
  set(c.value);
  row.append(seg);
  state.ui[`control:${c.id}`] = { sync: set, always: true };
  return row;
}

function buildSlider(c) {
  const fmt = (v) => `${v}${c.unit || ""}`;
  const { row, value } = buildRow(c, fmt(c.value));
  const input = el("input");
  input.type = "range";
  input.min = c.min;
  input.max = c.max;
  input.step = c.step;
  input.value = c.value;
  input.setAttribute("aria-label", c.label);
  let dragging = false;
  input.addEventListener("pointerdown", () => { dragging = true; });
  for (const ev of ["pointerup", "pointercancel", "change"]) input.addEventListener(ev, () => { dragging = false; });
  input.addEventListener("input", () => {
    value.textContent = fmt(input.value);
    send(c.variable, Number(input.value));
  });
  row.append(input);
  state.ui[`control:${c.id}`] = {
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
    default: return el("div", "muted", `Tipe "${c.type}" tidak dikenal`);
  }
}

function groupsOf(controls) {
  const groups = new Map();
  for (const c of controls) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  return groups;
}

function wrapControl(c) {
  const item = el("div", "ctl-item");
  item.dataset.id = c.id;
  item.style.position = "relative";
  if (c.pad) item.style.gridArea = c.pad;
  item.append(buildControl(c));
  if (state.editing) {
    addEditOverlay(item, {
      draggable: !c.pad,
      onEdit: () => openControlEditor(c),
      onDelete: () => removeItem("controls", c),
    });
  }
  return item;
}

function renderControls() {
  const root = $("#control-groups");
  root.innerHTML = "";
  holdButtons.clear();
  for (const [name, items] of groupsOf(state.config.controls)) {
    const card = el("div", "card group");
    card.dataset.id = name;
    card.dataset.group = name;
    const title = el("h3");
    title.append(el("span", "group-icon", GROUP_ICONS[name] || "▣"), document.createTextNode(` ${name}`));
    card.append(title);
    if (state.editing) {
      const tools = el("div", "group-head-tools edit-tools");
      const handle = button("⠿", "drag-handle");
      handle.title = "Seret untuk mengurutkan grup";
      tools.append(handle);
      card.append(tools);
    }
    const padItems = items.filter((c) => c.pad);
    const rest = items.filter((c) => !c.pad);
    if (padItems.length) {
      const pad = el("div", "pad");
      padItems.forEach((c) => pad.append(wrapControl(c)));
      card.append(pad);
    }
    const list = el("div", "ctl-list");
    rest.forEach((c) => list.append(wrapControl(c)));
    if (state.editing) list.append(button(`+ Tambah kontrol di ${name}`, "add-tile", () => openControlEditor(null, name)));
    if (rest.length || state.editing) card.append(list);
    if (state.editing) makeSortable(list, ".ctl-item[data-id]", (ids) => reorderGroup(name, ids));
    root.append(card);
  }
  const camera = $("#camera-template").content.firstElementChild.cloneNode(true);
  root.append(camera);
  camera.querySelector("#open-camera").addEventListener("click", openCamera);
  updateCameraInfo();
}

function syncControls(values) {
  for (const c of state.config.controls) {
    const ui = state.ui[`control:${c.id}`];
    const dot = values[c.variable];
    if (!ui || !dot) continue;
    if (!state.firstSync && !ui.always) continue;
    const q = state.sendQ[c.variable];
    if (q && (q.busy || Date.now() - q.changedAt < 5000)) continue;
    ui.sync(dot.value);
  }
  state.firstSync = false;
}

/* ---------- Mode edit ---------- */

function addEditOverlay(host, { draggable, onEdit, onDelete }) {
  const overlay = el("div", "edit-overlay");
  overlay.title = "Klik untuk mengubah";
  overlay.addEventListener("click", onEdit);
  const tools = el("div", "edit-tools");
  if (draggable) {
    const handle = button("⠿", "drag-handle", (e) => e.stopPropagation());
    handle.title = "Seret untuk mengurutkan";
    handle.setAttribute("aria-label", "Seret untuk mengurutkan");
    tools.append(handle);
  }
  const del = button("✕", "del", (e) => {
    e.stopPropagation();
    onDelete();
  });
  del.title = "Hapus";
  del.setAttribute("aria-label", "Hapus");
  tools.append(del);
  overlay.append(tools);
  host.append(overlay);
}

function makeSortable(container, itemSelector, onDrop) {
  container.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle) return;
    const item = handle.closest(itemSelector);
    if (!item || item.parentElement !== container) return;
    e.preventDefault();
    e.stopPropagation();
    item.classList.add("dragging");
    document.body.classList.add("drag-active");
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      if (ev.clientY < 100) window.scrollBy(0, -14);
      else if (ev.clientY > window.innerHeight - 150) window.scrollBy(0, 14);
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

function reorderSensors(ids) {
  const byId = new Map(state.config.sensors.map((s) => [s.id, s]));
  state.config.sensors = ids.map((id) => byId.get(id)).filter(Boolean);
  saveConfig();
  renderSensors();
  initChart();
}

function reorderGroup(name, ids) {
  const byId = new Map(state.config.controls.map((c) => [c.id, c]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  state.config.controls = state.config.controls.map((c) => (c.group === name && !c.pad ? ordered.shift() : c));
  saveConfig();
  renderControls();
}

function reorderGroups(names) {
  const groups = groupsOf(state.config.controls);
  state.config.controls = names.flatMap((n) => groups.get(n) || []);
  saveConfig();
  renderControls();
}

function removeItem(kind, item) {
  if (!confirm(`Hapus "${item.label}" (${item.variable})?`)) return;
  state.config[kind] = state.config[kind].filter((x) => x.id !== item.id);
  saveConfig();
  renderAll();
}

function renderAll() {
  renderSensors();
  renderControls();
  initChart();
}

function setEditing(on) {
  state.editing = on;
  if (on) releaseAllHolds();
  document.body.classList.toggle("editing", on);
  $("#editbar").hidden = !on;
  $("#edit-toggle").setAttribute("aria-pressed", String(on));
  renderSensors();
  renderControls();
}

/* ---------- Form editor ---------- */

let editorApply = null;

function field(label, input, className = "") {
  const wrap = el("label", `field ${className}`.trim());
  wrap.append(el("span", "", label), input);
  return wrap;
}

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
  s.value = value;
  return s;
}

function checkbox(name, checked, label) {
  const wrap = el("label", "field check full");
  const c = input(name, undefined, "checkbox");
  c.checked = Boolean(checked);
  wrap.append(c, el("span", "", label));
  return wrap;
}

function openEditor(title, build, apply) {
  $("#editor-title").textContent = title;
  const fields = $("#editor-fields");
  fields.innerHTML = "";
  build(fields);
  $("#editor-error").hidden = true;
  editorApply = apply;
  const dlg = $("#editor");
  dlg.returnValue = "";
  dlg.showModal();
}

function readVariable(form) {
  const v = form.elements.variable.value.trim().toLowerCase();
  if (!VARIABLE_RE.test(v)) throw new Error("Variabel Ubidots hanya boleh huruf kecil, angka, _ atau -.");
  return v;
}

function readNumber(form, name, label) {
  const raw = form.elements[name].value.trim();
  if (raw === "" || Number.isNaN(Number(raw))) throw new Error(`${label} harus berupa angka.`);
  return Number(raw);
}

function thresholdRow(t = { above: 35, level: "danger", note: "" }) {
  const row = el("div", "threshold-row");
  const dir = select("t-dir", [["above", "Di atas"], ["below", "Di bawah"]], t.below !== undefined ? "below" : "above");
  const val = input("t-val", t.above ?? t.below, "number", { step: "any", "aria-label": "Nilai ambang" });
  const lvl = select("t-level", [["danger", "Bahaya (merah)"], ["warn", "Waspada (kuning)"]], t.level);
  const note = input("t-note", t.note, "text", { placeholder: "Catatan, mis. KORBAN TERDETEKSI", "aria-label": "Catatan ambang" });
  note.classList.add("note-input");
  const del = button("✕", "btn ghost icon-btn", () => row.remove());
  del.setAttribute("aria-label", "Hapus ambang");
  row.append(dir, val, lvl, del, note);
  return row;
}

function openSensorEditor(sensor) {
  const s = sensor || normalizeSensor({ label: "Sensor baru", variable: "", unit: "", icon: "📟", color: "#3987e5" });
  openEditor(sensor ? `Ubah sensor: ${s.label}` : "Tambah sensor", (root) => {
    const grid = el("div", "form-grid");
    grid.append(
      field("Label", input("label", s.label, "text", { required: "" })),
      field("Variabel Ubidots", input("variable", s.variable, "text", { placeholder: "mis. gas_ppm", spellcheck: "false", autocapitalize: "off" })),
      field("Satuan", input("unit", s.unit, "text", { placeholder: "°C, V, ppm…" })),
      field("Desimal", input("decimals", s.decimals, "number", { min: 0, max: 4, step: 1 })),
      field("Ikon (emoji)", input("icon", s.icon, "text", { maxlength: 4 })),
      field("Warna", input("color", s.color, "color")),
      checkbox("chart", s.chart, "Tampilkan di grafik suhu"),
    );
    root.append(grid);
    root.append(el("div", "section-label", "Ambang warna (yang pertama cocok dipakai)"));
    const list = el("div", "thresholds");
    s.thresholds.forEach((t) => list.append(thresholdRow(t)));
    root.append(list, button("+ Tambah ambang", "btn ghost wide", () => list.append(thresholdRow())));
  }, (form) => {
    const thresholds = [...form.querySelectorAll(".threshold-row")].map((row) => {
      const v = row.querySelector('[name="t-val"]').value.trim();
      if (v === "" || Number.isNaN(Number(v))) throw new Error("Nilai ambang harus berupa angka.");
      const t = { level: row.querySelector('[name="t-level"]').value, note: row.querySelector('[name="t-note"]').value.trim() };
      t[row.querySelector('[name="t-dir"]').value] = Number(v);
      return t;
    });
    const next = normalizeSensor({
      id: s.id,
      label: form.elements.label.value.trim() || "Sensor",
      variable: readVariable(form),
      unit: form.elements.unit.value.trim(),
      decimals: readNumber(form, "decimals", "Desimal"),
      icon: form.elements.icon.value.trim(),
      color: form.elements.color.value,
      chart: form.elements.chart.checked,
      thresholds,
    });
    upsert("sensors", next);
  });
}

function controlSpecificFields(type, c, root) {
  root.innerHTML = "";
  const grid = el("div", "form-grid");
  const padOptions = [["", "— tidak di D-pad —"], ...PAD_POSITIONS.map((p) => [p, p])];
  if (type === "button") {
    grid.append(
      field("Nilai dikirim", input("value", c.value ?? 1, "number", { step: "any" })),
      field("Posisi D-pad", select("pad", padOptions, c.pad || "")),
    );
  } else if (type === "hold") {
    grid.append(
      field("Nilai saat ditahan", input("value", c.value ?? 1, "number", { step: "any" })),
      field("Nilai saat dilepas", input("release", c.release ?? 0, "number", { step: "any" })),
      field("Posisi D-pad", select("pad", padOptions, c.pad || "")),
      field("Tombol keyboard", input("key", (c.key || []).join(", "), "text", { placeholder: "ArrowUp, w" })),
    );
  } else if (type === "toggle") {
    const on = c.on || { label: "ON", value: 1 };
    const off = c.off || { label: "OFF", value: 0 };
    grid.append(
      field("Label pilihan 1", input("onLabel", on.label)),
      field("Nilai pilihan 1", input("onValue", on.value, "number", { step: "any" })),
      field("Label pilihan 2", input("offLabel", off.label)),
      field("Nilai pilihan 2", input("offValue", off.value, "number", { step: "any" })),
    );
  } else if (type === "slider") {
    grid.append(
      field("Minimum", input("min", c.min ?? 0, "number", { step: "any" })),
      field("Maksimum", input("max", c.max ?? 100, "number", { step: "any" })),
      field("Step", input("step", c.step ?? 1, "number", { step: "any", min: 0 })),
      field("Nilai awal", input("initial", c.type === "slider" ? c.value : 0, "number", { step: "any" })),
      field("Satuan", input("unit", c.unit || "", "text", { placeholder: "°, %, …" })),
    );
  }
  root.append(grid);
}

function openControlEditor(control, presetGroup) {
  const c = control || { type: "button", group: presetGroup || "Kontrol", label: "Tombol", variable: "", value: 1 };
  const groupNames = [...groupsOf(state.config.controls).keys()];
  openEditor(control ? `Ubah kontrol: ${c.label}` : "Tambah kontrol", (root) => {
    const grid = el("div", "form-grid");
    const typeSel = select("type", Object.entries(CONTROL_TYPES), c.type);
    const groupInput = input("group", c.group, "text", { list: "group-list", required: "" });
    const datalist = el("datalist");
    datalist.id = "group-list";
    groupNames.forEach((g) => { const o = el("option"); o.value = g; datalist.append(o); });
    const colorWrap = el("div", "inline");
    const useColor = input("useColor", undefined, "checkbox");
    useColor.checked = Boolean(c.color);
    useColor.setAttribute("aria-label", "Pakai warna khusus");
    colorWrap.append(useColor, input("color", c.color || "#3b8eea", "color"), el("span", "muted", "warna khusus"));
    grid.append(
      field("Tipe", typeSel),
      field("Grup (kartu)", groupInput),
      field("Label", input("label", c.label)),
      field("Variabel Ubidots", input("variable", c.variable, "text", { placeholder: "mis. lampu", spellcheck: "false", autocapitalize: "off" })),
      field("Keterangan (tooltip)", input("title", c.title || "")),
      field("Warna", colorWrap),
      datalist,
    );
    const specific = el("div");
    controlSpecificFields(c.type, c, specific);
    typeSel.addEventListener("change", () => controlSpecificFields(typeSel.value, c, specific));
    root.append(grid, el("div", "section-label", "Pengaturan tipe"), specific);
  }, (form) => {
    const type = form.elements.type.value;
    const base = {
      id: c.id,
      type,
      group: form.elements.group.value.trim() || "Kontrol",
      label: form.elements.label.value.trim() || "Kontrol",
      title: form.elements.title.value.trim(),
      variable: readVariable(form),
      color: form.elements.useColor.checked ? form.elements.color.value : "",
      style: c.style,
    };
    if (type === "button") Object.assign(base, { value: readNumber(form, "value", "Nilai"), pad: form.elements.pad.value });
    if (type === "hold") {
      Object.assign(base, {
        value: readNumber(form, "value", "Nilai saat ditahan"),
        release: readNumber(form, "release", "Nilai saat dilepas"),
        pad: form.elements.pad.value,
        key: form.elements.key.value,
      });
    }
    if (type === "toggle") {
      Object.assign(base, {
        on: { label: form.elements.onLabel.value.trim() || "ON", value: readNumber(form, "onValue", "Nilai pilihan 1") },
        off: { label: form.elements.offLabel.value.trim() || "OFF", value: readNumber(form, "offValue", "Nilai pilihan 2") },
      });
      base.value = c.type === "toggle" ? c.value : base.off.value;
    }
    if (type === "slider") {
      Object.assign(base, {
        min: readNumber(form, "min", "Minimum"),
        max: readNumber(form, "max", "Maksimum"),
        step: readNumber(form, "step", "Step"),
        value: readNumber(form, "initial", "Nilai awal"),
        unit: form.elements.unit.value.trim(),
      });
      if (base.min >= base.max) throw new Error("Minimum harus lebih kecil dari maksimum.");
      if (base.step <= 0) throw new Error("Step harus lebih dari 0.");
    }
    if (base.pad && state.config.controls.some((x) => x.id !== c.id && x.group === base.group && x.pad === base.pad)) {
      throw new Error(`Posisi D-pad "${base.pad}" di grup ${base.group} sudah dipakai.`);
    }
    upsert("controls", normalizeControl(base));
  });
}

function upsert(kind, item) {
  const list = state.config[kind];
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item;
  else list.push(item);
  saveConfig();
  renderAll();
}

function exportConfig() {
  const data = {
    app: "phantom-dashboard",
    version: 1,
    sensors: state.config.sensors.map(({ id, ...s }) => s),
    controls: state.config.controls.map(({ id, ...c }) => c),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = "phantom-dashboard-config.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importConfig(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.sensors) || !Array.isArray(data.controls)) throw new Error("format");
    const config = normalizeConfig({ sensors: data.sensors, controls: data.controls });
    const bad = [...config.sensors, ...config.controls].find((x) => !VARIABLE_RE.test(x.variable));
    if (bad) throw new Error(`variabel "${bad.variable}" tidak valid`);
    state.config = config;
    saveConfig();
    renderAll();
    toast(`Konfigurasi diimpor: ${config.sensors.length} sensor, ${config.controls.length} kontrol`);
  } catch (e) {
    toast(`Gagal import JSON (${e.message === "format" ? "butuh array sensors & controls" : e.message}).`, true);
  }
}

function resetConfig() {
  if (!confirm("Kembalikan semua kartu sensor & kontrol ke default? Perubahan Anda akan hilang.")) return;
  store.remove(KEY_CONFIG);
  state.config = normalizeConfig(null);
  renderAll();
  toast("Dashboard dikembalikan ke default");
}

/* ---------- Polling ---------- */

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.token || document.hidden || $("#app").hidden) return;
  if (state.holds.size) {
    schedulePoll(500);
    return;
  }
  if (state.polling) return;
  state.polling = true;
  try {
    const values = await readValues();
    state.lastValues = values;
    if (state.bannerKind) setBanner("");
    updateSensors(values);
    syncControls(values);
    updateChart(values);
    updateRobotStatus(values);
    $("#last-update").textContent = `diperbarui ${clock(Date.now())}`;
  } catch (e) {
    setBanner(errorText(e), e.kind);
    updateRobotStatus();
  } finally {
    state.polling = false;
  }
  if (state.token && !document.hidden) schedulePoll(state.settings.pollInterval * 1000);
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
  const info = $("#camera-info");
  if (!info) return;
  const url = cameraUrl();
  info.textContent = url ? `Stream: ${url}` : "IP kamera belum diisi. Atur di ⚙ Pengaturan.";
}

function openCamera() {
  if (state.editing) return;
  const url = cameraUrl();
  if (!url) {
    toast("Isi IP kamera dulu di Pengaturan.", true);
    openSettings("#set-camera");
    return;
  }
  window.open(url, "_blank", "noopener");
}

/* ---------- Tema, pengaturan & login ---------- */

function applyTheme(theme, mode) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.mode = mode;
  document.querySelector('meta[name="theme-color"]').content = mode === "light" ? "#e9eef4" : "#070b12";
  applyChartTheme();
}

function renderThemeSwatches() {
  const box = $("#theme-swatches");
  box.innerHTML = "";
  for (const t of THEMES) {
    const label = el("label", "seg swatch");
    const radio = input("theme", t.id, "radio");
    const span = el("span");
    const dot = el("i");
    dot.style.background = t.swatch;
    span.append(dot, document.createTextNode(t.label));
    label.append(radio, span);
    box.append(label);
  }
}

function saveSettings() {
  store.set(KEY_SETTINGS, state.settings);
}

function openSettings(focusSel) {
  const dlg = $("#settings");
  const form = $("#settings-form");
  $("#set-device").value = state.settings.device;
  $("#set-camera").value = state.settings.camera;
  $("#set-interval").value = state.settings.pollInterval;
  $("#set-token").value = state.token;
  $("#set-token").type = "password";
  form.elements.theme.value = state.settings.theme;
  form.elements.mode.value = state.settings.mode;
  dlg.returnValue = "";
  dlg.showModal();
  if (focusSel) $(focusSel).focus();
}

function applySettings() {
  const form = $("#settings-form");
  const device = $("#set-device").value.trim() || DEFAULT_SETTINGS.device;
  const interval = Math.min(120, Math.max(MIN_POLL_S, Number($("#set-interval").value) || DEFAULT_SETTINGS.pollInterval));
  const token = $("#set-token").value.trim();
  const deviceChanged = device !== state.settings.device;
  state.settings = {
    ...state.settings,
    device,
    camera: $("#set-camera").value.trim(),
    pollInterval: interval,
    theme: form.elements.theme.value || state.settings.theme,
    mode: form.elements.mode.value || state.settings.mode,
  };
  saveSettings();
  if (token && token !== state.token) {
    state.token = token;
    store.set(KEY_TOKEN, token);
  }
  if (deviceChanged) {
    state.readMode = "v2";
    state.firstSync = true;
    state.lastSeen = 0;
    state.lastValues = {};
    state.levels = {};
    initChart();
    updateSensors({}, true);
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
  setEditing(false);
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
  initChart();
  updateRobotStatus();
  poll();
}

async function handleLogin(e) {
  e.preventDefault();
  const token = $("#login-token").value.trim();
  const device = $("#login-device").value.trim() || DEFAULT_SETTINGS.device;
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

function holdForKey(e) {
  const key = e.key.toLowerCase();
  return state.config.controls.find((c) => c.type === "hold" && c.key.some((k) => k.toLowerCase() === key));
}

function typingOrDialog(e) {
  return $("#app").hidden || $("#settings").open || $("#editor").open || e.target.closest("input, textarea, select");
}

function bindEvents() {
  $("#login-form").addEventListener("submit", handleLogin);
  $("#estop").addEventListener("click", emergencyStop);
  $("#open-settings").addEventListener("click", () => openSettings());
  $("#logout").addEventListener("click", logout);
  $("#edit-toggle").addEventListener("click", () => setEditing(!state.editing));
  $("#edit-done").addEventListener("click", () => setEditing(false));
  $("#add-sensor").addEventListener("click", () => openSensorEditor(null));
  $("#add-control").addEventListener("click", () => openControlEditor(null));
  $("#export-config").addEventListener("click", exportConfig);
  $("#import-config").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importConfig(file);
    e.target.value = "";
  });
  $("#reset-config").addEventListener("click", resetConfig);
  makeSortable($("#sensor-grid"), ".sensor[data-id]", reorderSensors);
  makeSortable($("#control-groups"), ".group[data-group]", reorderGroups);

  const settingsForm = $("#settings-form");
  settingsForm.addEventListener("change", (e) => {
    if (e.target.name === "theme" || e.target.name === "mode") {
      applyTheme(settingsForm.elements.theme.value, settingsForm.elements.mode.value);
    }
  });
  $("#settings").addEventListener("close", () => {
    if ($("#settings").returnValue === "save") applySettings();
    else applyTheme(state.settings.theme, state.settings.mode);
  });

  $("#editor-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "save" || !editorApply) return;
    try {
      editorApply(e.target);
      toast("Tersimpan");
    } catch (err) {
      e.preventDefault();
      const box = $("#editor-error");
      box.textContent = err.message;
      box.hidden = false;
    }
  });

  document.querySelectorAll("[data-reveal]").forEach((b) => {
    b.addEventListener("click", () => {
      const field = document.getElementById(b.dataset.reveal);
      const show = field.type === "password";
      field.type = show ? "text" : "password";
      b.textContent = show ? "Sembunyi" : "Lihat";
    });
  });

  document.addEventListener("keydown", (e) => {
    if (typingOrDialog(e)) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) emergencyStop();
      return;
    }
    if (state.editing) return;
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
  window.addEventListener("offline", () => setBanner(errorText({ kind: "offline" }), "offline"));
}

function init() {
  saveSettings();
  applyTheme(state.settings.theme, state.settings.mode);
  renderThemeSwatches();
  renderSensors();
  renderControls();
  bindEvents();
  tick();
  setInterval(tick, 1000);
  if (state.token) showApp();
  else showLogin();
}

init();
