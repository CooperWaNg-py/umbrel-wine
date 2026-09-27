"use strict";
// Umbrel Wine launcher UI. Vanilla JS, no build step. Every URL is relative
// (api/..., desktop/) so the page works behind any path prefix.

const LS_DRIVE = "umbrel-wine.drive";
const LS_SIDEBAR = "umbrel-wine.sidebar";
const POLL_MS = 2000;

const $ = (id) => document.getElementById(id);

let drives = [];
let current = localStorage.getItem(LS_DRIVE) || "main";
let pollTimer = null;
let uploading = false;
const uploadQueue = [];

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

function humanSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

function driveUrl(name, suffix = "") {
  return `api/drives/${encodeURIComponent(name)}${suffix}`;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  }
  return { ok: res.ok, status: res.status, data };
}

function errorMessage(r) {
  return (r.data && r.data.message) || `Request failed (HTTP ${r.status})`;
}

function currentDrive() {
  return drives.find((d) => d.name === current);
}

function focusDesktop() {
  $("desktop").focus();
}

// ---------------------------------------------------------------- status

async function loadStatus() {
  try {
    const r = await api("GET", "api/status");
    if (!r.ok) throw new Error(errorMessage(r));
    const s = r.data;
    $("status-line").textContent = `${s.arch} · ${s.backend} · ${s.wine_version || "wine version unknown"}`;
    const box = $("warnings");
    box.replaceChildren(...s.warnings.map((w) => el("div", { class: "warning" }, w)));
    if (!s.wine_version) setTimeout(loadStatus, 5000); // still probing
  } catch (e) {
    $("status-line").textContent = `Launcher unreachable: ${e.message}`;
    setTimeout(loadStatus, 5000);
  }
}

// ---------------------------------------------------------------- render

function renderDriveBar() {
  const select = $("drive-select");
  const names = drives.map((d) => d.name);
  if ([...select.options].map((o) => o.value).join("\n") !== names.join("\n")) {
    select.replaceChildren(...names.map((n) => el("option", { value: n, textContent: n })));
  }
  select.value = current;

  const d = currentDrive();
  const badge = $("drive-badge");
  badge.className = `badge ${d ? d.state : ""}`;
  badge.textContent = d ? d.state : "";
  $("drive-delete").hidden = current === "main";

  const note = $("drive-note");
  if (d && d.state === "initializing") {
    note.className = "note";
    note.textContent = "Preparing drive… this can take several minutes on a Raspberry Pi";
    note.hidden = false;
  } else if (d && d.state === "error") {
    note.className = "error";
    note.textContent = d.error_message || "This drive failed to initialise.";
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderFiles(d) {
  const ready = d.state === "ready";
  const list = $("files");
  if (!d.files.length) {
    list.replaceChildren(el("li", { class: "empty" }, "Upload a .exe to run it on this drive."));
    return;
  }
  list.replaceChildren(...d.files.map((f) => el("li", {},
    el("span", { class: "name", title: f.name, textContent: f.name }),
    el("span", { class: "size", textContent: humanSize(f.size) }),
    el("button", { class: "primary", textContent: "Run", disabled: !ready, onclick: () => run({ file: f.name }) }),
    el("button", { class: "danger", textContent: "Delete", onclick: () => deleteFile(f.name) }),
  )));
}

function renderPrograms(d) {
  const ready = d.state === "ready";
  const list = $("programs");
  if (!d.programs.length) {
    list.replaceChildren(el("li", { class: "empty" }, "Programs you install on this drive appear here."));
    return;
  }
  list.replaceChildren(...d.programs.map((p) => el("li", {},
    el("span", { class: "name", title: p.path, textContent: p.name }),
    el("button", { class: "primary", textContent: "Run", disabled: !ready, onclick: () => run({ program: p.path }) }),
  )));
}

function renderRuns(d) {
  const list = $("runs");
  if (!d.runs.length) {
    list.replaceChildren(el("li", { class: "empty" }, "Nothing started from here yet."));
    return;
  }
  list.replaceChildren(...d.runs.map((r) => el("li", {},
    el("span", { class: "name", title: r.label, textContent: r.label }),
    r.running
      ? el("span", { class: "badge running", textContent: "running" })
      : el("span", { class: "badge", textContent: `exited ${r.exit_code}` }),
    el("button", { textContent: "Stop", disabled: !r.running, onclick: () => stopRun(r.id) }),
    el("button", { textContent: "Log", onclick: () => openLog(r) }),
  )));
}

function render() {
  if (!drives.some((d) => d.name === current)) current = "main";
  renderDriveBar();
  const d = currentDrive();
  if (!d) return;
  renderFiles(d);
  renderPrograms(d);
  renderRuns(d);
}

// ---------------------------------------------------------------- polling

async function refresh() {
  try {
    const r = await api("GET", "api/drives");
    if (r.ok) { drives = r.data; render(); }
  } catch { /* transient; next poll retries */ }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  pollTimer = setTimeout(async () => { await refresh(); schedulePoll(); }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { refresh(); schedulePoll(); } else clearTimeout(pollTimer);
});

// ---------------------------------------------------------------- drives

$("drive-select").addEventListener("change", (e) => {
  current = e.target.value;
  localStorage.setItem(LS_DRIVE, current);
  render();
});

$("drive-new").addEventListener("click", async () => {
  const name = prompt("Name for the new drive (lowercase letters, digits and dashes):");
  if (!name) return;
  const r = await api("POST", "api/drives", { name: name.trim() });
  if (r.status === 400) { alert("Use lowercase letters, digits and dashes (max 32)"); return; }
  if (!r.ok) { alert(errorMessage(r)); return; }
  current = r.data.name;
  localStorage.setItem(LS_DRIVE, current);
  await refresh();
});

$("drive-reset").addEventListener("click", async () => {
  const d = current;
  if (!confirm(`Reset drive ${d}? Installed programs and settings on it are erased; uploaded files are kept.`)) return;
  const r = await api("POST", driveUrl(d, "/reset"));
  if (!r.ok) alert(errorMessage(r));
  await refresh();
});

$("drive-delete").addEventListener("click", async () => {
  const d = current;
  if (d === "main" || !confirm(`Delete drive ${d} and all its files?`)) return;
  const r = await api("DELETE", driveUrl(d));
  if (!r.ok) { alert(errorMessage(r)); return; }
  current = "main";
  localStorage.setItem(LS_DRIVE, current);
  await refresh();
});

// ---------------------------------------------------------------- files & runs

async function run(body) {
  const r = await api("POST", driveUrl(current, "/run"), body);
  if (!r.ok) { alert(errorMessage(r)); return; }
  focusDesktop();
  await refresh();
}

async function deleteFile(name) {
  if (!confirm(`Delete ${name} from this drive?`)) return;
  const r = await api("DELETE", driveUrl(current, `/files/${encodeURIComponent(name)}`));
  if (!r.ok) alert(errorMessage(r));
  await refresh();
}

async function stopRun(id) {
  const r = await api("POST", `api/runs/${encodeURIComponent(id)}/stop`);
  if (!r.ok) alert(errorMessage(r));
  await refresh();
}

$("stop-all").addEventListener("click", async () => {
  const r = await api("POST", driveUrl(current, "/stop-all"));
  if (!r.ok) alert(errorMessage(r));
  await refresh();
});

// ---------------------------------------------------------------- log modal

let logTimer = null;
let logRunId = null;

async function loadLog() {
  if (!logRunId) return;
  try {
    const res = await fetch(`api/runs/${encodeURIComponent(logRunId)}/log`);
    const text = await res.text();
    const pre = $("log-text");
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).message; } catch { /* plain text */ }
      pre.textContent = msg;
    } else {
      pre.textContent = text || "(no output yet)";
    }
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    $("log-text").textContent = `Could not load log: ${e.message}`;
  }
}

