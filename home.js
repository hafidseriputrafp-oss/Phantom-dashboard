const STATUS_REFRESH_MS = 15000;

const home = {
  statuses: {},
  timer: null,
  editing: null,
};

function hrefOf(cfg) {
  return cfg.kind === "link" ? cfg.url : `dash/?id=${encodeURIComponent(cfg.id)}`;
}

function deviceOf(cfg) {
  return cfg.id === "robot" ? robotDevice() : cfg.device || "";
}

function statusOf(cfg) {
  const device = deviceOf(cfg);
  const st = device && home.statuses[device];
  if (!device) return { cls: "", text: "Tanpa device utama" };
  if (!st) return { cls: "", text: getToken() ? "Memeriksa…" : "Belum login" };
  if (st.error) return { cls: "offline", text: st.error.kind === "notfound" ? "Device belum ada" : "Gagal membaca" };
  if (!st.lastSeen) return { cls: "offline", text: "Belum ada data" };
  const age = Date.now() - st.lastSeen;
  const online = age < (cfg.onlineS || 60) * 1000;
  return { cls: online ? "online" : "offline", text: `${online ? "Online" : "Offline"} · ${ago(age)}` };
}

function renderGrid() {
  const grid = $("#dash-grid");
  grid.innerHTML = "";
  for (const cfg of listDashboards()) {
    const card = el("div", "card dash-card");
    card.dataset.id = cfg.id;
    const head = el("div", "dash-card-head");
    const title = el("a", "dash-title");
    title.href = hrefOf(cfg);
    title.append(el("strong", "", cfg.name), el("small", "", cfg.kind === "link" ? cfg.url : `dash/?id=${cfg.id}`));
    const menu = button("⋮", "btn ghost menu-btn", (e) => {
      e.stopPropagation();
      openActions(cfg);
    });
    menu.setAttribute("aria-label", `Menu ${cfg.name}`);
    head.append(el("span", "dash-icon", cfg.icon || "📊"), title, menu);

    const badges = el("div", "dash-badges");
    const device = deviceOf(cfg);
    if (device) badges.append(el("span", "chip mono", `📡 ${device}`));
    if (cfg.kind === "builder") badges.append(el("span", "chip", `${(cfg.widgets || []).length} widget`));
    if (cfg.builtin) badges.append(el("span", "chip", "Bawaan"));

    const st = statusOf(cfg);
    const status = el("div", `dash-status ${st.cls}`);
    status.append(el("span", "dot"), el("span", "", st.text));
    const open = el("div", "dash-open", "Buka →");
    const foot = el("div", "w-actions");
    foot.append(status, open);

    card.append(head, badges, foot);
    card.addEventListener("click", (e) => {
      if (e.target.closest("button, a")) return;
      location.href = hrefOf(cfg);
    });
    grid.append(card);
  }
  grid.append(button("+ Tambah Dashboard", "add-tile add-card", () => openDashDialog(null)));
  $("#restore-builtins").hidden = !missingBuiltins().length;
}

async function refreshStatuses() {
  clearTimeout(home.timer);
  if (!getToken() || document.hidden) return;
  const devices = [...new Set(listDashboards().map(deviceOf).filter(Boolean))];
  for (const device of devices) {
    try {
      const vars = await readDevice(device, PRIORITY.poll);
      const lastSeen = Math.max(0, ...Object.values(vars).map((d) => d.created || d.ts));
      home.statuses[device] = { lastSeen };
      if (bannerKind === "ratelimit") setBanner("");
    } catch (e) {
      home.statuses[device] = { error: e };
      if (e.kind === "ratelimit" || e.kind === "auth") setBanner(errorText(e), e.kind);
    }
    renderGrid();
  }
  home.timer = setTimeout(refreshStatuses, STATUS_REFRESH_MS);
}

/* ---------- Aksi kartu ---------- */

