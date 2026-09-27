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
    else if (k === "key") node.dataset.key = v; // identifies the control across re-renders
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
  // Always read the body, even for 204: an unread response shows up in
  // DevTools as a failed (ERR_ABORTED) request.
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
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
  const setupLog = () => el("button", {
    class: "link", key: `setup-log:${d.name}`, textContent: "Setup log",
    onclick: () => openLog(driveUrl(d.name, "/setup-log"), `Setup log: ${d.name}`),
  });
  if (d && d.state === "initializing") {
    note.className = "note";
    note.replaceChildren("Preparing drive… this can take several minutes on a Raspberry Pi. ",
      ...(d.setup_log ? [setupLog()] : []));
    note.hidden = false;
  } else if (d && d.state === "error") {
    note.className = "error";
    note.replaceChildren(`${d.error_message || "This drive failed to initialise."} `,
      ...(d.setup_log ? [setupLog()] : []));
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderFiles(d) {
  const ready = d.state === "ready";
  const rows = [];
  for (const f of d.files) {
    rows.push(el("li", {},
      el("span", { class: "name", title: f.name, textContent: f.name }),
      el("span", { class: "size", textContent: humanSize(f.size) }),
      el("button", { class: "primary", key: `run:${f.name}`, textContent: "Run", disabled: !ready, onclick: () => run({ file: f.name }) }),
      el("button", { class: "danger", key: `del:${f.name}`, textContent: "Delete", onclick: () => deleteFile(f.name, false) }),
    ));
  }
  // Folders list the .exe files inside; each runs in its own directory.
  for (const f of d.folders) {
    rows.push(el("li", { class: "folder" },
      el("span", { class: "name", title: f.name, textContent: `📁 ${f.name}` }),
      el("span", { class: "size", textContent: `${f.file_count} files · ${humanSize(f.size)}` }),
      el("button", { key: `browse:${f.name}`, textContent: "Browse", onclick: () => openBrowser(`files/${f.name}`) }),
      el("button", { class: "danger", key: `delfolder:${f.name}`, textContent: "Delete", onclick: () => deleteFile(f.name, true) }),
    ));
    if (!f.executables.length) rows.push(el("li", { class: "sub empty" }, "No .exe in this folder."));
    for (const exe of f.executables) {
      rows.push(el("li", { class: "sub" },
        el("span", { class: "name", title: exe, textContent: exe.slice(f.name.length + 1) }),
        el("button", { class: "primary", key: `run:${exe}`, textContent: "Run", disabled: !ready, onclick: () => run({ file: exe }) }),
      ));
    }
  }
  if (!rows.length) rows.push(el("li", { class: "empty" }, "Upload a .exe, or a folder with a program and its files."));
  $("files").replaceChildren(...rows);
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
    el("button", { class: "primary", key: `prog:${p.path}`, textContent: "Run", disabled: !ready, onclick: () => run({ program: p.path }) }),
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
    el("button", { key: `stop:${r.id}`, textContent: "Stop", disabled: !r.running, onclick: () => stopRun(r.id) }),
    el("button", { key: `log:${r.id}`, textContent: "Log", onclick: () => openLog(`api/runs/${encodeURIComponent(r.id)}/log`, `Log: ${r.label}`) }),
  )));
}

let lastRendered = "";