function openLog(r) {
  logRunId = r.id;
  $("log-title").textContent = `Log: ${r.label}`;
  $("log-text").textContent = "Loading…";
  $("log-dialog").showModal();
  loadLog();
  clearInterval(logTimer);
  logTimer = setInterval(loadLog, POLL_MS);
}

$("log-close").addEventListener("click", () => $("log-dialog").close());
$("log-dialog").addEventListener("close", () => {
  clearInterval(logTimer);
  logRunId = null;
});

// ---------------------------------------------------------------- upload

function showUploadError(msg) {
  const box = $("upload-error");
  box.textContent = msg;
  box.hidden = !msg;
}

function putFile(drive, file, overwrite) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const url = driveUrl(drive, `/files/${encodeURIComponent(file.name)}`) + (overwrite ? "?overwrite=1" : "");
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.floor((e.loaded / e.total) * 100);
      $("upload-progress").value = pct;
      $("upload-text").textContent =
        `${pct}% · ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`;
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: { message: `Upload of ${file.name} failed (connection lost).` } });
    xhr.send(file);
  });
}

async function uploadOne(drive, file) {
  $("upload").hidden = false;
  $("upload-name").textContent = `${file.name} → ${drive}`;
  $("upload-progress").value = 0;
  $("upload-text").textContent = "";
  let r = await putFile(drive, file, false);
  if (r.status === 409 && confirm(`${file.name} already exists on this drive. Replace it?`)) {
    r = await putFile(drive, file, true);
  } else if (r.status === 409) {
    return;
  }
  if (!r.ok) showUploadError(errorMessage(r));
}

async function drainUploads() {
  if (uploading) return;
  uploading = true;
  try {
    while (uploadQueue.length) {
      const { drive, file } = uploadQueue.shift();
      await uploadOne(drive, file);
      await refresh();
    }
  } finally {
    uploading = false;
    $("upload").hidden = true;
  }
}

function enqueueFiles(fileList) {
  showUploadError("");
  for (const file of fileList) uploadQueue.push({ drive: current, file });
  drainUploads();
}

$("file-input").addEventListener("change", (e) => {
  enqueueFiles([...e.target.files]);
  e.target.value = "";
});

const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  enqueueFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------- sidebar

function setCollapsed(collapsed) {
  document.body.classList.toggle("collapsed", collapsed);
  $("toggle-open").hidden = !collapsed;
  localStorage.setItem(LS_SIDEBAR, collapsed ? "collapsed" : "open");
}

$("toggle").addEventListener("click", () => setCollapsed(true));
$("toggle-open").addEventListener("click", () => setCollapsed(false));

// ---------------------------------------------------------------- boot

setCollapsed(localStorage.getItem(LS_SIDEBAR) === "collapsed");
loadStatus();
refresh().then(schedulePoll);
