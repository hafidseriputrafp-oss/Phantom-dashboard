/*
 * Kode bersama Beranda (/) dan builder (/dash/): token, tema, API Ubidots dengan antrean
 * request (STEM = 1 request/detik), dan sinkron konfigurasi dashboard ke Ubidots.
 */
const API_BASE = "https://industrial.api.ubidots.com/api";
const KEY_TOKEN = "phantom.token";
const KEY_SETTINGS = "phantom.settings";
const KEY_HUB = "phantom.hub";
const CONFIG_DEVICE = "dashboard-config";
const REQUEST_GAP_MS = 1100;
const REQUEST_TIMEOUT_MS = 10000;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const CHUNK_CHARS = 600;
const MAX_PARTS = 12;
const PRIORITY = { history: 0, poll: 1, sync: 2, control: 3, urgent: 9 };
const LABEL_RE = /^[a-z0-9_-]+$/;
const ID_RE = /^[a-z0-9-]+$/;
const TZ = "Asia/Jakarta";
const THEMES = [
  { id: "garuda", label: "Biru Garuda", swatch: "#3b8eea" },
  { id: "rescue", label: "Merah Rescue", swatch: "#ff5a36" },
  { id: "military", label: "Hijau Militer", swatch: "#8fb04f" },
  { id: "neon", label: "Ungu Neon", swatch: "#a970ff" },
];

const DEFAULT_CODE_MAP = {
  rules: [
    { value: 200, level: "ok", text: "OK" },
    { value: -1, level: "danger", text: "Tidak ada jaringan" },
    { value: 401, level: "danger", text: "Token salah" },
    { value: 429, level: "warn", text: "Terlalu sering" },
  ],
  other: { level: "danger", text: "Error" },
};

const LOGGER_WIDGETS = [
  { id: "w-status", type: "status", title: "Status logger", size: "S", device: "logger", variable: "", onlineS: 30 },
  { id: "w-suhu", type: "number", title: "Suhu ambient", size: "S", device: "logger", variable: "suhu_ambient", unit: "°C", decimals: 1, icon: "🌡️", color: "#3987e5", contextKey: "waktu" },
  { id: "w-data", type: "number", title: "Data ke-", size: "S", device: "logger", variable: "data_ke", unit: "", decimals: 0, icon: "🔢", color: "#9085e9" },
  { id: "w-http", type: "code", title: "HTTP code", size: "S", device: "logger", variable: "http_code", map: DEFAULT_CODE_MAP },
  { id: "w-chart", type: "chart", title: "Grafik suhu ambient", size: "L", device: "logger", series: [{ variable: "suhu_ambient", color: "#d95926" }], points: 50 },
  { id: "w-table", type: "table", title: "Riwayat suhu ambient", size: "L", device: "logger", variable: "suhu_ambient", rows: 20, contextKey: "waktu" },
];

const BUILTIN_DASHBOARDS = [
  { id: "robot", builtin: true, kind: "link", url: "robot/", name: "Robot Phantom", icon: "🤖", device: "phantom", onlineS: 15, order: 1 },
  { id: "logger", builtin: true, kind: "builder", name: "Data Logger", icon: "📈", device: "logger", onlineS: 30, refreshS: 5, historyS: 30, order: 2, widgets: LOGGER_WIDGETS },
];

/* ---------- Utilitas ---------- */

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