function render() {
  if (!drives.some((d) => d.name === current)) current = "main";
  // The poll returns the same data most of the time; rebuilding the lists
  // anyway would drop keyboard focus and swallow clicks every 2 s.
  const snapshot = JSON.stringify([current, drives]);
  if (snapshot === lastRendered) return;
  lastRendered = snapshot;
  const focused = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.key : undefined;
  renderDriveBar();
  const d = currentDrive();
  if (!d) return;
  renderFiles(d);
  renderPrograms(d);
  renderRuns(d);
  // Stopping programs mid-setup would kill wineboot (the server refuses too).
  $("stop-all").disabled = d.state !== "ready";
  if (focused) {
    const again = document.querySelector(`[data-key="${CSS.escape(focused)}"]`);
    if (again) again.focus();
  }
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

async function deleteFile(name, isFolder) {
  const question = isFolder ? `Delete folder ${name} and everything in it?` : `Delete ${name} from this drive?`;
  if (!confirm(question)) return;
  const r = await api("DELETE", filesUrl(current, name));
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
let logUrl = null;

async function loadLog() {
  if (!logUrl) return;
  try {
    const res = await fetch(logUrl);
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

function openLog(url, title) {
  logUrl = url;
  $("log-title").textContent = title;
  $("log-text").textContent = "Loading…";
  $("log-dialog").showModal();
  loadLog();
  clearInterval(logTimer);
  logTimer = setInterval(loadLog, POLL_MS);
}

$("log-close").addEventListener("click", () => $("log-dialog").close());
$("log-dialog").addEventListener("close", () => {
  clearInterval(logTimer);
  logUrl = null;
});

// ---------------------------------------------------------------- upload
// A job is one loose .exe ({kind: "file", file}) or one folder ({kind:
// "folder", name, entries}), each entry {rel, file} or {rel, dir: true} with
// rel starting at the folder name. A folder goes up as ONE tar stream
// (buildTar), which the server unpacks into a staging folder and swaps in
// only when complete: thousands of small files are no longer slowed by
// per-request overhead, and Cancel (or closing the tab) changes nothing.

const sidebarUpload = { xhr: null }; // in-flight request, for Cancel

function showUploadError(msg) {
  const box = $("upload-error");
  box.textContent = msg;
  box.hidden = !msg;
}

function filesUrl(drive, rel, overwrite = false) {
  return driveUrl(drive, `/files/${encodeURIComponent(rel)}`) + (overwrite ? "?overwrite=1" : "");
}

// PUT `body`; `holder.xhr` is the live request while it runs, so it can be aborted.
function xhrPut(url, body, label, onProgress, holder) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    holder.xhr = xhr;
    const done = (result) => {
      if (holder.xhr === xhr) holder.xhr = null;
      resolve(result);
    };
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      done({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => done({ ok: false, status: 0, data: { message: `Upload of ${label} failed (connection lost).` } });
    xhr.onabort = () => done({ ok: false, status: 0, aborted: true, data: null });
    xhr.send(body);
  });
}

function showProgress(label, loaded, total) {
  const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 100;
  const queued = uploadQueue.length ? ` · ${uploadQueue.length} more queued` : "";
  $("upload").hidden = false;
  $("upload-name").textContent = label;
  $("upload-progress").value = pct;
  $("upload-text").textContent =
    `${pct}% · ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB${queued}`;
}

// -- tar: POSIX ustar, plus pax records for names over 100 bytes or with
// non-ASCII characters and for files over 8 GiB. The Blob only references
// the files, so nothing is copied into memory.
const utf8 = new TextEncoder();
const TAR_MAX_OCTAL = 8 ** 11 - 1;

function tarHeader(name, size, type, mtime) {
  const h = new Uint8Array(512);
  const put = (off, len, bytes) => h.set(bytes.subarray(0, len), off);
  const oct = (off, len, n) => put(off, len - 1, utf8.encode(n.toString(8).padStart(len - 1, "0")));
  put(0, 100, utf8.encode(name));
  oct(100, 8, type === "5" ? 0o755 : 0o644);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum is computed with its own field as spaces
  h[156] = type.charCodeAt(0);
  put(257, 8, utf8.encode("ustar\u000000"));
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, utf8.encode(`${sum.toString(8).padStart(6, "0")}\u0000 `));
  return h;
}

function paxRecord(key, value) {
  // "<len> key=value\n", where len counts the whole record including itself.
  const body = utf8.encode(` ${key}=${value}\n`);
  let len = body.length;
  for (;;) {
    const next = String(len).length + body.length;
    if (next === len) break;
    len = next;
  }
  return [utf8.encode(String(len)), body];
}

const pad512 = (n) => new Uint8Array((512 - (n % 512)) % 512);

function tarEntry(name, size, type, mtime) {
  const parts = [];
  const needPax = utf8.encode(name).length > 100 || /[^\x20-\x7e]/.test(name) || size > TAR_MAX_OCTAL;
  if (needPax) {
    const records = [...paxRecord("path", name), ...(size > TAR_MAX_OCTAL ? paxRecord("size", String(size)) : [])];
    const len = records.reduce((sum, r) => sum + r.length, 0);
    parts.push(tarHeader("PaxHeader", len, "x", mtime), ...records, pad512(len));
  }
  parts.push(tarHeader(needPax ? "pax-entry" : name, size > TAR_MAX_OCTAL ? 0 : size, type, mtime));
  return parts;
}

function buildTar(entries) {
  const parts = [];
  const now = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    if (e.dir) {
      parts.push(...tarEntry(`${e.rel}/`, 0, "5", now));
    } else {
      const mtime = Math.floor((e.file.lastModified || Date.now()) / 1000);
      parts.push(...tarEntry(e.rel, e.file.size, "0", mtime), e.file, pad512(e.file.size));
    }
  }
  parts.push(new Uint8Array(1024)); // end-of-archive marker
  return new Blob(parts);
}

async function uploadLoose(drive, file) {
  // Ask before sending, so replacing a large .exe does not upload it twice.
  const d = drives.find((x) => x.name === drive);
  const exists = Boolean(d && d.files.some((f) => f.name === file.name));
  if (exists && !confirm(`${file.name} already exists on this drive. Replace it?`)) return;
  const label = `${file.name} → ${drive}`;
  showProgress(label, 0, file.size);
  const r = await xhrPut(filesUrl(drive, file.name, exists), file, file.name,
    (n) => showProgress(label, n, file.size), sidebarUpload);
  if (!r.ok && !r.aborted) showUploadError(errorMessage(r));
}

async function uploadFolder(drive, name, entries) {
  const d = drives.find((x) => x.name === drive);
  const exists = Boolean(d && d.folders.some((f) => f.name === name));
  if (exists && !confirm(`Folder ${name} already exists on this drive. Replace it? ` +
    "The current folder stays until the new one has uploaded completely.")) return;
  const inner = entries
    .filter((e) => e.rel !== name)
    .map((e) => ({ ...e, rel: e.rel.slice(name.length + 1) }));
  const tar = buildTar(inner);
  const label = `${name}/ (${inner.filter((e) => !e.dir).length} files) → ${drive}`;
  const url = driveUrl(drive, `/folders/${encodeURIComponent(name)}`) + (exists ? "?replace=1" : "");
  showProgress(label, 0, tar.size);
  const r = await xhrPut(url, tar, `folder ${name}`, (n) => showProgress(label, n, tar.size), sidebarUpload);
  if (!r.ok && !r.aborted) showUploadError(`Upload of folder ${name} failed: ${errorMessage(r)}`);
}

async function drainUploads() {
  if (uploading) return;
  uploading = true;
  try {
    while (uploadQueue.length) {
      const job = uploadQueue.shift();
      if (job.kind === "file") await uploadLoose(job.drive, job.file);
      else await uploadFolder(job.drive, job.name, job.entries);
      await refresh();
    }
  } finally {
    uploading = false;
    $("upload").hidden = true;
  }
}

function cancelUploads() {
  const pending = uploadQueue.length + (sidebarUpload.xhr ? 1 : 0);
  uploadQueue.length = 0;
  if (sidebarUpload.xhr) sidebarUpload.xhr.abort();
  if (pending) showUploadError("Upload cancelled. Nothing on the drive was changed by it.");
}

$("upload-cancel").addEventListener("click", cancelUploads);

// Leaving mid-upload aborts it; ask first.
window.addEventListener("beforeunload", (e) => {
  if (uploading || browseUpload.xhr) { e.preventDefault(); e.returnValue = ""; }
});

// Hidden files (.DS_Store, .git, ...) are skipped; the server refuses them.
const isHidden = (rel) => rel.split("/").some((p) => p.startsWith("."));

function looseJobs(files) {
  const jobs = [];
  const rejected = [];
  for (const file of files) {
    if (/\.exe$/i.test(file.name)) jobs.push({ kind: "file", file });
    else rejected.push(file.name);
  }
  if (rejected.length) {
    showUploadError(`Only .exe files can be uploaded on their own (${rejected.join(", ")}). ` +
      "To include other files, upload the folder that contains them.");
  }
  return jobs;
}

function folderJobs(entries) {
  const byFolder = new Map();
  for (const e of entries) {
    if (isHidden(e.rel)) continue;
    const top = e.rel.split("/")[0];
    if (!byFolder.has(top)) byFolder.set(top, []);
    byFolder.get(top).push(e);
  }
  // A folder with nothing but (empty) subfolders is not worth uploading.
  return [...byFolder]
    .filter(([, list]) => list.some((e) => !e.dir))
    .map(([name, list]) => ({ kind: "folder", name, entries: list }));
}

function enqueue(jobs) {
  for (const job of jobs) uploadQueue.push({ drive: current, ...job });
  drainUploads();
}

$("file-input").addEventListener("change", (e) => {
  showUploadError("");
  enqueue(looseJobs([...e.target.files]));
  e.target.value = "";
});

$("folder-input").addEventListener("change", (e) => {
  showUploadError("");
  const entries = [...e.target.files].map((file) => ({ rel: file.webkitRelativePath, file }));
  const jobs = folderJobs(entries);
  if (!jobs.length) showUploadError("That folder has no files to upload.");
  enqueue(jobs);
  e.target.value = "";
});

function readAllEntries(reader) {
  // readEntries returns batches (about 100 in Chrome) until an empty one.
  return new Promise((resolve, reject) => {
    const out = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(out);
      else { out.push(...batch); step(); }
    }, reject);
    step();
  });
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

