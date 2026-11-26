/*
 * Phantom Kontrol — dashboard robot GARUDA, satu layar landscape untuk HP.
 *
 * Variabel Ubidots (device "phantom"):
 *   kirim dari dashboard : gerak (0 stop, 1 maju, 2 mundur, 3 putar kiri, 4 putar kanan,
 *                          5 maju-kiri, 6 maju-kanan, 7 mundur-kiri, 8 mundur-kanan), speed, lengan, capit,
 *                          batas_suhu, kirim_hotspot (1 = minta robot kirim hotspot ke web dosen)
 *   dibaca dari robot    : suhu_objek, hotspot (1 = hotspot sudah diterima web dosen),
 *                          fb_code (HTTP kiriman terakhir ke web dosen), fb_jenis (1 data, 2 hotspot), fb_suhu
 */

const API_BASE = "https://industrial.api.ubidots.com/api";
const KEY_TOKEN = "phantom.token";
const KEY_SETTINGS = "phantom.settings";
const KEY_PORTRAIT = "phantom.portraitOk";
const KEY_FULL_HINT = "phantom.fullHint";

const THEMES = [
  { id: "garuda", label: "Biru Garuda", swatch: "#3b8eea" },
  { id: "rescue", label: "Merah Rescue", swatch: "#ff5a36" },
  { id: "military", label: "Hijau Militer", swatch: "#8fb04f" },
  { id: "neon", label: "Ungu Neon", swatch: "#a970ff" },
];

const DEFAULT_SETTINGS = {
  v: 5,
  device: "phantom",
  pollInterval: 3,
  theme: "garuda",
  mode: "dark",
  batas: 50,
  mqtt: true,
  lengan: { turun: 120, bawa: 60, parkir: 0, min: 0, max: 120 },
  capit: { buka: 25, tutup: 110, min: 25, max: 110 },
};

const ROBOT_VARS = ["suhu_objek", "fb_code", "hotspot"];
const REQUEST_GAP_MS = 1100;
const REQUEST_TIMEOUT_MS = 8000;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const HOLD_HEARTBEAT_MS = 1500;
const RELEASE_SETTLE_MS = 120;
const TAP_MIN_MS = 250;
const STOP_PARALLEL_MS = 600;
const STOP_CONFIRM_MS = 1000;
const POLL_RESUME_MS = 1500;
const MQTT_LIB = "https://cdn.jsdelivr.net/npm/mqtt@5.16.1/dist/mqtt.min.js";
const MQTT_LIB_SRI = "sha384-ilRYg/zm2XqUafLvBoGVk40UfNRnvUkYMy+e/JPo4YgsFR6X9Q3jYEkqFQXquX4r";
const MQTT_URLS = ["wss://industrial.api.ubidots.com:8084/mqtt", "wss://industrial.api.ubidots.com:8084"];
const MQTT_CONNECT_MS = 5000;
const MQTT_ACK_MS = 1500;
const SLIDER_THROTTLE_MS = 700;
const ROBOT_ONLINE_MS = 15000;
const ROBOT_LATE_MS = 60000;
const STALE_MS = 20000;
const CHART_POINTS = 60;
const WARM_MARGIN = 10;
const PRIORITY = { poll: 1, control: 2 };
const RETRYABLE = new Set(["ratelimit", "timeout", "network", "server"]);
const DIR_NAMES = { 1: "MAJU", 2: "MUNDUR", 3: "PUTAR KIRI", 4: "PUTAR KANAN", 5: "MAJU-KIRI", 6: "MAJU-KANAN", 7: "MUNDUR-KIRI", 8: "MUNDUR-KANAN" };
const KEY_DIRS = { arrowup: 1, w: 1, arrowdown: 2, s: 2, arrowleft: 3, a: 3, arrowright: 4, d: 4 };

/* ---------- Penyimpanan ---------- */

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

function num(v, fallback) {
  const n = Number(v);
  if (v === "" || v === null || v === undefined || Number.isNaN(n)) return fallback;
  return n;
}

const SERVO_LIMITS = { lengan: { min: 0, max: 120 }, capit: { min: 25, max: 110 } };
const OLD_SERVO_DEFAULTS = {
  lengan: [{ turun: 25, bawa: 60, parkir: 135, min: 25, max: 135 }],
  capit: [{ buka: 118, tutup: 90, min: 40, max: 150 }, { buka: 20, tutup: 110, min: 20, max: 110 }],
};

function migrateServo(servo, saved, oldVersion) {
  const lim = SERVO_LIMITS[servo];
  const out = { ...DEFAULT_SETTINGS[servo], ...(saved || {}) };
  for (const key of Object.keys(DEFAULT_SETTINGS[servo])) {
    const v = Number(out[key]);
    const wasDefault = oldVersion < 5 && OLD_SERVO_DEFAULTS[servo].some((d) => d[key] === v);
    if (!Number.isFinite(v) || v < lim.min || v > lim.max || wasDefault) out[key] = DEFAULT_SETTINGS[servo][key];
    else out[key] = v;
  }
  return out;
}