function openActions(cfg) {
  $("#actions-title").textContent = `${cfg.icon || ""} ${cfg.name}`.trim();
  const list = $("#action-list");
  list.innerHTML = "";
  const close = () => $("#actions").close();
  list.append(
    button("↗ Buka", "btn", () => { location.href = hrefOf(cfg); }),
    button("✎ Ubah nama & ikon", "btn", () => { close(); openDashDialog(cfg); }),
  );
  const dup = button("⧉ Duplikat", "btn", () => { close(); duplicateDashboard(cfg); });
  if (cfg.kind === "link") {
    dup.disabled = true;
    dup.title = "Dashboard robot adalah halaman tetap dan tidak bisa diduplikat";
  }
  list.append(dup, button("🗑 Hapus", "btn danger", () => { close(); deleteDashboard(cfg); }));
  $("#actions").showModal();
}

async function duplicateDashboard(cfg) {
  const copy = clone(cfg);
  copy.id = uniqueId(`${cfg.name} salinan`);
  copy.name = `${cfg.name} (salinan)`.slice(0, 40);
  copy.builtin = false;
  copy.order = Date.now();
  await commit(copy, `"${copy.name}" dibuat`);
}

async function deleteDashboard(cfg) {
  if (cfg.builtin) {
    const typed = prompt(`"${cfg.name}" adalah dashboard bawaan. Ketik HAPUS untuk menghapusnya (bisa dipulihkan lewat tombol "Pulihkan bawaan").`);
    if ((typed || "").trim().toUpperCase() !== "HAPUS") return;
  } else if (!confirm(`Hapus dashboard "${cfg.name}"? Tindakan ini juga menghapusnya dari perangkat lain.`)) {
    return;
  }
  await commit({ id: cfg.id, deleted: true, builtin: Boolean(cfg.builtin), name: cfg.name }, `"${cfg.name}" dihapus`);
}

async function restoreBuiltins() {
  for (const b of missingBuiltins()) await commit(clone(b), `"${b.name}" dipulihkan`);
}

async function commit(cfg, message) {
  const pending = saveDashboard(cfg);
  renderGrid();
  toast(message);
  await pending;
  refreshStatuses();
}

/* ---------- Dialog tambah / ubah ---------- */

function openDashDialog(cfg) {
  home.editing = cfg;
  const form = $("#dash-form");
  form.reset();
  $("#dash-dialog-title").textContent = cfg ? `Ubah: ${cfg.name}` : "Tambah Dashboard";
  form.elements.name.value = cfg ? cfg.name : "";
  form.elements.icon.value = cfg ? cfg.icon || "" : "📊";
  form.elements.device.value = cfg ? cfg.device || "" : "";
  const isLink = cfg && cfg.kind === "link";
  $("#dash-device-field").hidden = isLink;
  $("#dash-device-hint").hidden = !isLink;
  $("#dash-template-field").hidden = Boolean(cfg);
  $("#dash-error").hidden = true;
  $("#dash-dialog").returnValue = "";
  $("#dash-dialog").showModal();
}

function readDashForm(form) {
  const name = form.elements.name.value.trim();
  if (!name) throw new Error("Nama dashboard wajib diisi.");
  const device = form.elements.device.value.trim().toLowerCase();
  if (device && !LABEL_RE.test(device)) throw new Error("Device label hanya boleh huruf kecil, angka, _ atau -.");
  return { name, icon: form.elements.icon.value.trim() || "📊", device };
}