async function walkEntry(entry, prefix, out) {
  if (entry.name.startsWith(".")) return;
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) out.push({ rel, file: await entryFile(entry) });
  else if (entry.isDirectory) {
    out.push({ rel, dir: true }); // keeps empty folders a program may expect
    for (const child of await readAllEntries(entry.createReader())) await walkEntry(child, rel, out);
  }
}

const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", async (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  showUploadError("");
  // Entries must be taken synchronously; the DataTransfer empties after await.
  const items = [...e.dataTransfer.items]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!items.length) { enqueue(looseJobs([...e.dataTransfer.files])); return; }
  const loose = [];
  const entries = [];
  try {
    for (const item of items) {
      if (item.isDirectory) await walkEntry(item, "", entries);
      else if (item.isFile) loose.push(await entryFile(item));
    }
  } catch (err) {
    showUploadError(`Could not read the dropped files: ${err.message || err}`);
    return;
  }
  const folders = folderJobs(entries);
  if (items.some((i) => i.isDirectory) && !folders.length) showUploadError("The dropped folder has no files to upload.");
  enqueue([...looseJobs(loose), ...folders]);
});

// ---------------------------------------------------------------- file browser
// Browses the drive's own directory: files/ (uploads) and prefix/ (the Wine
// prefix: drive_c, registry files). Paths are relative to the drive.

