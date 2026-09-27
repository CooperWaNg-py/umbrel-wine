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
  const rows = [];
  for (const f of d.files) {
    rows.push(el("li", {},
      el("span", { class: "name", title: f.name, textContent: f.name }),
      el("span", { class: "size", textContent: humanSize(f.size) }),
      el("button", { class: "primary", textContent: "Run", disabled: !ready, onclick: () => run({ file: f.name }) }),
      el("button", { class: "danger", textContent: "Delete", onclick: () => deleteFile(f.name, false) }),
    ));
  }
  // Folders list the .exe files inside; each runs in its own directory.
  for (const f of d.folders) {
    rows.push(el("li", { class: "folder" },
      el("span", { class: "name", title: f.name, textContent: `📁 ${f.name}` }),
      el("span", { class: "size", textContent: `${f.file_count} files · ${humanSize(f.size)}` }),
      el("button", { textContent: "Browse", onclick: () => openBrowser(`files/${f.name}`) }),
      el("button", { class: "danger", textContent: "Delete", onclick: () => deleteFile(f.name, true) }),
    ));
    if (!f.executables.length) rows.push(el("li", { class: "sub empty" }, "No .exe in this folder."));
    for (const exe of f.executables) {
      rows.push(el("li", { class: "sub" },
        el("span", { class: "name", title: exe, textContent: exe.slice(f.name.length + 1) }),
        el("button", { class: "primary", textContent: "Run", disabled: !ready, onclick: () => run({ file: exe }) }),
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
// A job is one loose .exe ({kind: "file", file}) or one folder ({kind:
// "folder", name, entries: [{rel, file}]}) whose files keep their paths
// below the drive's files/ ("Game/bin/game.exe").

const FOLDER_PARALLEL = 3;

function showUploadError(msg) {
  const box = $("upload-error");
  box.textContent = msg;
  box.hidden = !msg;
}

function filesUrl(drive, rel, overwrite = false) {
  return driveUrl(drive, `/files/${encodeURIComponent(rel)}`) + (overwrite ? "?overwrite=1" : "");
}

function xhrPut(url, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* empty */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: { message: `Upload of ${file.name} failed (connection lost).` } });
    xhr.send(file);
  });
}

function showProgress(label, loaded, total) {
  const pct = total ? Math.min(100, Math.floor((loaded / total) * 100)) : 100;
  $("upload").hidden = false;
  $("upload-name").textContent = label;
  $("upload-progress").value = pct;
  $("upload-text").textContent =
    `${pct}% · ${(loaded / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`;
}

async function uploadLoose(drive, file) {
  const progress = (n) => showProgress(`${file.name} → ${drive}`, n, file.size);
  progress(0);
  let r = await xhrPut(filesUrl(drive, file.name), file, progress);
  if (r.status === 409) {
    if (!confirm(`${file.name} already exists on this drive. Replace it?`)) return;
    r = await xhrPut(filesUrl(drive, file.name, true), file, progress);
  }
  if (!r.ok) showUploadError(errorMessage(r));
}

async function uploadFolder(drive, name, entries) {
  const d = drives.find((x) => x.name === drive);
  if (d && d.folders.some((f) => f.name === name)) {
    if (!confirm(`Folder ${name} already exists on this drive. Replace it? The existing folder is deleted first.`)) return;
    const r = await api("DELETE", filesUrl(drive, name));
    if (!r.ok && r.status !== 404) { showUploadError(errorMessage(r)); return; }
  }
  const total = entries.reduce((sum, e) => sum + e.file.size, 0);
  const label = `${name}/ (${entries.length} files) → ${drive}`;
  const inflight = new Map();
  let doneBytes = 0;
  let next = 0;
  let failed = null;
  const report = () => showProgress(label, doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0), total);
  // A few requests at once: folders are often thousands of small files.
  async function worker() {
    while (!failed && next < entries.length) {
      const { rel, file } = entries[next++];
      inflight.set(rel, 0);
      const r = await xhrPut(filesUrl(drive, rel), file, (n) => { inflight.set(rel, n); report(); });
      inflight.delete(rel);
      if (!r.ok) { failed = failed || `${rel}: ${errorMessage(r)}`; return; }
      doneBytes += file.size;
      report();
    }
  }
  report();
  await Promise.all(Array.from({ length: Math.min(FOLDER_PARALLEL, entries.length) }, worker));
  if (failed) showUploadError(`Upload of folder ${name} stopped. ${failed}`);
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
  return [...byFolder].map(([name, list]) => ({ kind: "folder", name, entries: list }));
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

const browse = { drive: null, path: "", doc: null, dirty: false };
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

$("browse-upload-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const dir = browse.path;
  for (const file of files) {
    const url = (overwrite) => fsUrl(browse.drive, "/upload",
      overwrite ? { path: dir, name: file.name, overwrite: "1" } : { path: dir, name: file.name });
    const progress = (n) => setBrowseStatus(`Uploading ${file.name}: ${Math.floor((n / Math.max(file.size, 1)) * 100)}%`);
    let r = await xhrPut(url(false), file, progress);
    if (r.status === 409) {
      if (!confirm(`${file.name} already exists in this folder. Replace it?`)) continue;
      r = await xhrPut(url(true), file, progress);
    }
    if (!r.ok) { setBrowseStatus(errorMessage(r), true); break; }
    setBrowseStatus(`Uploaded ${file.name}.`);
  }
  if (browse.path === dir) {
    const status = $("browse-status").textContent;
    const isError = $("browse-status").className === "error";
    await browseTo(dir);
    setBrowseStatus(status, isError);
  }
  if (dir.startsWith("files")) refresh();
});

$("drive-browse").addEventListener("click", () => openBrowser(""));
$("browse-close").addEventListener("click", () => { if (discardOk()) $("browse-dialog").close(); });
$("browse-dialog").addEventListener("cancel", (e) => { if (!discardOk()) e.preventDefault(); });
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
