/*
 * Phantom Kontrol — dashboard robot GARUDA, satu layar landscape untuk HP.
 *
 * Variabel Ubidots (device "phantom"):
 *   kirim dari dashboard : gerak (0 stop, 1 maju, 2 mundur, 3 kiri, 4 kanan), speed, lengan, capit,
 *                          batas_suhu, kirim_hotspot (1 = minta robot kirim hotspot ke web dosen)
 *   dibaca dari robot    : suhu_objek, hotspot (1 = hotspot sudah diterima web dosen),
 *                          fb_code (HTTP kiriman terakhir ke web dosen), fb_jenis (1 data, 2 hotspot), fb_suhu
 */

const API_BASE = "https://industrial.api.ubidots.com/api";
const KEY_TOKEN = "phantom.token";
const KEY_SETTINGS = "phantom.settings";
const KEY_PORTRAIT = "phantom.portraitOk";

const THEMES = [
  { id: "garuda", label: "Biru Garuda", swatch: "#3b8eea" },
  { id: "rescue", label: "Merah Rescue", swatch: "#ff5a36" },
  { id: "military", label: "Hijau Militer", swatch: "#8fb04f" },
  { id: "neon", label: "Ungu Neon", swatch: "#a970ff" },
];

const DEFAULT_SETTINGS = {
  v: 3,
  device: "phantom",
  pollInterval: 3,
  theme: "garuda",
  mode: "dark",
  batas: 50,
  lengan: { turun: 25, bawa: 60, parkir: 135, min: 25, max: 135 },
  capit: { buka: 118, tutup: 90, min: 40, max: 150 },
};

const ROBOT_VARS = ["suhu_objek", "fb_code", "hotspot"];
const REQUEST_GAP_MS = 1100;
const REQUEST_TIMEOUT_MS = 8000;
const BACKOFF_START_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const HOLD_HEARTBEAT_MS = 1500;
const SLIDER_THROTTLE_MS = 700;
const ROBOT_ONLINE_MS = 15000;
const ROBOT_LATE_MS = 60000;
const STALE_MS = 20000;
const CHART_POINTS = 60;
const WARM_MARGIN = 10;
const PRIORITY = { poll: 1, control: 2, heartbeat: 3, urgent: 9 };
const RETRYABLE = new Set(["ratelimit", "timeout", "network", "server"]);
const DIR_NAMES = { 1: "MAJU", 2: "MUNDUR", 3: "KIRI", 4: "KANAN" };
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

function loadSettings() {
  const saved = store.get(KEY_SETTINGS, {}) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  s.lengan = { ...DEFAULT_SETTINGS.lengan, ...(saved.lengan || {}) };
  s.capit = { ...DEFAULT_SETTINGS.capit, ...(saved.capit || {}) };
  s.batas = num(saved.batas, DEFAULT_SETTINGS.batas);
  s.pollInterval = Math.max(1, num(s.pollInterval, DEFAULT_SETTINGS.pollInterval));
  if (!THEMES.some((t) => t.id === s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  if (s.mode !== "light") s.mode = "dark";
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
  drive: { dir: 0, timer: null, source: null },
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
  toast(`STOP gagal terkirim! ${errorText(lastErr)}`, true);
  return false;
}

/* ---------- Gerak (tahan = jalan, lepas = berhenti) ---------- */

function setPadActive(dir) {
  document.querySelectorAll(".pad-btn[data-dir]").forEach((b) => b.classList.toggle("active", Number(b.dataset.dir) === dir));
}

function startDrive(dir, source) {
  if (state.drive.dir === dir) return;
  clearInterval(state.drive.timer);
  state.drive = { dir, source, timer: setInterval(() => send("gerak", dir, PRIORITY.heartbeat), HOLD_HEARTBEAT_MS) };
  setPadActive(dir);
  vibrate(15);
  send("gerak", dir, PRIORITY.heartbeat);
}

function stopDrive(source) {
  if (!state.drive.dir) return;
  if (source && state.drive.source !== source) return;
  clearInterval(state.drive.timer);
  state.drive = { dir: 0, timer: null, source: null };
  setPadActive(0);
  send("gerak", 0, PRIORITY.heartbeat);
  schedulePoll(state.settings.pollInterval * 1000);
}

function emergencyStop() {
  clearInterval(state.drive.timer);
  state.drive = { dir: 0, timer: null, source: null };
  setPadActive(0);
  vibrate([60, 40, 60]);
  const btn = $("#estop");
  btn.classList.add("fired");
  setTimeout(() => btn.classList.remove("fired"), 300);
  const q = state.sendQ.gerak;
  if (q) q.has = false;
  sendUrgent("gerak", 0);
  toast("STOP DARURAT dikirim");
}

function bindPad() {
  document.querySelectorAll(".pad-btn[data-dir]").forEach((b) => {
    const dir = Number(b.dataset.dir);
    const id = `pad${dir}`;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch {}
      startDrive(dir, id);
    });
    const end = () => stopDrive(id);
    b.addEventListener("pointerup", end);
    b.addEventListener("pointercancel", end);
    b.addEventListener("lostpointercapture", end);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  });
  $("#pad-stop").addEventListener("click", () => {
    stopDrive();
    send("gerak", 0, PRIORITY.heartbeat);
    vibrate(30);
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
    b.addEventListener("click", () => {
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
  if (state.drive.dir) {
    schedulePoll(800);
    return;
  }
  if (state.polling) return;
  state.polling = true;
  try {
    state.values = await readValues();
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
    theme: form.elements.theme.value || s.theme,
    mode: form.elements.mode.value || s.mode,
    lengan: { ...s.lengan },
    capit: { ...s.capit },
  };
  for (const [servo, key] of ANGLE_FIELDS) {
    next[servo][key] = Math.min(180, Math.max(0, Math.round(num(form.elements[`${servo}-${key}`].value, s[servo][key]))));
  }
  state.settings = next;
  saveSettings();
  const token = $("#set-token").value.trim();
  if (token && token !== state.token) {
    state.token = token;
    store.set(KEY_TOKEN, token);
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
  stopDrive();
  $("#app").hidden = true;
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
  $("#estop").addEventListener("click", emergencyStop);
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
    if (!e.repeat) startDrive(dir, `key${dir}`);
  });
  document.addEventListener("keyup", (e) => {
    const dir = KEY_DIRS[e.key.toLowerCase()];
    if (dir) stopDrive(`key${dir}`);
  });

  window.addEventListener("blur", () => stopDrive());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopDrive();
      clearTimeout(state.pollTimer);
    } else if (state.token && !$("#app").hidden) {
      poll();
    }
  });
  window.addEventListener("online", () => { if (state.token) poll(); });
  window.addEventListener("offline", () => setBanner(errorText({ kind: "offline" }), "offline"));
  window.addEventListener("resize", checkOrientation);
  document.addEventListener("fullscreenchange", () => {
    $("#btn-full").textContent = document.fullscreenElement ? "🗗" : "⛶";
  });
}

function init() {
  saveSettings();
  applyTheme(state.settings.theme, state.settings.mode);
  renderThemeSwatches();
  bindEvents();
  tick();
  setInterval(tick, 1000);
  if (state.token) showApp();
  else showLogin();
}

init();