const browse = { drive: null, path: "", names: new Set(), doc: null, dirty: false };
const PROTECTED = new Set(["files", "prefix"]);
const HINTS = {
  "": "files holds your uploads. prefix is the Wine environment: prefix/drive_c is the C: drive, and system.reg / user.reg are the registry.",
  "prefix": "drive_c is this drive's C: drive. system.reg, user.reg and userdef.reg are the registry (Wine's regedit edits them too).",
};
const ENCODINGS = {
  "utf-8": "UTF-8", "utf-8-bom": "UTF-8 with BOM", "utf-16-le": "UTF-16 LE",
  "utf-16-be": "UTF-16 BE", "cp1252": "Windows-1252", "latin-1": "Latin-1",
};

function fsUrl(drive, endpoint, params = {}) {
  return driveUrl(drive, `/fs${endpoint}?${new URLSearchParams(params)}`);
}

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

function setBrowseStatus(msg, isError = false) {
  const s = $("browse-status");
  s.textContent = msg;
  s.className = isError ? "error" : "muted";
}

async function openBrowser(path = "") {
  browse.drive = current;
  setBrowseStatus("");
  $("browse-dialog").showModal();
  await browseTo(path);
}

async function browseTo(path) {
  const r = await api("GET", fsUrl(browse.drive, "/list", { path }));
  if (!r.ok) {
    setBrowseStatus(errorMessage(r), true);
    if (path) return browseTo(""); // e.g. the folder was deleted meanwhile
    return;
  }
  browse.path = r.data.path;
  browse.names = new Set(r.data.entries.map((e) => e.name));
  showEditor(false);
  renderCrumbs();
  renderEntries(r.data);
}

