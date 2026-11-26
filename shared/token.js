/*
 * Token Ubidots bersama untuk Beranda (/), /robot/ dan /dash/.
 * Token hanya disimpan di localStorage browser, tidak pernah di kode atau di URL.
 */
(function () {
  const KEY = "phantom_ubidots_token";
  const OLD_KEYS = ["phantom.token"];
  const KEY_SIAP = "phantom_ubidots_siap";
  const KEY_SETTINGS = "phantom.settings";
  const API = "https://industrial.api.ubidots.com/api";
  const TIMEOUT_MS = 8000;
  const JEDA_MS = 1200;
  const AUTH_STATUS = [401, 402, 403];
  const PESAN = {
    kosong: "Isi token Ubidots dulu.",
    invalid: "Token tidak valid",
    offline: "Tidak ada koneksi",
    expired: "Token tidak berlaku, masukkan token baru",
    ratelimit: "Ubidots sedang membatasi request. Coba lagi beberapa detik lagi.",
  };
  const VAR_KONTROL = { gerak: 0, speed: 150, lengan: 0, capit: 110, kirim_hotspot: 0 };
  const VAR_ROBOT = ["suhu_objek", "hotspot", "fb_code", "fb_jenis", "fb_suhu", "ack_gerak", "ack_lengan", "ack_capit"];
  const VAR_LOGGER = ["suhu_objek", "data_ke", "http_code"];

  let opts = null;
  let terkunci = true;

  function baca(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function tulis(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  }

  function bacaLama(key) {
    const raw = baca(key);
    if (!raw) return "";
    try {
      const v = JSON.parse(raw);
      if (typeof v === "string") return v;
    } catch {}
    return raw;
  }

  function get() {
    const t = baca(KEY);
    if (t) return t;
    for (const k of OLD_KEYS) {
      const lama = bacaLama(k);
      if (lama) {
        tulis(KEY, lama);
        tulis(k, null);
        return lama;
      }
    }
    return "";
  }

  function save(token) {
    tulis(KEY, token);
    for (const k of OLD_KEYS) tulis(k, null);
  }

  function clear() {
    tulis(KEY, null);
    for (const k of OLD_KEYS) tulis(k, null);
  }

  function isAuthStatus(status) {
    return AUTH_STATUS.includes(status);
  }

  async function minta(method, path, token, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const headers = { "X-Auth-Token": token };
    if (body) headers["Content-Type"] = "application/json";
    try {
      const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      return { status: res.status, data };
    } catch {
      return { status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async function check(token) {
    const r = await minta("GET", "/v2.0/devices/?page_size=1", token);
    if (r.status >= 200 && r.status < 300) return { kind: "ok" };
    if (isAuthStatus(r.status)) return { kind: "invalid", status: r.status };
    if (r.status === 0) return { kind: "offline" };
    if (r.status === 429) return { kind: "ratelimit", status: 429 };
    return { kind: "error", status: r.status };
  }

  function pesanCek(r) {
    if (r.kind === "invalid") return PESAN.invalid;
    if (r.kind === "offline") return PESAN.offline;
    if (r.kind === "ratelimit") return PESAN.ratelimit;
    return `Ubidots menolak permintaan (HTTP ${r.status}). Coba lagi.`;
  }

  /* ---------- Akun baru: siapkan device & variabel ---------- */

  const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));

  function sidik(token) {
    let h = 5381;
    for (let i = 0; i < token.length; i++) h = ((h * 33) ^ token.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function pengaturanRobot() {
    try {
      const s = JSON.parse(baca(KEY_SETTINGS) || "{}");
      let device = "phantom";
      if (typeof s.device === "string" && /^[a-z0-9_-]+$/.test(s.device)) device = s.device;
      let batas = 50;
      if (Number.isFinite(Number(s.batas))) batas = Number(s.batas);
      return { device, batas };
    } catch {
      return { device: "phantom", batas: 50 };
    }
  }

  async function labelVariabel(token, device) {
    const r = await minta("GET", `/v2.0/devices/~${encodeURIComponent(device)}/variables/?page_size=200`, token);
    await tunggu(JEDA_MS);
    if (r.status === 404) return { ada: false, labels: [] };
    if (r.status < 200 || r.status >= 300) return null;
    const labels = ((r.data && r.data.results) || []).map((v) => v.label);
    return { ada: true, labels };
  }

  async function buatKosong(token, device, adaDevice, labels) {
    let ok = true;
    if (!adaDevice) {
      const r = await minta("POST", "/v2.0/devices/", token, { label: device, name: device });
      await tunggu(JEDA_MS);
      if (r.status >= 300 && r.status !== 400) ok = false;
    }
    for (const label of labels) {
      const r = await minta("POST", `/v2.0/devices/~${encodeURIComponent(device)}/variables/`, token, { label, name: label });
      await tunggu(JEDA_MS);
      if (isAuthStatus(r.status)) return false;
      if (r.status >= 300 && r.status !== 400) ok = false;
    }
    return ok;
  }

  async function siapkanRobot(token) {
    const { device, batas } = pengaturanRobot();
    const cek = await labelVariabel(token, device);
    if (!cek) return false;
    const awal = {};
    for (const [label, value] of Object.entries({ ...VAR_KONTROL, batas_suhu: batas })) {
      if (!cek.labels.includes(label)) awal[label] = value;
    }
    if (Object.keys(awal).length) {
      const r = await minta("POST", `/v1.6/devices/${encodeURIComponent(device)}/`, token, awal);
      await tunggu(JEDA_MS);
      if (r.status < 200 || r.status >= 300) return false;
    }
    const kosong = VAR_ROBOT.filter((l) => !cek.labels.includes(l));
    await buatKosong(token, device, true, kosong);
    return true;
  }

  async function siapkanLogger(token) {
    const cek = await labelVariabel(token, "logger");
    if (!cek) return false;
    const kosong = VAR_LOGGER.filter((l) => !cek.labels.includes(l));
    if (!kosong.length) return true;
    await buatKosong(token, "logger", cek.ada, kosong);
    return true;
  }

  let menyiapkan = false;

  async function prepareAccount(token) {
    if (menyiapkan || !token || baca(KEY_SIAP) === sidik(token)) return;
    menyiapkan = true;
    try {
      await tunggu(3000);
      const robot = await siapkanRobot(token);
      const logger = await siapkanLogger(token);
      if (robot && logger && get() === token) tulis(KEY_SIAP, sidik(token));
    } finally {
      menyiapkan = false;
    }
  }

  /* ---------- Layar token ---------- */

  const $ = (id) => document.getElementById(id);

  function lock(pesan) {
    terkunci = true;
    if (opts && opts.onLock) opts.onLock();
    const gate = $("login");
    if (!gate) return;
    gate.hidden = false;
    const input = $("login-token");
    input.value = "";
    input.type = "password";
    const reveal = $("login-reveal");
    if (reveal) reveal.textContent = "Tampilkan";
    tampilError(pesan || "");
  }

  function tampilError(pesan) {
    const err = $("login-error");
    if (!err) return;
    err.textContent = pesan;
    err.hidden = !pesan;
  }

  function buka(fresh) {
    terkunci = false;
    const gate = $("login");
    if (gate) gate.hidden = true;
    if (opts && opts.onReady) opts.onReady(fresh);
    prepareAccount(get());
  }

  function expire() {
    if (terkunci && !get()) return;
    clear();
    lock(PESAN.expired);
  }

  function change() {
    if (!confirm("Ganti token Ubidots? Token lama dihapus dari browser ini (berlaku untuk semua dashboard).")) return;
    clear();
    lock("");
  }

  async function masuk(e) {
    e.preventDefault();
    const input = $("login-token");
    const submit = $("login-submit");
    const token = input.value.trim();
    if (!token) {
      tampilError(PESAN.kosong);
      return;
    }
    tampilError("");
    submit.disabled = true;
    submit.textContent = "Memeriksa token…";
    const r = await check(token);
    submit.disabled = false;
    submit.textContent = "Masuk";
    if (r.kind !== "ok") {
      tampilError(pesanCek(r));
      return;
    }
    save(token);
    buka(true);
  }

  function mount(options) {
    opts = options || {};
    const form = $("login-form");
    if (form) form.addEventListener("submit", masuk);
    const reveal = $("login-reveal");
    if (reveal) {
      reveal.addEventListener("click", () => {
        const input = $("login-token");
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        reveal.textContent = show ? "Sembunyikan" : "Tampilkan";
      });
    }
    document.querySelectorAll("[data-token-change]").forEach((b) => b.addEventListener("click", change));
    window.addEventListener("storage", (e) => {
      if (e.key === KEY && !e.newValue && !terkunci) lock("");
    });
    if (get()) buka(false);
    else lock("");
  }

  window.PhantomToken = { get, save, clear, check, mount, expire, change, isAuthStatus, prepareAccount, PESAN };
})();