function loadSettings() {
  const saved = store.get(KEY_SETTINGS, {}) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  const oldVersion = Number(saved.v) || 0;
  s.lengan = migrateServo("lengan", saved.lengan, oldVersion);
  s.capit = migrateServo("capit", saved.capit, oldVersion);
  s.batas = num(saved.batas, DEFAULT_SETTINGS.batas);
  s.pollInterval = Math.max(1, num(s.pollInterval, DEFAULT_SETTINGS.pollInterval));
  if (!THEMES.some((t) => t.id === s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  if (s.mode !== "light") s.mode = "dark";
  s.mqtt = saved.mqtt !== false;
  s.v = DEFAULT_SETTINGS.v;
  return s;
}

const state = {
  token: store.get(KEY_TOKEN, ""),
  settings: loadSettings(),
  values: {},
  lastSeen: 0,
  firstSync: true,
  pollTimer: null,
  polling: false,
  readMode: "v2",
  drive: { dir: 0 },
  net: { ms: null, path: "" },
  inputs: new Map(),
  releaseTimer: null,
  sendQ: {},
  chart: null,
  lastChartTs: 0,
  bannerKind: "",
  sliderTimers: {},
};

/* ---------- Utilitas ---------- */

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function clock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

let toastTimer = null;
function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 4500 : 2200);
}

function setBanner(message, kind = "") {
  const b = $("#banner");
  state.bannerKind = message ? kind : "";
  b.hidden = !message;
  b.textContent = message || "";
  b.title = message || "";
  b.classList.toggle("warn", kind === "notfound" || kind === "ratelimit");
}

/* ---------- API Ubidots + pembatas 1 request/detik ---------- */

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
    case "notfound": return `Device "${state.settings.device}" belum ada di Ubidots. Nyalakan robot dulu.`;
    case "ratelimit": return "Batas request Ubidots tercapai (HTTP 429). Jeda otomatis…";
    case "offline": return "HP sedang offline. Periksa internet.";
    case "timeout": return "Ubidots tidak merespons (timeout).";
    case "network": return "Tidak bisa menghubungi Ubidots. Periksa internet.";
    case "server": return `Server Ubidots bermasalah (HTTP ${e.status}).`;
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

async function api(method, path, body, token = state.token) {
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

const deviceLabel = () => encodeURIComponent(state.settings.device);

function postValues(values) {
  return api("POST", `/v1.6/devices/${deviceLabel()}/`, values);
}

/* ---------- Jalur cepat: MQTT over WebSocket langsung ke broker Ubidots ---------- */

const fast = { client: null, ready: false, lib: null, urlIdx: 0, fails: 0, qos: 1, acked: false, ackMiss: 0, timer: null };

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = "anonymous";
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

function fastWanted() {
  return Boolean(state.token && state.settings.mqtt && !$("#app").hidden && !document.hidden);
}

function fastStop() {
  clearTimeout(fast.timer);
  const c = fast.client;
  fast.client = null;
  fast.ready = false;
  if (c) {
    try { c.end(true); } catch {}
  }
  showNet();
}

function fastRetry() {
  clearTimeout(fast.timer);
  if (!fastWanted()) return;
  fast.timer = setTimeout(fastStart, fast.fails < 4 ? 3000 : 30000);
}

async function fastStart() {
  fastStop();
  if (!fastWanted()) return;
  try {
    if (!window.mqtt) await (fast.lib || (fast.lib = loadScript(MQTT_LIB, MQTT_LIB_SRI)));
  } catch {
    fast.lib = null;
    fast.fails++;
    fastRetry();
    return;
  }
  if (fast.client || !fastWanted()) return;
  const url = MQTT_URLS[fast.urlIdx % MQTT_URLS.length];
  let client;
  try {
    client = window.mqtt.connect(url, {
      username: state.token,
      password: "",
      clientId: `phantom-web-${Math.random().toString(16).slice(2, 10)}`,
      keepalive: 10,
      reconnectPeriod: 0,
      connectTimeout: MQTT_CONNECT_MS,
      clean: true,
    });
  } catch {
    fast.urlIdx++;
    fast.fails++;
    fastRetry();
    return;
  }
  const down = () => {
    if (fast.client !== client) return;
    if (!fast.ready) fast.urlIdx++;
    fast.fails++;
    fastStop();
    fastRetry();
  };
  fast.client = client;
  fast.timer = setTimeout(down, MQTT_CONNECT_MS + 500);
  client.on("connect", () => {
    if (fast.client !== client) return;
    clearTimeout(fast.timer);
    fast.ready = true;
    fast.fails = 0;
    const dev = state.settings.device;
    try {
      client.subscribe(Object.values(ACK_VARS).map((v) => `/v1.6/devices/${dev}/${v}/lv`), { qos: 0 }, () => {});
    } catch {}
    showNet();
  });
  client.on("message", (topic, payload) => {
    if (fast.client !== client) return;
    const label = String(topic).split("/")[4];
    const variable = Object.keys(ACK_VARS).find((k) => ACK_VARS[k] === label);
    const text = String(payload);
    let value = Number(text);
    if (Number.isNaN(value)) {
      try { value = Number(JSON.parse(text).value); } catch {}
    }
    if (variable && Number.isFinite(value)) onAck(variable, Math.round(value));
  });
  client.on("error", down);
  client.on("close", down);
  client.on("offline", down);
  showNet();
}

function fastPublish(values) {
  return new Promise((resolve, reject) => {
    const c = fast.client;
    if (!fast.ready || !c) {
      reject(new ApiError("network"));
      return;
    }
    const qos = fast.qos;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      fast.ackMiss++;
      if (!fast.acked && fast.ackMiss >= 2) fast.qos = 0;
      if (fast.client === c) {
        fast.fails++;
        fastStop();
        fastRetry();
      }
      reject(new ApiError("timeout"));
    }, MQTT_ACK_MS);
    c.publish(`/v1.6/devices/${state.settings.device}`, JSON.stringify(values), { qos }, (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        reject(new ApiError("network"));
        return;
      }
      if (qos) {
        fast.acked = true;
        fast.ackMiss = 0;
      }
      resolve(qos);
    });
  });
}

async function transmit(values) {
  if (fast.ready) {
    try {
      const qos = await fastPublish(values);
      return { via: "mqtt", qos };
    } catch {}
  }
  await postValues(values);
  return { via: "rest" };
}