function renderCrumbs() {
  $("browse-title").textContent = `Files on drive ${browse.drive}`;
  const parts = browse.path ? browse.path.split("/") : [];
  const crumbs = [el("button", { class: "crumb", textContent: browse.drive, onclick: () => browseTo("") })];
  parts.forEach((p, i) => {
    crumbs.push(el("span", { class: "sep", textContent: "/" }),
      el("button", { class: "crumb", textContent: p, onclick: () => browseTo(parts.slice(0, i + 1).join("/")) }));
  });
  $("browse-crumbs").replaceChildren(...crumbs);
  $("browse-upload").hidden = !browse.path;
}

function renderEntries(listing) {
  const hint = HINTS[browse.path];
  $("browse-hint").textContent = hint || "";
  $("browse-hint").hidden = !hint;
  const rows = listing.entries.map((e) => {
    const path = joinPath(browse.path, e.name);
    let name;
    if (e.type === "dir") {
      name = el("button", { class: "link", title: path, textContent: `📁 ${e.name}`, onclick: () => browseTo(path) });
    } else if (e.type === "file") {
      name = el("button", { class: "link", title: `Open ${path}`, textContent: `📄 ${e.name}`, onclick: () => openFile(path) });
    } else {
      name = el("span", { class: "muted", title: "Points outside this drive", textContent: `🔗 ${e.name}` });
    }
    return el("li", {},
      el("span", { class: "name" }, name),
      el("span", { class: "size", textContent: e.type === "file" ? humanSize(e.size) : "" }),
      e.type === "file" ? el("button", { textContent: "Download", onclick: () => download(path) }) : "",
      PROTECTED.has(path) ? "" : el("button", {
        class: "danger", textContent: "Delete",
        onclick: () => fsDelete(path, e.type === "dir" && !e.link),
      }),
    );
  });
  if (!rows.length) rows.push(el("li", { class: "empty" }, "This folder is empty."));
  if (listing.truncated) rows.push(el("li", { class: "empty" }, "Only the first 5000 entries are shown."));
  $("browse-list").replaceChildren(...rows);
}