const $ = (sel, root = document) => root.querySelector(sel);
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const b = el("button", className, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

const wibFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fmtWib = (ts) => (ts ? wibFmt.format(new Date(ts)) : "—");
const fmtWibTime = (ts) => (ts ? fmtWib(ts).slice(11) : "—");

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} dtk lalu`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
}

function toTs(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const p = Date.parse(v);
  return Number.isNaN(p) ? 0 : p;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2200);
}

let bannerKind = "";
function setBanner(message, kind = "") {
  const b = $("#banner");
  if (!b) return;
  bannerKind = message ? kind : "";
  b.hidden = !message;
  b.textContent = message || "";
  b.classList.toggle("warn", kind === "notfound" || kind === "ratelimit");
}

function tickBanner() {
  if (bannerKind !== "ratelimit") return;
  $("#banner").textContent = limiter.backoffUntil > Date.now() ? rateLimitText() : "Batas request Ubidots tercapai (HTTP 429). Mencoba lagi…";
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Token & tema (dipakai bersama dashboard robot) ---------- */

const getToken = () => store.get(KEY_TOKEN, "");
const setToken = (t) => store.set(KEY_TOKEN, t);
const clearToken = () => store.remove(KEY_TOKEN);

function loadLook() {
  const s = store.get(KEY_SETTINGS, {});
  return {
    theme: THEMES.some((t) => t.id === s.theme) ? s.theme : "garuda",
    mode: s.mode === "light" ? "light" : "dark",
  };
}

function saveLook(theme, mode) {
  store.set(KEY_SETTINGS, { ...store.get(KEY_SETTINGS, {}), theme, mode });
}

function applyLook(theme, mode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = mode === "light" ? "#e9eef4" : "#070b12";
}

function robotDevice() {
  return store.get(KEY_SETTINGS, {}).device || "phantom";
}

function renderLookControls(swatchBox, form) {
  swatchBox.innerHTML = "";
  for (const t of THEMES) {
    const label = el("label", "seg swatch");
    const radio = el("input");
    radio.type = "radio";
    radio.name = "theme";
    radio.value = t.id;
    const span = el("span");
    const dot = el("i");
    dot.style.background = t.swatch;
    span.append(dot, document.createTextNode(t.label));
    label.append(radio, span);
    swatchBox.append(label);
  }
  const look = loadLook();
  form.elements.theme.value = look.theme;
  form.elements.mode.value = look.mode;
  form.addEventListener("change", (e) => {
    if (e.target.name === "theme" || e.target.name === "mode") applyLook(form.elements.theme.value, form.elements.mode.value);
  });
}

/* ---------- API Ubidots + antrean ---------- */

class ApiError extends Error {
  constructor(kind, status, device) {
    super(kind);
    this.kind = kind;
    this.status = status;
    this.device = device;
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
  return `Batas request Ubidots tercapai (HTTP 429 — akun STEM maks. 1 request/detik). Jeda otomatis, mencoba lagi dalam ${s} dtk. Perbesar interval refresh bila sering terjadi.`;
}

function errorText(e) {
  switch (e && e.kind) {
    case "auth": return "Token Ubidots ditolak. Periksa token di Pengaturan.";
    case "notfound": return `Device "${e.device || "?"}" belum ada di Ubidots.`;
    case "ratelimit": return rateLimitText();
    case "offline": return "Perangkat ini sedang offline. Periksa koneksi internet.";
    case "timeout": return "Ubidots tidak merespons (timeout).";
    case "network": return "Tidak dapat menghubungi Ubidots. Periksa koneksi internet.";
    case "server": return `Server Ubidots bermasalah (HTTP ${e.status}).`;
    case "bad": return `Permintaan ditolak Ubidots (HTTP ${e.status}).`;
    case "toolarge": return "Konfigurasi terlalu besar untuk cloud (maks. ±7 KB setelah kompresi). Kurangi widget atau teks catatan.";
    case "corrupt": return "Konfigurasi di cloud tidak lengkap/rusak. Simpan ulang dari perangkat yang benar.";
    case "nodecompress": return "Browser ini tidak mendukung dekompresi. Perbarui browser.";
    case "notoken": return "Belum login Ubidots.";
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
    this.backoffUntil = Date.now() + Math.max(this.backoffMs, (retryAfterS || 0) * 1000);
  },
  ok() {
    this.backoffMs = 0;
  },
};

async function api(method, path, body, token = getToken()) {
  if (!token) throw new ApiError("notoken");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const headers = { "X-Auth-Token": token };
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
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

function toDot(raw) {
  return {
    value: raw.value === null || raw.value === undefined ? NaN : Number(raw.value),
    ts: toTs(raw.timestamp),
    created: toTs(raw.created_at),
    context: raw.context && typeof raw.context === "object" ? raw.context : null,
  };
}

async function readDevice(device, priority = PRIORITY.poll, token) {
  const path = `/v2.0/devices/~${encodeURIComponent(device)}/variables/?page_size=200`;
  try {
    const data = await limiter.run(() => api("GET", path, null, token), priority);
    const out = {};
    for (const v of (data && data.results) || []) {
      const lv = v.lastValue;
      if (!lv || lv.value === undefined || lv.value === null) continue;
      out[v.label] = { ...toDot(lv), hasContext: "context" in lv };
    }
    return out;
  } catch (e) {
    e.device = device;
    throw e;
  }
}

async function readHistory(device, variable, n, priority = PRIORITY.history) {
  const path = `/v1.6/devices/${encodeURIComponent(device)}/${encodeURIComponent(variable)}/values/?page_size=${n}`;
  try {
    const data = await limiter.run(() => api("GET", path), priority);
    return ((data && data.results) || []).map(toDot);
  } catch (e) {
    e.device = device;
    throw e;
  }
}

function postValues(device, values, priority = PRIORITY.control) {
  return limiter.run(() => api("POST", `/v1.6/devices/${encodeURIComponent(device)}/`, values), priority);
}

/* ---------- Konfigurasi dashboard: lokal + cloud ---------- */

const hub = {
  data: store.get(KEY_HUB, null) || { dashboards: {} },
  status: "local",
  error: null,
  savedAt: 0,
  listeners: new Set(),
  pushing: {},
};

function hubSave() {
  store.set(KEY_HUB, hub.data);
}

function entry(id) {
  return hub.data.dashboards[id];
}

function setCloud(status, error = null) {
  hub.status = status;
  hub.error = error;
  if (status === "saved") hub.savedAt = Date.now();
  hub.listeners.forEach((fn) => fn(hub));
}

function cloudText() {
  switch (hub.status) {
    case "syncing": return { cls: "late", text: "☁ Menyinkronkan…" };
    case "saving": return { cls: "late", text: "☁ Menyimpan…" };
    case "pending": return { cls: "late", text: "✎ Belum disimpan ke cloud" };
    case "saved": return { cls: "online", text: `☁ Tersimpan ke cloud ${fmtWibTime(hub.savedAt)}` };
    case "error": return { cls: "offline", text: `⚠ Cloud: ${errorText(hub.error)}` };
    default: return { cls: "", text: getToken() ? "💾 Tersimpan lokal" : "💾 Lokal (belum login)" };
  }
}

function bindCloudPill(node) {
  const render = () => {
    const { cls, text } = cloudText();
    node.classList.remove("online", "late", "offline");
    if (cls) node.classList.add(cls);
    node.querySelector(".cloud-text").textContent = text;
    node.title = text;
  };
  hub.listeners.add(render);
  render();
}

function ensureBuiltins() {
  for (const b of BUILTIN_DASHBOARDS) {
    if (!entry(b.id)) hub.data.dashboards[b.id] = { cfg: clone(b), version: 0, cloud: 0, dirty: false };
  }
  hubSave();
}

function listDashboards() {
  return Object.values(hub.data.dashboards)
    .map((e) => e.cfg)
    .filter((c) => c && !c.deleted)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)));
}

function getDashboard(id) {
  const e = entry(id);
  return e && !e.cfg.deleted ? e.cfg : null;
}

function missingBuiltins() {
  return BUILTIN_DASHBOARDS.filter((b) => !getDashboard(b.id));
}

function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipeBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function packConfig(cfg) {
  const raw = new TextEncoder().encode(JSON.stringify(cfg));
  let f = "u";
  let bytes = raw;
  try {
    bytes = await pipeBytes(raw, new CompressionStream("deflate-raw"));
    f = "z";
  } catch {
    bytes = raw;
  }
  const b64 = toB64(bytes);
  const parts = [];
  for (let i = 0; i < b64.length; i += CHUNK_CHARS) parts.push(b64.slice(i, i + CHUNK_CHARS));
  if (parts.length > MAX_PARTS) throw new ApiError("toolarge");
  return { f, parts };
}

async function unpackConfig(dots) {
  const latest = dots[0] && dots[0].context;
  if (!latest || !latest.w) throw new ApiError("corrupt");
  const n = Number(latest.n);
  const parts = [];
  for (const d of dots) {
    const c = d.context;
    if (c && c.w === latest.w) parts[Number(c.p)] = c.d;
  }
  if (!n || parts.filter((p) => typeof p === "string").length !== n) throw new ApiError("corrupt");
  let bytes = fromB64(parts.join(""));
  if (latest.f === "z") {
    if (!window.DecompressionStream) throw new ApiError("nodecompress");
    bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
  }
  return { cfg: JSON.parse(new TextDecoder().decode(bytes)), version: Number(latest.v) || Number(dots[0].value) || 0 };
}

async function pullDashboard(id) {
  const dots = await readHistory(CONFIG_DEVICE, `cfg_${id}`, MAX_PARTS, PRIORITY.sync);
  const { cfg, version } = await unpackConfig(dots);
  cfg.id = id;
  hub.data.dashboards[id] = { cfg, version, cloud: version, dirty: false };
  hubSave();
  return cfg;
}

function pushDashboard(id) {
  const prev = hub.pushing[id] || Promise.resolve();
  const next = prev.catch(() => {}).then(() => doPush(id));
  hub.pushing[id] = next;
  return next;
}

async function doPush(id) {
  const e = entry(id);
  if (!e) return false;
  if (!getToken()) {
    setCloud("local");
    return false;
  }
  setCloud("saving");
  try {
    const version = Math.max(e.version, e.cloud + 1);
    const { f, parts } = await packConfig(e.cfg);
    const w = uid();
    const now = Date.now();
    const dots = parts.map((d, i) => ({
      value: version,
      timestamp: now - (parts.length - 1 - i),
      context: { f, v: version, w, p: i, n: parts.length, d },
    }));
    await postValues(CONFIG_DEVICE, { [`cfg_${id}`]: dots }, PRIORITY.sync);
    e.version = version;
    e.cloud = version;
    e.dirty = false;
    hubSave();
    setCloud("saved");
    return true;
  } catch (err) {
    setCloud("error", err);
    return false;
  }
}

function saveDashboard(cfg, push = true) {
  const e = entry(cfg.id) || { version: 0, cloud: 0 };
  e.cfg = cfg;
  if (!e.dirty) e.version = Math.max(e.version, e.cloud) + 1;
  e.dirty = true;
  hub.data.dashboards[cfg.id] = e;
  hubSave();
  if (push) return pushDashboard(cfg.id);
  setCloud("pending");
  return Promise.resolve(false);
}

async function syncCloud(onlyId) {
  if (!getToken()) {
    setCloud("local");
    return { changed: false };
  }
  setCloud("syncing");
  const cloud = {};
  try {
    const vars = await readDevice(CONFIG_DEVICE, PRIORITY.sync);
    for (const [label, dot] of Object.entries(vars)) {
      if (label.startsWith("cfg_")) cloud[label.slice(4)] = dot.value || 0;
    }
  } catch (e) {
    if (e.kind !== "notfound") {
      setCloud("error", e);
      return { changed: false, error: e };
    }
  }
  const ids = onlyId ? [onlyId] : [...new Set([...Object.keys(cloud), ...Object.keys(hub.data.dashboards)])];
  let changed = false;
  let conflicts = 0;
  let failed = null;
  for (const id of ids) {
    if (!ID_RE.test(id)) continue;
    const cv = cloud[id] || 0;
    const e = entry(id);
    try {
      if (cv && (!e || cv > e.cloud)) {
        if (e && e.dirty) conflicts++;
        await pullDashboard(id);
        changed = true;
      } else if (e && (e.dirty || !cv)) {
        if (!(await pushDashboard(id))) failed = hub.error;
      }
    } catch (err) {
      failed = err;
    }
  }
  if (failed) setCloud("error", failed);
  else setCloud("saved");
  if (conflicts) toast("Ada perubahan lebih baru dari perangkat lain; versi cloud dipakai.", true);
  return { changed };
}

function uniqueId(name) {
  const base = String(name || "dash").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "dash";
  let id = base;
  while (entry(id)) id = `${base}-${uid().slice(0, 4)}`;
  return id;
}

function cameraUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `http://${s}${/[:/]/.test(s) ? "" : ":81/stream"}`;
}

function safeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

/* ---------- Login bersama ---------- */

async function verifyToken(token) {
  try {
    await readDevice(CONFIG_DEVICE, PRIORITY.sync, token);
  } catch (e) {
    if (e.kind === "auth") throw e;
  }
}

function bindLogin(onDone) {
  const form = $("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#login-token").value.trim();
    const err = $("#login-error");
    const submit = $("#login-submit");
    err.hidden = true;
    submit.disabled = true;
    submit.textContent = "Memeriksa token…";
    try {
      await verifyToken(token);
      setToken(token);
      onDone();
    } catch (ex) {
      err.textContent = errorText(ex);
      err.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Masuk";
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
}

function startClock() {
  const dayFmt = new Intl.DateTimeFormat("id-ID", { timeZone: TZ, weekday: "short" });
  const tick = () => {
    const now = Date.now();
    const t = $("#clock-time");
    if (t) t.textContent = fmtWibTime(now);
    const d = $("#clock-date");
    if (d) {
      const [y, m, day] = fmtWib(now).slice(0, 10).split("-");
      d.textContent = `${dayFmt.format(now)}, ${day}-${m}-${y} WIB`;
    }
    tickBanner();
  };
  tick();
  setInterval(tick, 1000);
}