function showNet() {
  const box = $("#net");
  if (!box) return;
  let path = "REST";
  if (fast.ready) path = "MQTT";
  else if (fast.client) path = "MQTT…";
  const ms = state.net.path === path ? state.net.ms : null;
  $("#net-text").textContent = ms === null ? path : `${path} ${ms} ms`;
  box.classList.toggle("fast", fast.ready);
  box.classList.toggle("slow", ms !== null && ms > 800);
  box.title = fast.ready
    ? "Perintah dikirim lewat MQTT WebSocket langsung ke broker Ubidots"
    : "Perintah dikirim lewat REST API Ubidots";
}

const READ_VARS = ["suhu_objek", "hotspot", "fb_code", "fb_jenis", "fb_suhu", "speed", "lengan", "capit"];

async function readValues(token) {
  if (state.readMode === "v2") {
    try {
      const path = `/v2.0/devices/~${deviceLabel()}/variables/?page_size=200`;
      const data = await limiter.run(() => api("GET", path, null, token), PRIORITY.poll);
      if (data && Array.isArray(data.results)) {
        const out = {};
        for (const v of data.results) {
          const lv = v.lastValue;
          if (lv && lv.value !== undefined && lv.value !== null) out[v.label] = { value: Number(lv.value), ts: Number(lv.timestamp) || 0 };
        }
        return out;
      }
    } catch (e) {
      if (e.kind !== "bad") throw e;
    }
    state.readMode = "v1.6";
  }
  const out = {};
  let found = 0;
  for (const label of READ_VARS) {
    const path = `/v1.6/devices/${deviceLabel()}/${label}/values/?page_size=1`;
    const r = await limiter.run(() => api("GET", path, null, token), PRIORITY.poll)
      .catch((e) => (e.kind === "notfound" ? null : Promise.reject(e)));
    const dot = r && r.results && r.results[0];
    if (dot) {
      out[label] = { value: Number(dot.value), ts: Number(dot.timestamp) || 0 };
      found++;
    }
  }
  if (!found) throw new ApiError("notfound", 404);
  return out;
}

async function loadHistory() {
  if (!state.chart) return;
  try {
    const path = `/v1.6/devices/${deviceLabel()}/suhu_objek/values/?page_size=${CHART_POINTS}`;
    const data = await limiter.run(() => api("GET", path), PRIORITY.poll);
    const dots = (data && data.results ? data.results : []).slice().reverse();
    if (!dots.length) return;
    const { labels, datasets } = state.chart.data;
    labels.length = 0;
    datasets[0].data.length = 0;
    datasets[1].data.length = 0;
    for (const d of dots) {
      labels.push(clock(d.timestamp));
      datasets[0].data.push(Number(d.value));
      datasets[1].data.push(state.settings.batas);
    }
    state.lastChartTs = Math.max(state.lastChartTs, dots[dots.length - 1].timestamp);
    state.chart.update("none");
  } catch {}
}

/* ---------- Kirim perintah (digabung per variabel, urut prioritas) ---------- */

function markPending(variable, busy) {
  document.querySelectorAll(`[data-var="${variable}"]`).forEach((n) => n.classList.toggle("pending", busy));
}