function download(path) {
  const a = el("a", { href: fsUrl(browse.drive, "/download", { path }), download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}

async function fsDelete(path, isDir) {
  if (!confirm(`Delete ${path}${isDir ? " and everything in it" : ""}?`)) return;
  const r = await api("DELETE", fsUrl(browse.drive, "", { path }));
  if (!r.ok) { setBrowseStatus(errorMessage(r), true); return; }
  await browseTo(browse.path);
  setBrowseStatus(`Deleted ${path}.`);
  if (path.startsWith("files/")) refresh();
}

async function openFile(path) {
  const r = await api("GET", fsUrl(browse.drive, "/text", { path }));
  if (r.status === 413 || r.status === 415) {
    if (confirm(`${errorMessage(r)}\n\nDownload ${path}?`)) download(path);
    return;
  }
  if (!r.ok) { setBrowseStatus(errorMessage(r), true); return; }
  showEditor(true);
  browse.doc = r.data;
  browse.dirty = false;
  $("editor-path").textContent = path;
  $("editor-meta").textContent =
    `${ENCODINGS[r.data.encoding] || r.data.encoding} · ${r.data.newline === "\r\n" ? "CRLF" : "LF"} · ${humanSize(r.data.size)}`;
  $("editor-note").hidden = !/\.reg$/i.test(path);
  $("editor-text").value = r.data.text;
  $("editor-text").focus();
  setBrowseStatus("");
}

function showEditor(on) {
  $("browse-list-view").hidden = on;
  $("browse-editor").hidden = !on;
  if (!on) { browse.doc = null; browse.dirty = false; }
}

const discardOk = () => !browse.dirty || confirm("Discard your unsaved changes?");

$("editor-text").addEventListener("input", () => { browse.dirty = true; });

$("editor-save").addEventListener("click", async () => {
  const doc = browse.doc;
  if (!doc) return;
  const r = await api("PUT", fsUrl(browse.drive, "/text"), {
    path: doc.path, text: $("editor-text").value, encoding: doc.encoding, newline: doc.newline, mtime_ns: doc.mtime_ns,
  });
  if (!r.ok) { setBrowseStatus(errorMessage(r), true); return; }
  doc.mtime_ns = r.data.mtime_ns;
  browse.dirty = false;
  setBrowseStatus(`Saved ${doc.path}.`);
  if (doc.path.startsWith("files/")) refresh();
});

$("editor-close").addEventListener("click", async () => {
  if (discardOk()) await browseTo(browse.path);
});

const browseUpload = { xhr: null, cancelled: false };

$("browse-upload-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const dir = browse.path;
  browseUpload.cancelled = false;
  $("browse-upload-cancel").hidden = false;
  try {
    for (const file of files) {
      if (browseUpload.cancelled) break;
      // Ask before sending, so a replaced file is not uploaded twice.
      const exists = browse.names.has(file.name);
      if (exists && !confirm(`${file.name} already exists in this folder. Replace it?`)) continue;
      const params = { path: dir, name: file.name, ...(exists ? { overwrite: "1" } : {}) };
      const r = await xhrPut(fsUrl(browse.drive, "/upload", params), file, file.name,
        (n) => setBrowseStatus(`Uploading ${file.name}: ${Math.floor((n / Math.max(file.size, 1)) * 100)}%`),
        browseUpload);
      if (r.aborted) { setBrowseStatus("Upload cancelled; the file was not changed."); break; }
      if (!r.ok) { setBrowseStatus(errorMessage(r), true); break; }
      setBrowseStatus(`Uploaded ${file.name}.`);
    }
  } finally {
    $("browse-upload-cancel").hidden = true;
  }
  if (browse.path === dir) {
    const status = $("browse-status").textContent;
    const isError = $("browse-status").className === "error";
    await browseTo(dir);
    setBrowseStatus(status, isError);
  }
  if (dir.startsWith("files")) refresh();
});

function cancelBrowseUpload() {
  browseUpload.cancelled = true;
  if (browseUpload.xhr) browseUpload.xhr.abort();
}

$("browse-upload-cancel").addEventListener("click", cancelBrowseUpload);

// Closing the dialog cancels an upload in progress (after asking), since its
// Cancel button would no longer be reachable.
const closeOk = () => discardOk() &&
  (!browseUpload.xhr || (confirm("Cancel the upload in progress?") && (cancelBrowseUpload(), true)));

$("drive-browse").addEventListener("click", () => openBrowser(""));
$("browse-close").addEventListener("click", () => { if (closeOk()) $("browse-dialog").close(); });
$("browse-dialog").addEventListener("cancel", (e) => { if (!closeOk()) e.preventDefault(); });
$("browse-dialog").addEventListener("close", () => showEditor(false));

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