function submitDashDialog(form) {
  const { name, icon, device } = readDashForm(form);
  const cfg = home.editing;
  if (cfg) {
    const next = { ...clone(cfg), name, icon };
    if (cfg.kind !== "link") {
      const oldDevice = cfg.device;
      next.device = device;
      if (oldDevice && device && oldDevice !== device) {
        next.widgets = (next.widgets || []).map((w) => (w.device === oldDevice ? { ...w, device } : w));
      }
    }
    commit(next, "Tersimpan");
    return;
  }
  const id = uniqueId(name);
  const fromLogger = form.elements.template.value === "logger";
  const dev = device || (fromLogger ? "logger" : "");
  const widgets = fromLogger ? clone(LOGGER_WIDGETS).map((w) => ({ ...w, device: dev })) : [];
  const next = { id, kind: "builder", name, icon, device: dev, onlineS: 60, refreshS: 5, historyS: 30, order: Date.now(), widgets };
  saveDashboard(next);
  location.href = `dash/?id=${encodeURIComponent(id)}${widgets.length ? "" : "&edit=1"}`;
}

/* ---------- Export / import ---------- */

function exportAll() {
  const data = { app: "phantom-hub", version: 1, exportedAt: new Date().toISOString(), dashboards: listDashboards() };
  downloadFile(`phantom-hub-${fmtWib(Date.now()).slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
}

async function importAll(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = data.app === "phantom-hub-dashboard" ? [data.dashboard] : data.dashboards;
    if (!Array.isArray(list) || !list.length) throw new Error("tidak ada dashboard di file");
    const valid = list.filter((c) => c && ID_RE.test(String(c.id || "")) && (c.kind === "builder" || c.kind === "link"));
    if (!valid.length) throw new Error("format tidak dikenal");
    if (!confirm(`Import ${valid.length} dashboard? Dashboard dengan id yang sama akan ditimpa.`)) return;
    for (const cfg of valid) await commit(cfg, `Mengimpor "${cfg.name}"…`);
    toast(`${valid.length} dashboard diimpor`);
  } catch (e) {
    toast(`Gagal import JSON: ${e.message}`, true);
  }
}

/* ---------- Pengaturan & awal ---------- */

function openSettings() {
  const form = $("#settings-form");
  const look = loadLook();
  form.elements.theme.value = look.theme;
  form.elements.mode.value = look.mode;
  $("#set-token").value = getToken();
  $("#settings").returnValue = "";
  $("#settings").showModal();
}

async function applySettings() {
  const form = $("#settings-form");
  saveLook(form.elements.theme.value, form.elements.mode.value);
  const token = $("#set-token").value.trim();
  if (token && token !== getToken()) {
    try {
      await verifyToken(token);
      setToken(token);
      toast("Token diperbarui");
      start();
    } catch (e) {
      toast(errorText(e), true);
    }
  } else {
    toast("Pengaturan disimpan");
  }
}

function showLogin() {
  clearTimeout(home.timer);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-token").value = "";
}

async function start() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderGrid();
  const { changed } = await syncCloud();
  if (changed) renderGrid();
  refreshStatuses();
}

function bindEvents() {
  bindLogin(start);
  $("#open-settings").addEventListener("click", openSettings);
  $("#add-dashboard").addEventListener("click", () => openDashDialog(null));
  $("#restore-builtins").addEventListener("click", restoreBuiltins);
  $("#export-all").addEventListener("click", exportAll);
  $("#import-all").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importAll(file);
    e.target.value = "";
  });
  $("#settings").addEventListener("close", () => {
    if ($("#settings").returnValue === "save") applySettings();
    else applyLook(loadLook().theme, loadLook().mode);
  });
  $("#logout").addEventListener("click", () => {
    if (!confirm("Logout dan hapus token Ubidots dari browser ini? (Berlaku juga untuk dashboard Robot)")) return;
    clearToken();
    $("#settings").close();
    setCloud("local");
    showLogin();
  });
  $("#dash-form").addEventListener("submit", (e) => {
    if (!e.submitter || e.submitter.value !== "save") return;
    try {
      submitDashDialog(e.target);
    } catch (err) {
      e.preventDefault();
      $("#dash-error").textContent = err.message;
      $("#dash-error").hidden = false;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && getToken() && !$("#app").hidden) refreshStatuses();
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
  else showLogin();
}

init();