function send(variable, value, priority = PRIORITY.control) {
  if (ACK_VARS[variable] && variable !== "gerak") ackBegin("servo", variable, value);
  const q = state.sendQ[variable] || (state.sendQ[variable] = { busy: false, has: false, value: null, priority });
  q.value = value;
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
    const job = () => {
      sent = q.value;
      q.has = false;
      return transmit({ [variable]: sent });
    };
    try {
      const r = await (fast.ready ? job() : limiter.run(job, q.priority));
      if (ACK_VARS[variable]) ackServer("servo", variable, sent, r);
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

/* ---------- Kanal gerak: langsung kirim, berurutan, ketukan tidak hilang ---------- */

const gerak = { queue: [], sent: 0, busy: false, sentAt: 0, dirAt: 0, confirmTimer: null, parallelTimer: null };

async function deliverGerak(v) {
  const t0 = performance.now();
  if (fast.ready) {
    try {
      const qos = await fastPublish({ gerak: v });
      state.net = { path: "MQTT", ms: qos ? Math.round(performance.now() - t0) : null };
      showNet();
      return { via: "mqtt", qos };
    } catch {}
  }
  limiter.last = Date.now();
  await postValues({ gerak: v });
  state.net = { path: "REST", ms: Math.round(performance.now() - t0) };
  showNet();
  return { via: "rest" };
}

function queueGerak(v) {
  const q = gerak.queue;
  const n = q.length;
  const tail = n ? q[n - 1] : gerak.sent;
  const before = n > 1 ? q[n - 2] : gerak.sent;
  if (n && tail && v) q[n - 1] = v;
  else if (n && !tail && v === before) q.pop();
  else if (v !== tail) q.push(v);
  const m = q.length;
  if (m && q[m - 1] === (m > 1 ? q[m - 2] : gerak.sent)) q.pop();
  while (q.length > 3) q.shift();
  pumpGerak();
}

async function pumpGerak() {
  if (gerak.busy) return;
  gerak.busy = true;
  while (gerak.queue.length) {
    const v = gerak.queue[0];
    if (!v) {
      const wait = gerak.dirAt + TAP_MIN_MS - Date.now();
      if (wait > 0) {
        await sleep(wait);
        continue;
      }
    }
    gerak.queue.shift();
    gerak.sent = v;
    gerak.sentAt = Date.now();
    if (v) gerak.dirAt = gerak.sentAt;
    markPending("gerak", true);
    for (let tries = 1; ; tries++) {
      try {
        const r = await deliverGerak(v);
        ackServer("gerak", "gerak", v, r);
        if (state.bannerKind === "ratelimit") setBanner("");
        break;
      } catch (e) {
        const newer = gerak.queue.length > 0;
        if (e.kind === "auth" || newer || tries >= (v ? 2 : 5)) {
          if (!newer) toast(v ? `Gagal kirim gerak. ${errorText(e)}` : `STOP gagal terkirim! ${errorText(e)}`, true);
          break;
        }
        if (e.kind === "ratelimit") setBanner(errorText(e), "ratelimit");
        await sleep(400);
      }
    }
  }
  gerak.busy = false;
  markPending("gerak", false);
}

function gerakHeartbeat() {
  const dir = state.drive.dir;
  if (!dir || gerak.busy || gerak.queue.length) return;
  if (Date.now() - gerak.sentAt < HOLD_HEARTBEAT_MS) return;
  gerak.queue.push(dir);
  pumpGerak();
}

function clearStopGuards() {
  clearTimeout(gerak.parallelTimer);
  clearTimeout(gerak.confirmTimer);
}

function confirmStop() {
  if (state.drive.dir) return;
  if (gerak.busy || gerak.queue.length) {
    gerak.confirmTimer = setTimeout(confirmStop, 300);
    return;
  }
  gerak.queue.push(0);
  pumpGerak();
}

function parallelStop() {
  gerak.queue.length = 0;
  gerak.queue.push(0);
  deliverGerak(0).catch(() => {});
}

/* ---------- Status perintah: dikirim → sampai server → terlaksana robot ---------- */

const ACK_TIMEOUT_MS = 3000;
const ACK_VARS = { gerak: "ack_gerak", lengan: "ack_lengan", capit: "ack_capit" };
const ACK_NAMES = { 0: "STOP", 1: "MAJU", 2: "MUNDUR", 3: "KIRI", 4: "KANAN", 5: "MAJU-KIRI", 6: "MAJU-KANAN", 7: "MUNDUR-KIRI", 8: "MUNDUR-KANAN" };
const acks = { gerak: { sel: "#ack-gerak", cycle: null, timer: null }, servo: { sel: "#ack-servo", cycle: null, timer: null } };
const robotState = { gerak: null, lengan: null, capit: null };
const recentServo = { lengan: [], capit: [] };

function ackLabel(variable, value) {
  if (variable === "gerak") return ACK_NAMES[value] || `GERAK ${value}`;
  return `${variable.toUpperCase()} ${value}°`;
}

function ackShow(slot, text, kind) {
  const el = $(acks[slot].sel);
  if (!el) return;
  el.textContent = text;
  el.className = `ack tiny ${kind}`;
  el.title = text;
}

function ackRender(slot) {
  const c = acks[slot].cycle;
  if (!c) return;
  const label = ackLabel(c.variable, c.value);
  if (c.stage === "sent") ackShow(slot, `⏳ ${label} dikirim…`, "sent");
  else if (c.stage === "server" && c.rest) ackShow(slot, `📡 ${label} sampai di server (balasan robot butuh jalur MQTT)`, "server");
  else if (c.stage === "server") ackShow(slot, `📡 ${label} sampai di server`, "server");
  else if (c.stage === "already") ackShow(slot, `✅ ${label} — robot sudah dalam kondisi ini`, "done");
  else if (c.stage === "fail") ackShow(slot, `❌ Robot tidak membalas (${label})`, "fail");
  else if (c.stage === "done" && c.got !== c.value) ackShow(slot, `✅ ${ackLabel(c.variable, c.got)} terlaksana (diminta ${c.value}°, ${c.ms} ms)`, "done");
  else if (c.stage === "done") ackShow(slot, `✅ ${label} terlaksana (${c.ms} ms)`, "done");
}

function ackBegin(slot, variable, value) {
  const a = acks[slot];
  clearTimeout(a.timer);
  a.cycle = { variable, value, got: value, t0: performance.now(), stage: "sent", rest: !fast.ready, ms: 0 };
  if (variable !== "gerak") {
    const list = recentServo[variable];
    a.cycle.entry = { value, t: Date.now(), acked: false };
    list.push(a.cycle.entry);
    while (list.length > 8) list.shift();
  }
  if (variable === "gerak" && robotState.gerak === value && gerak.sent === value && !gerak.busy && !gerak.queue.length) {
    a.cycle.stage = "already";
  } else if (fast.ready) {
    a.timer = setTimeout(() => {
      if (a.cycle && a.cycle.stage !== "done" && a.cycle.stage !== "already") {
        a.cycle.stage = "fail";
        ackRender(slot);
      }
    }, ACK_TIMEOUT_MS);
  }
  ackRender(slot);
}

function ackServer(slot, variable, value, via) {
  const c = acks[slot].cycle;
  if (!c || c.variable !== variable || c.value !== value || c.stage !== "sent") return;
  if (!via || (via.via === "mqtt" && !via.qos)) return;
  c.rest = via.via === "rest";
  c.stage = "server";
  ackRender(slot);
}

function onAck(variable, value) {
  robotState[variable] = value;
  const slot = variable === "gerak" ? "gerak" : "servo";
  const a = acks[slot];
  const c = a.cycle;
  if (!c || c.variable !== variable) return;
  if (c.stage === "done" || c.stage === "already") {
    if (variable === "gerak" && value === 0 && c.value !== 0 && state.drive.dir) ackShow(slot, "⚠ Robot berhenti sendiri (failsafe)", "fail");
    else if (variable === "gerak" && value === c.value) ackRender(slot);
    return;
  }
  if (variable !== "gerak") {
    const hit = recentServo[variable].find((x) => !x.acked && x.value === value && Date.now() - x.t < 10000);
    if (hit) hit.acked = true;
    if (value !== c.value && hit && hit !== c.entry) return;
    c.entry.acked = true;
  } else if (value !== c.value) {
    return;
  }
  clearTimeout(a.timer);
  c.got = value;
  c.ms = Math.round(performance.now() - c.t0);
  c.stage = "done";
  ackRender(slot);
}

function seedRobotState(values) {
  for (const [variable, label] of Object.entries(ACK_VARS)) {
    const d = values[label];
    if (d && robotState[variable] === null) robotState[variable] = Math.round(d.value);
  }
}

/* ---------- Gerak (tahan = jalan, lepas = berhenti) ---------- */

const DIR_VEC = { 1: [1, 0], 2: [-1, 0], 3: [0, -1], 4: [0, 1], 5: [1, -1], 6: [1, 1], 7: [-1, -1], 8: [-1, 1] };
const VEC_DIR = { "1,0": 1, "-1,0": 2, "0,-1": 3, "0,1": 4, "1,-1": 5, "1,1": 6, "-1,-1": 7, "-1,1": 8 };

function combineDirs() {
  let v = 0;
  let h = 0;
  for (const dir of state.inputs.values()) {
    const [dv, dh] = DIR_VEC[dir];
    if (dv) v = dv;
    if (dh) h = dh;
  }
  return VEC_DIR[`${v},${h}`] || 0;
}

function showDrive(dir) {
  const held = new Set(state.inputs.values());
  document.querySelectorAll(".pad-btn[data-dir]").forEach((b) => b.classList.toggle("active", held.has(Number(b.dataset.dir))));
  const label = $("#drive-state");
  label.textContent = `GERAK: ${DIR_NAMES[dir] || "STOP"}`;
  label.classList.toggle("moving", dir > 0);
}

function applyDrive() {
  const dir = combineDirs();
  showDrive(dir);
  if (state.drive.dir === dir) return;
  state.drive = { dir };
  ackBegin("gerak", "gerak", dir);
  if (!dir) {
    stopNow();
    schedulePoll(POLL_RESUME_MS);
    return;
  }
  clearStopGuards();
  vibrate(15);
  queueGerak(dir);
}

function stopNow() {
  clearStopGuards();
  queueGerak(0);
  gerak.parallelTimer = setTimeout(() => {
    if (!state.drive.dir && gerak.busy && gerak.queue.includes(0)) parallelStop();
  }, STOP_PARALLEL_MS);
}

function pressDir(source, dir) {
  clearTimeout(state.releaseTimer);
  state.inputs.delete(source);
  state.inputs.set(source, dir);
  applyDrive();
}

function releaseDir(source) {
  if (!state.inputs.delete(source)) return;
  clearTimeout(state.releaseTimer);
  if (!state.inputs.size) {
    applyDrive();
    return;
  }
  showDrive(state.drive.dir);
  state.releaseTimer = setTimeout(applyDrive, RELEASE_SETTLE_MS);
}

function releaseAll() {
  clearTimeout(state.releaseTimer);
  if (!state.inputs.size && !state.drive.dir) return;
  state.inputs.clear();
  applyDrive();
}

function emergencyStop() {
  clearTimeout(state.releaseTimer);
  state.inputs.clear();
  state.drive = { dir: 0 };
  showDrive(0);
  vibrate([60, 40, 60]);
  const btn = $("#estop");
  btn.classList.add("fired");
  setTimeout(() => btn.classList.remove("fired"), 300);
  ackBegin("gerak", "gerak", 0);
  clearStopGuards();
  gerak.queue.length = 0;
  gerak.dirAt = 0;
  if (gerak.busy) parallelStop();
  gerak.queue.push(0);
  pumpGerak();
  gerak.confirmTimer = setTimeout(confirmStop, STOP_CONFIRM_MS);
  toast("STOP DARURAT dikirim");
}

function onTap(el, fn) {
  if (!el) return;
  el.addEventListener("pointerdown", (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    fn(e);
  });
  el.addEventListener("click", (e) => {
    if (e.detail === 0) fn(e);
  });
}

function bindPad() {
  document.querySelectorAll(".pad-btn[data-dir]").forEach((b) => {
    const dir = Number(b.dataset.dir);
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch {}
      pressDir(`p${e.pointerId}`, dir);
    });
    const end = (e) => releaseDir(`p${e.pointerId}`);
    b.addEventListener("pointerup", end);
    b.addEventListener("pointercancel", end);
    b.addEventListener("lostpointercapture", end);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

/* ---------- Slider (speed, lengan, capit) ---------- */

const SLIDERS = ["speed", "lengan", "capit"];

function showSlider(variable) {
  const input = $(`#${variable}`);
  const unit = variable === "speed" ? "" : "°";
  $(`#${variable}-out`).textContent = `${input.value}${unit}`;
  if (variable === "speed") return;
  const presets = state.settings[variable];
  document.querySelectorAll(`.presets[data-servo="${variable}"] [data-preset]`).forEach((b) => {
    b.classList.toggle("on", Number(presets[b.dataset.preset]) === Number(input.value));
  });
}

function sendSlider(variable, now) {
  const value = Number($(`#${variable}`).value);
  clearTimeout(state.sliderTimers[variable]);
  if (now) {
    send(variable, value);
    return;
  }
  state.sliderTimers[variable] = setTimeout(() => send(variable, value), SLIDER_THROTTLE_MS);
}

function setSlider(variable, value, transmit) {
  const input = $(`#${variable}`);
  input.value = value;
  showSlider(variable);
  if (transmit) sendSlider(variable, true);
}

function applySliderLimits() {
  for (const v of ["lengan", "capit"]) {
    const s = state.settings[v];
    const input = $(`#${v}`);
    input.min = Math.min(s.min, s.max);
    input.max = Math.max(s.min, s.max);
    showSlider(v);
  }
}

function bindSliders() {
  for (const v of SLIDERS) {
    const input = $(`#${v}`);
    input.addEventListener("input", () => {
      input.dataset.touched = "1";
      showSlider(v);
      sendSlider(v, false);
    });
    input.addEventListener("change", () => sendSlider(v, true));
  }
  document.querySelectorAll(".presets [data-preset]").forEach((b) => {
    onTap(b, () => {
      const servo = b.closest(".presets").dataset.servo;
      $(`#${servo}`).dataset.touched = "1";
      setSlider(servo, state.settings[servo][b.dataset.preset], true);
      vibrate(15);
    });
  });
}

/* ---------- Monitoring ---------- */

function freshValue(name, maxAge = STALE_MS) {
  const d = state.values[name];
  if (!d) return null;
  if (Date.now() - d.ts > maxAge) return null;
  return d;
}

function updateTemp() {
  const d = state.values.suhu_objek;
  const card = $("#temp-card");
  const pill = $("#temp-state");
  const batas = state.settings.batas;
  card.classList.remove("hot", "warm", "stale");
  pill.className = "pill";
  if (!d) {
    $("#temp-val").textContent = "--.-";
    pill.textContent = "BELUM ADA DATA";
    $("#temp-sub").textContent = `batas hotspot ${batas} °C`;
    return;
  }
  const age = Date.now() - d.ts;
  $("#temp-val").textContent = d.value.toFixed(1);
  if (age > STALE_MS) {
    card.classList.add("stale");
    pill.textContent = "DATA LAMA";
  } else if (d.value >= batas) {
    card.classList.add("hot");
    pill.classList.add("hot");
    pill.textContent = "🔥 HOTSPOT";
  } else if (d.value >= batas - WARM_MARGIN) {
    card.classList.add("warm");
    pill.classList.add("warn");
    pill.textContent = "MENDEKATI";
  } else {
    pill.classList.add("good");
    pill.textContent = "NORMAL";
  }
  $("#temp-sub").textContent = `batas hotspot ${batas} °C · ${ago(age)}`;
}

function codeText(code) {
  if (code === 200) return ["BERHASIL (200)", "ok"];
  if (code === 401 || code === 403) return [`DIKUNCI (${code}) — normal sebelum lomba`, "warn"];
  if (code === 0) return ["belum pernah kirim", "warn"];
  if (code === -3) return ["DITOLAK robot: suhu di bawah batas", "warn"];
  if (code < 0) return [`TIDAK SAMPAI (${code}) — cek WiFi robot`, "bad"];
  return [`HTTP ${code}`, "bad"];
}

function updateWeb() {
  const hs = state.values.hotspot;
  const pill = $("#web-hotspot");
  pill.className = "pill";
  if (hs && hs.value >= 1) {
    pill.classList.add("good");
    pill.textContent = `HOTSPOT ✓ ${clock(hs.ts)}`;
    pill.title = `Hotspot diterima web dosen ${ago(Date.now() - hs.ts)}`;
  } else {
    pill.textContent = "HOTSPOT BELUM";
    pill.title = `Robot mengirim otomatis saat suhu ≥ ${state.settings.batas} °C`;
  }

  const box = $("#web-last");
  const fc = state.values.fb_code;
  if (!fc) {
    box.textContent = `Belum ada kiriman. Hotspot dikirim otomatis saat suhu ≥ ${state.settings.batas} °C.`;
  } else {
    const jenis = state.values.fb_jenis;
    const suhu = state.values.fb_suhu;
    let data = "";
    if (jenis && jenis.value === 2) data = '{"hotspot":true}';
    else if (suhu) data = `{"suhu":${suhu.value.toFixed(1)},"wifi":true}`;
    const [txt, cls] = codeText(Math.round(fc.value));
    box.innerHTML = "";
    const time = document.createElement("b");
    time.textContent = clock(fc.ts);
    const res = document.createElement("span");
    res.className = cls;
    res.textContent = txt;
    box.append(time, document.createTextNode(` ${data} → `), res);
  }

  const suhu = freshValue("suhu_objek");
  const online = Date.now() - state.lastSeen < ROBOT_ONLINE_MS;
  const btn = $("#btn-hotspot");
  btn.disabled = !(online && suhu && suhu.value >= state.settings.batas);
  btn.title = btn.disabled ? `Aktif saat robot online dan suhu ≥ ${state.settings.batas} °C` : "Minta robot kirim hotspot ke web dosen sekarang";
}

function updateRobotStatus() {
  for (const name of ROBOT_VARS) {
    const d = state.values[name];
    if (d && d.ts > state.lastSeen) state.lastSeen = d.ts;
  }
  const box = $("#link");
  const label = $("#link-text");
  box.classList.remove("online", "late", "offline");
  if (!state.lastSeen) {
    label.textContent = "BELUM ADA DATA";
    box.classList.add("offline");
    return;
  }
  const age = Date.now() - state.lastSeen;
  if (age < ROBOT_ONLINE_MS) {
    label.textContent = "ONLINE";
    box.classList.add("online");
  } else if (age < ROBOT_LATE_MS) {
    label.textContent = `TERTUNDA ${ago(age)}`;
    box.classList.add("late");
  } else {
    label.textContent = `OFFLINE ${ago(age)}`;
    box.classList.add("offline");
  }
}

function syncSliders() {
  if (!state.firstSync) return;
  state.firstSync = false;
  for (const v of SLIDERS) {
    const d = state.values[v];
    const input = $(`#${v}`);
    if (d && !input.dataset.touched) setSlider(v, d.value, false);
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
  const canvas = $("#chart");
  if (!window.Chart) {
    canvas.hidden = true;
    $("#chart-fallback").hidden = false;
    return;
  }
  canvas.hidden = false;
  $("#chart-fallback").hidden = true;
  state.chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Suhu objek", data: [], borderColor: "#ff7a45", backgroundColor: "rgba(255,122,69,0.15)", fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true },
        { label: "Batas", data: [], borderColor: "#e5484d", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y === null ? "—" : ctx.parsed.y.toFixed(1)} °C` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 4, maxRotation: 0, font: { size: 10 } } },
        y: { ticks: { maxTicksLimit: 4, font: { size: 10 } } },
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
  for (const axis of ["x", "y"]) {
    c.options.scales[axis].ticks.color = muted;
    c.options.scales[axis].grid = { color: grid };
  }
  c.update("none");
}

function updateChart() {
  const c = state.chart;
  const d = state.values.suhu_objek;
  if (!c || !d || d.ts <= state.lastChartTs) return;
  state.lastChartTs = d.ts;
  c.data.labels.push(clock(d.ts));
  c.data.datasets[0].data.push(d.value);
  c.data.datasets[1].data.push(state.settings.batas);
  while (c.data.labels.length > CHART_POINTS) {
    c.data.labels.shift();
    c.data.datasets.forEach((ds) => ds.data.shift());
  }
  c.update("none");
}

function refreshBatasLine() {
  const c = state.chart;
  if (!c) return;
  c.data.datasets[1].data = c.data.labels.map(() => state.settings.batas);
  c.update("none");
}

/* ---------- Polling ---------- */

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(poll, delay);
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.token || document.hidden || $("#app").hidden) return;
  const driving = state.drive.dir || gerak.busy || gerak.queue.length || Date.now() - gerak.sentAt < POLL_RESUME_MS;
  if (driving && !fast.ready) {
    schedulePoll(800);
    return;
  }
  if (state.polling) return;
  state.polling = true;
  try {
    state.values = await readValues();
    seedRobotState(state.values);
    if (state.bannerKind) setBanner("");
    syncSliders();
    updateRobotStatus();
    updateTemp();
    updateWeb();
    updateChart();
  } catch (e) {
    setBanner(errorText(e), e.kind);
    updateRobotStatus();
  } finally {
    state.polling = false;
  }
  if (state.token && !document.hidden) schedulePoll(state.settings.pollInterval * 1000);
}

function tick() {
  $("#clock").textContent = clock(Date.now());
  if ($("#app").hidden) return;
  updateRobotStatus();
  updateTemp();
  updateWeb();
}

/* ---------- Layar penuh & orientasi ---------- */

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock("landscape").catch(() => {});
  } catch {
    toast("Browser ini tidak mendukung layar penuh.", true);
  }
}

function portraitAllowed() {
  try { return sessionStorage.getItem(KEY_PORTRAIT) === "1"; } catch { return false; }
}

function checkOrientation() {
  const portraitPhone = window.matchMedia("(orientation: portrait) and (max-width: 760px)").matches;
  const allowed = portraitAllowed();
  $("#app").classList.toggle("portrait-ok", allowed);
  $("#rotate").hidden = !(portraitPhone && !allowed && !$("#app").hidden);
  checkFullscreenHint();
}

let fullHintShown = false;
function checkFullscreenHint() {
  const cramped = !$("#app").hidden && innerHeight < 350 && !document.fullscreenElement && Boolean(document.documentElement.requestFullscreen);
  $("#btn-full").classList.toggle("nudge", cramped);
  if (!cramped || fullHintShown) return;
  fullHintShown = true;
  try {
    if (sessionStorage.getItem(KEY_FULL_HINT) === "1") return;
    sessionStorage.setItem(KEY_FULL_HINT, "1");
  } catch {}
  toast("Tekan ⛶ untuk layar penuh — bilah alamat browser memakan tempat");
}

/* ---------- Tema & pengaturan ---------- */

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
    const label = document.createElement("label");
    label.className = "seg";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "theme";
    radio.value = t.id;
    const span = document.createElement("span");
    const dot = document.createElement("i");
    dot.style.background = t.swatch;
    span.append(dot, document.createTextNode(t.label));
    label.append(radio, span);
    box.append(label);
  }
}

function saveSettings() {
  store.set(KEY_SETTINGS, state.settings);
}

const ANGLE_FIELDS = [
  ["lengan", "turun"], ["lengan", "bawa"], ["lengan", "parkir"], ["lengan", "min"], ["lengan", "max"],
  ["capit", "buka"], ["capit", "tutup"], ["capit", "min"], ["capit", "max"],
];

function openSettings() {
  const form = $("#settings-form");
  const s = state.settings;
  $("#set-device").value = s.device;
  $("#set-interval").value = s.pollInterval;
  $("#set-batas").value = s.batas;
  $("#set-mqtt").checked = s.mqtt;
  for (const [servo, key] of ANGLE_FIELDS) form.elements[`${servo}-${key}`].value = s[servo][key];
  $("#set-token").value = state.token;
  $("#set-token").type = "password";
  form.elements.theme.value = s.theme;
  form.elements.mode.value = s.mode;
  $("#settings-error").hidden = true;
  $("#settings").returnValue = "";
  $("#settings").showModal();
}

function applySettings() {
  const form = $("#settings-form");
  const s = state.settings;
  const device = $("#set-device").value.trim() || DEFAULT_SETTINGS.device;
  const batas = Math.min(300, Math.max(20, num($("#set-batas").value, s.batas)));
  const batasChanged = batas !== s.batas;
  const deviceChanged = device !== s.device;
  const next = {
    ...s,
    device,
    batas,
    pollInterval: Math.min(60, Math.max(1, num($("#set-interval").value, s.pollInterval))),
    mqtt: $("#set-mqtt").checked,
    theme: form.elements.theme.value || s.theme,
    mode: form.elements.mode.value || s.mode,
    lengan: { ...s.lengan },
    capit: { ...s.capit },
  };
  for (const [servo, key] of ANGLE_FIELDS) {
    const lim = SERVO_LIMITS[servo];
    next[servo][key] = Math.min(lim.max, Math.max(lim.min, Math.round(num(form.elements[`${servo}-${key}`].value, s[servo][key]))));
  }
  state.settings = next;
  saveSettings();
  const token = $("#set-token").value.trim();
  const tokenChanged = Boolean(token && token !== state.token);
  if (tokenChanged) {
    state.token = token;
    store.set(KEY_TOKEN, token);
  }
  if (tokenChanged || deviceChanged || next.mqtt !== s.mqtt) {
    fast.fails = 0;
    fastStart();
  }
  applySliderLimits();
  if (deviceChanged) {
    state.readMode = "v2";
    state.firstSync = true;
    state.lastSeen = 0;
    state.values = {};
    initChart();
    loadHistory();
  } else {
    refreshBatasLine();
  }
  if (batasChanged) send("batas_suhu", batas);
  toast("Pengaturan disimpan");
  poll();
}

/* ---------- Login ---------- */

function showLogin() {
  releaseAll();
  $("#app").hidden = true;
  setTimeout(() => { if ($("#app").hidden) fastStop(); }, 1500);
  $("#login").hidden = false;
  $("#login-device").value = state.settings.device;
  $("#login-token").value = "";
  $("#login-error").hidden = true;
  checkOrientation();
}

function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  state.readMode = "v2";
  state.firstSync = true;
  state.lastSeen = 0;
  initChart();
  applySliderLimits();
  showSlider("speed");
  updateRobotStatus();
  updateTemp();
  updateWeb();
  checkOrientation();
  fast.fails = 0;
  fastStart();
  poll().then(loadHistory);
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

function logout() {
  if (!confirm("Logout dan hapus token Ubidots dari browser ini?")) return;
  emergencyStop();
  clearTimeout(state.pollTimer);
  state.token = "";
  store.remove(KEY_TOKEN);
  $("#settings").close();
  showLogin();
}

/* ---------- Event ---------- */

function typing(e) {
  return $("#app").hidden || $("#settings").open || e.target.closest("input, textarea, select");
}

function bindEvents() {
  $("#login-form").addEventListener("submit", handleLogin);
  onTap($("#estop"), emergencyStop);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-full").addEventListener("click", toggleFullscreen);
  $("#logout").addEventListener("click", logout);
  $("#btn-hotspot").addEventListener("click", () => {
    send("kirim_hotspot", 1);
    vibrate(40);
    toast("Permintaan kirim hotspot dikirim ke robot");
  });
  $("#rotate-skip").addEventListener("click", () => {
    try { sessionStorage.setItem(KEY_PORTRAIT, "1"); } catch {}
    checkOrientation();
  });

  bindPad();
  bindSliders();

  const form = $("#settings-form");
  form.addEventListener("change", (e) => {
    if (e.target.name === "theme" || e.target.name === "mode") applyTheme(form.elements.theme.value, form.elements.mode.value);
  });
  $("#settings").addEventListener("close", () => {
    if ($("#settings").returnValue === "save") applySettings();
    else applyTheme(state.settings.theme, state.settings.mode);
  });

  document.querySelectorAll("[data-reveal]").forEach((b) => {
    b.addEventListener("click", () => {
      const f = document.getElementById(b.dataset.reveal);
      const show = f.type === "password";
      f.type = show ? "text" : "password";
      b.textContent = show ? "Sembunyi" : "Lihat";
    });
  });

  document.addEventListener("keydown", (e) => {
    if (typing(e)) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) emergencyStop();
      return;
    }
    const dir = KEY_DIRS[e.key.toLowerCase()];
    if (!dir) return;
    e.preventDefault();
    if (!e.repeat) pressDir(`k${e.key.toLowerCase()}`, dir);
  });
  document.addEventListener("keyup", (e) => {
    const dir = KEY_DIRS[e.key.toLowerCase()];
    if (dir) releaseDir(`k${e.key.toLowerCase()}`);
  });

  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAll();
      clearTimeout(state.pollTimer);
      setTimeout(() => { if (document.hidden) fastStop(); }, 2000);
    } else if (state.token && !$("#app").hidden) {
      poll();
      if (!fast.client) fastStart();
    }
  });
  window.addEventListener("online", () => {
    if (!state.token) return;
    poll();
    if (!fast.ready) fastStart();
  });
  window.addEventListener("offline", () => setBanner(errorText({ kind: "offline" }), "offline"));
  window.addEventListener("resize", checkOrientation);
  document.addEventListener("fullscreenchange", () => {
    $("#btn-full").textContent = document.fullscreenElement ? "🗗" : "⛶";
    checkFullscreenHint();
  });
}

function init() {
  saveSettings();
  applyTheme(state.settings.theme, state.settings.mode);
  renderThemeSwatches();
  bindEvents();
  tick();
  setInterval(tick, 1000);
  setInterval(gerakHeartbeat, 200);
  showNet();
  if (state.token) showApp();
  else showLogin();
}

init();
