"use strict";
// Umbrel Wine launcher UI. Vanilla JS, no build step. Every URL is relative
// (api/..., desktop/) so the page works behind any path prefix.

const LS_DRIVE = "umbrel-wine.drive";
const LS_SIDEBAR = "umbrel-wine.sidebar";
const POLL_MS = 2000;
// A Run button stays disabled this long after a click, so a double-click
// (whose second click lands after the fast request finished) starts one copy.
const RUN_COOLDOWN_MS = 1500;
// Folders with more executables than this show the first few and a toggle.
const EXE_PREVIEW = 5;
const NARROW = window.matchMedia("(max-width: 700px)");

const $ = (id) => document.getElementById(id);

let drives = [];
let current = localStorage.getItem(LS_DRIVE) || "main";
let pollTimer = null;
let uploading = false;
const uploadQueue = [];
// Keys (see el) of actions whose request is in flight; their buttons render disabled.
const pending = new Set();
// "<drive>/<folder>" of folders whose full executable list is shown.
const expanded = new Set();

// ---------------------------------------------------------------- helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "key") node.dataset.key = v; // identifies the control across re-renders
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node[k] = v;
  }
  if (props.key && pending.has(props.key)) node.disabled = true;
  for (const c of children) node.append(c);
  return node;
}

function humanSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function driveUrl(name, suffix = "") {
  return `api/drives/${encodeURIComponent(name)}${suffix}`;
}

// Never throws: a network failure (launcher restarting, connection lost) is
// returned like an HTTP error, so every caller's `if (!r.ok)` reports it.
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  let text;
  try {
    res = await fetch(url, opts);
    // Always read the body, even for 204: an unread response shows up in
    // DevTools as a failed (ERR_ABORTED) request.
    text = await res.text();
  } catch {
    return { ok: false, status: 0, data: { message: "Could not reach the launcher. Check your connection and try again." } };
  }
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

// Run `fn` with the control `key` disabled (across re-renders) until it
// settles and at least `minMs` have passed; a second call meanwhile is ignored.
async function busy(key, fn, minMs = 0) {
  if (pending.has(key)) return;
  pending.add(key);
  rerender();
  try {
    await Promise.all([fn(), sleep(minMs)]);
  } finally {
    pending.delete(key);
    rerender();
  }
}

// ---------------------------------------------------------------- status

async function loadStatus() {
  const r = await api("GET", "api/status");
  if (!r.ok) {
    $("status-line").textContent = `Launcher unreachable: ${errorMessage(r)}`;
    setTimeout(loadStatus, 5000);
    return;
  }
  const s = r.data;
  $("status-line").textContent = `${s.arch} · ${s.backend} · ${s.wine_version || "wine version unknown"}`;
  $("warnings").replaceChildren(...s.warnings.map((w) => el("div", { class: "warning" }, w)));
  if (!s.wine_version) setTimeout(loadStatus, 5000); // still probing
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
  $("drive-reset").disabled = pending.has("drive-reset");
  $("drive-delete").disabled = pending.has("drive-delete");

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
  } else if (d && d.setup_log) {
    note.className = "muted";
    note.replaceChildren(setupLog());
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

const NOT_READY = "Available once the drive is ready";

function runButton(key, body, ready) {
  return el("button", {
    class: "primary", key, textContent: pending.has(key) ? "Starting…" : "Run",
    disabled: !ready, title: ready ? undefined : NOT_READY,
    onclick: () => busy(key, () => run(body), RUN_COOLDOWN_MS),
  });
}

function renderFiles(d) {
  const ready = d.state === "ready";
  const rows = [];
  for (const f of d.files) {
    rows.push(el("li", {},
      el("span", { class: "name", title: f.name, textContent: f.name }),
      el("span", { class: "size", textContent: humanSize(f.size) }),
      runButton(`run:${f.name}`, { file: f.name }, ready),
      el("button", { class: "danger", key: `del:${f.name}`, textContent: "Delete", onclick: () => deleteFile(`del:${f.name}`, f.name, false) }),
    ));
  }
  // Folders list the .exe files inside; each runs in its own directory.
  for (const f of d.folders) {
    rows.push(el("li", { class: "folder" },
      el("span", { class: "name", title: f.name, textContent: `📁 ${f.name}` }),
      el("span", { class: "size", textContent: `${plural(f.file_count, "file")} · ${humanSize(f.size)}` }),
      el("button", { key: `browse:${f.name}`, textContent: "Browse", onclick: () => openBrowser(`files/${f.name}`) }),
      el("button", { class: "danger", key: `delfolder:${f.name}`, textContent: "Delete", onclick: () => deleteFile(`delfolder:${f.name}`, f.name, true) }),
    ));
    if (!f.executables.length) rows.push(el("li", { class: "sub empty" }, "No .exe in this folder."));
    const id = `${d.name}/${f.name}`;
    // A preview that hides only one entry is not worth the toggle.
    const collapsible = f.executables.length > EXE_PREVIEW + 1;
    const open = !collapsible || expanded.has(id);
    for (const exe of open ? f.executables : f.executables.slice(0, EXE_PREVIEW)) {
      rows.push(el("li", { class: "sub" },
        el("span", { class: "name", title: exe, textContent: exe.slice(f.name.length + 1) }),
        runButton(`run:${exe}`, { file: exe }, ready),
      ));
    }
    if (collapsible) {
      const hidden = f.executables.length - EXE_PREVIEW;
      rows.push(el("li", { class: "sub" }, el("button", {
        class: "link more", key: `more:${f.name}`, ariaExpanded: String(open),
        textContent: open ? "Show fewer" : `Show ${hidden} more .exe files`,
        onclick: () => { if (open) expanded.delete(id); else expanded.add(id); rerender(); },
      })));
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
    runButton(`prog:${p.path}`, { program: p.path }, ready),
  )));
}

function runBadge(r) {
  if (r.running) return el("span", { class: "badge running", textContent: "running" });
  // Negative: ended by a signal, i.e. Stop / Stop all.
  if (r.exit_code < 0) return el("span", { class: "badge", title: `Signal ${-r.exit_code}`, textContent: "stopped" });
  if (r.exit_code === 0) return el("span", { class: "badge", textContent: "exited" });
  return el("span", { class: "badge failed", textContent: `exit code ${r.exit_code}` });
}

function renderRuns(d) {
  const list = $("runs");
  if (!d.runs.length) {
    list.replaceChildren(el("li", { class: "empty" }, "Nothing started from here yet."));
    return;
  }
  list.replaceChildren(...d.runs.map((r) => el("li", {},
    el("span", {
      class: "name", textContent: r.label,
      title: `${r.label}\nStarted ${new Date(r.started * 1000).toLocaleString()}`,
    }),
    runBadge(r),
    r.running ? el("button", { key: `stop:${r.id}`, textContent: "Stop", onclick: () => stopRun(r.id) }) : "",
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
  // Stopping programs mid-setup would kill wineboot (the server refuses too).
  $("stop-all").disabled = !d || d.state !== "ready" || pending.has("stop-all");
  if (!d) return;
  if (!d.files) {
    // Just switched drives: its details arrive with the next poll. Never
    // leave the previous drive's Run buttons up in the meantime.
    for (const id of ["files", "programs", "runs"]) $(id).replaceChildren(el("li", { class: "empty" }, "Loading…"));
    return;
  }
  renderFiles(d);
  renderPrograms(d);
  renderRuns(d);
  if (focused) {
    const again = document.querySelector(`[data-key="${CSS.escape(focused)}"]`);
    if (again) again.focus();
  }
}

function rerender() {
  lastRendered = "";
  render();
}

// ---------------------------------------------------------------- polling

// All drives' names and states, plus files/programs/runs for `name` only.
async function fetchDrives(name) {
  const r = await api("GET", `api/drives?drive=${encodeURIComponent(name)}`);
  return r.ok ? r.data : null;
}

async function refresh() {
  const want = current;
  const data = await fetchDrives(want);
  // A reply for the drive shown before a switch would only flash stale lists.
  if (!data || want !== current) return;
  drives = data;
  render();
  // render() fell back to main (the remembered drive is gone): load its details now.
  if (current !== want) await refresh();
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

function selectDrive(name) {
  current = name;
  localStorage.setItem(LS_DRIVE, current);
  render();
}

$("drive-select").addEventListener("change", (e) => {
  selectDrive(e.target.value);
  refresh();
});

// Same rule as the server (DRIVE_NAME_RE); "My Games" becomes "my-games".
function slugify(s) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "");
}

function driveFormHint(msg, isError = false) {
  $("drive-form-hint").textContent = msg;
  $("drive-form-hint").className = `hint ${isError ? "error" : "muted"}`;
}

function updateDriveFormHint() {
  const raw = $("drive-name").value.trim();
  const slug = slugify(raw);
  if (!raw) driveFormHint("Lowercase letters, digits and dashes, up to 32.");
  else if (!slug) driveFormHint("Use at least one letter or digit.", true);
  else if (drives.some((d) => d.name === slug)) driveFormHint(`Drive ${slug} already exists.`, true);
  else if (slug !== raw) driveFormHint(`Will be created as “${slug}”.`);
  else driveFormHint("");
}

function showDriveForm(on) {
  $("drive-form").hidden = !on;
  $("drive-new").disabled = on;
  if (on) {
    $("drive-name").value = "";
    updateDriveFormHint();
    $("drive-name").focus();
  } else {
    $("drive-new").focus();
  }
}

$("drive-new").addEventListener("click", () => showDriveForm(true));
$("drive-form-cancel").addEventListener("click", () => showDriveForm(false));
$("drive-name").addEventListener("input", updateDriveFormHint);
$("drive-name").addEventListener("keydown", (e) => { if (e.key === "Escape") showDriveForm(false); });

$("drive-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = slugify($("drive-name").value.trim());
  if (!name) { updateDriveFormHint(); return; }
  busy("drive-create", async () => {
    const submit = $("drive-form").querySelector("[type=submit]");
    submit.disabled = true;
    try {
      const r = await api("POST", "api/drives", { name });
      if (!r.ok) { driveFormHint(errorMessage(r), true); return; }
      showDriveForm(false);
      // Not selectDrive(): until the poll lists the new drive, render() would fall back to main.
      current = r.data.name;
      localStorage.setItem(LS_DRIVE, current);
      await refresh();
    } finally {
      submit.disabled = false;
    }
  });
});

$("drive-reset").addEventListener("click", () => {
  const d = current;
  if (!confirm(`Reset drive ${d}? Installed programs and settings on it are erased; uploaded files are kept.`)) return;
  busy("drive-reset", async () => {
    const r = await api("POST", driveUrl(d, "/reset"));
    if (!r.ok) alert(errorMessage(r));
    await refresh();
  });
});

$("drive-delete").addEventListener("click", () => {
  const d = current;
  if (d === "main" || !confirm(`Delete drive ${d} and all its files?`)) return;
  busy("drive-delete", async () => {
    const r = await api("DELETE", driveUrl(d));
    if (!r.ok) { alert(errorMessage(r)); return; }
    if (current === d) selectDrive("main");
    await refresh();
  });
});

// ---------------------------------------------------------------- files & runs

async function run(body) {
  const r = await api("POST", driveUrl(current, "/run"), body);
  if (!r.ok) { alert(errorMessage(r)); return; }
  // On a phone the open sidebar covers the desktop the program appears on.
  if (NARROW.matches) setCollapsed(true);
  focusDesktop();
  await refresh();
}

function deleteFile(key, name, isFolder) {
  const question = isFolder ? `Delete folder ${name} and everything in it?` : `Delete ${name} from this drive?`;
  if (!confirm(question)) return;
  const drive = current;
  busy(key, async () => {
    const r = await api("DELETE", filesUrl(drive, name));
    if (!r.ok) alert(errorMessage(r));
    await refresh();
  });
}

function stopRun(id) {
  // Disabled while the request runs; the Stop button goes away once the
  // poll shows the program ended.
  busy(`stop:${id}`, async () => {
    const r = await api("POST", `api/runs/${encodeURIComponent(id)}/stop`);
    if (!r.ok) alert(errorMessage(r));
    await refresh();
  });
}

$("stop-all").addEventListener("click", () => busy("stop-all", async () => {
  const r = await api("POST", driveUrl(current, "/stop-all"));
  if (!r.ok) alert(errorMessage(r));
  await refresh();
}));

// ---------------------------------------------------------------- log modal
// One poll chain per opened log: `gen` changes on every open and close, so a
// reply for a previous log (or a closed dialog) is dropped, and the next
// request is only scheduled after the previous one finished.

const logView = { url: null, gen: 0, timer: null };

async function loadLog(gen) {
  const url = logView.url;
  let text;
  try {
    const res = await fetch(url);
    const body = await res.text();
    if (res.ok) {
      text = body || "(no output yet)";
    } else {
      text = body;
      try { text = JSON.parse(body).message || body; } catch { /* plain text */ }
    }
  } catch (e) {
    text = `Could not load log: ${e.message}`;
  }
  if (gen !== logView.gen) return;
  const pre = $("log-text");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  logView.timer = setTimeout(() => loadLog(gen), POLL_MS);
}

function openLog(url, title) {
  clearTimeout(logView.timer);
  logView.url = url;
  const gen = ++logView.gen;
  $("log-title").textContent = title;
  $("log-title").title = title;
  $("log-download").href = `${url}?download=1`;
  $("log-text").textContent = "Loading…";
  if (!$("log-dialog").open) $("log-dialog").showModal();
  loadLog(gen);
}

$("log-close").addEventListener("click", () => $("log-dialog").close());
$("log-dialog").addEventListener("close", () => {
  clearTimeout(logView.timer);
  logView.url = null;
  logView.gen++;
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
  $("upload-error-text").textContent = msg;
  $("upload-error").hidden = !msg;
}

$("upload-error-close").addEventListener("click", () => showUploadError(""));

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

// Indeterminate bar while a dropped folder is being read.
function showScanning(count) {
  $("upload").hidden = false;
  $("upload-name").textContent = "Reading the dropped folder…";
  $("upload-progress").removeAttribute("value");
  $("upload-text").textContent = `${plural(count, "item")} found`;
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
  // Fresh data: the queue may target a drive other than the one shown.
  const d = (await fetchDrives(drive) || []).find((x) => x.name === drive);
  const exists = Boolean(d && d.files && d.files.some((f) => f.name === file.name));
  if (exists && !confirm(`${file.name} already exists on drive ${drive}. Replace it?`)) return;
  const label = `${file.name} → ${drive}`;
  showProgress(label, 0, file.size);
  const r = await xhrPut(filesUrl(drive, file.name, exists), file, file.name,
    (n) => showProgress(label, n, file.size), sidebarUpload);
  if (!r.ok && !r.aborted) showUploadError(errorMessage(r));
}

async function uploadFolder(drive, name, entries) {
  const d = (await fetchDrives(drive) || []).find((x) => x.name === drive);
  const exists = Boolean(d && d.folders && d.folders.some((f) => f.name === name));
  if (exists && !confirm(`Folder ${name} already exists on drive ${drive}. Replace it? ` +
    "The current folder stays until the new one has uploaded completely.")) return;
  const inner = entries
    .filter((e) => e.rel !== name)
    .map((e) => ({ ...e, rel: e.rel.slice(name.length + 1) }));
  const tar = buildTar(inner);
  const label = `${name}/ (${plural(inner.filter((e) => !e.dir).length, "file")}) → ${drive}`;
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

// The drop currently being read; Cancel stops it.
let scan = null;

function cancelUploads() {
  const pendingJobs = uploadQueue.length + (sidebarUpload.xhr ? 1 : 0) + (scan ? 1 : 0);
  uploadQueue.length = 0;
  if (scan) scan.cancelled = true;
  if (sidebarUpload.xhr) sidebarUpload.xhr.abort();
  if (pendingJobs) showUploadError("Upload cancelled. Nothing on the drive was changed by it.");
}

$("upload-cancel").addEventListener("click", cancelUploads);

// Leaving mid-upload aborts it, and unsaved editor changes are lost; ask first.
window.addEventListener("beforeunload", (e) => {
  if (uploading || browseUpload.active || browse.dirty) { e.preventDefault(); e.returnValue = ""; }
});

// Hidden files (.DS_Store, .git, ...) are skipped; the server refuses them.
const isHidden = (rel) => rel.split("/").some((p) => p.startsWith("."));

// Mirrors the server's split_rel_path: names Windows cannot hold (<>:"\|?*,
// control characters such as macOS's "Icon\r", a trailing dot or space).
// Uploading one would fail the whole folder, so such entries are skipped.
const WINDOWS_ILLEGAL = /[<>:"\\|?*\u0000-\u001f]/;
const MAX_PATH_CHARS = 1024;
const MAX_PATH_DEPTH = 32;
const badName = (p) => !p || /[ .]$/.test(p) || WINDOWS_ILLEGAL.test(p) || utf8.encode(p).length > 255;
const printable = (s) => s.replace(/[\u0000-\u001f]/g, "");

function skippedMessage(names) {
  const shown = names.slice(0, 5).map(printable).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return `Skipped ${plural(names.length, "item")} whose names Windows programs cannot use: ${shown}${more}.`;
}

function looseJobs(files) {
  const jobs = [];
  const rejected = [];
  const invalid = [];
  for (const file of files) {
    if (!/\.exe$/i.test(file.name)) rejected.push(file.name);
    else if (badName(file.name) || file.name.startsWith(".")) invalid.push(file.name);
    else jobs.push({ kind: "file", file });
  }
  const errors = [];
  if (rejected.length) {
    errors.push(`Only .exe files can be uploaded on their own (${rejected.join(", ")}). ` +
      "To include other files, upload the folder that contains them.");
  }
  if (invalid.length) errors.push(skippedMessage(invalid));
  if (errors.length) showUploadError(errors.join(" "));
  return jobs;
}

// Returns {jobs, skipped}: one job per top-level folder, minus hidden entries
// and entries (or anything under folders) with names the server refuses.
function folderJobs(entries) {
  const byFolder = new Map();
  const skipped = [];
  for (const e of entries) {
    if (isHidden(e.rel)) continue;
    const parts = e.rel.split("/");
    const inner = parts.slice(1).join("/");
    const bad = parts.find(badName);
    if (bad !== undefined || inner.length > MAX_PATH_CHARS || parts.length - 1 > MAX_PATH_DEPTH) {
      // Report the offending folder once, not every file under it.
      const label = bad !== undefined ? parts.slice(0, parts.indexOf(bad) + 1).join("/") : e.rel;
      if (!skipped.includes(label)) skipped.push(label);
      continue;
    }
    const top = parts[0];
    if (!byFolder.has(top)) byFolder.set(top, []);
    byFolder.get(top).push(e);
  }
  // A folder with nothing but (empty) subfolders is not worth uploading.
  const jobs = [...byFolder]
    .filter(([, list]) => list.some((e) => !e.dir))
    .map(([name, list]) => ({ kind: "folder", name, entries: list }));
  return { jobs, skipped };
}

function enqueue(jobs) {
  for (const job of jobs) uploadQueue.push({ drive: current, ...job });
  drainUploads();
}

// Loose .exe jobs plus folder jobs, with one combined message for what was left out.
function enqueueFolders(entries, emptyMessage) {
  const { jobs, skipped } = folderJobs(entries);
  const notes = [];
  if (skipped.length) notes.push(skippedMessage(skipped));
  if (!jobs.length && emptyMessage) notes.push(emptyMessage);
  if (notes.length) {
    const prev = $("upload-error").hidden ? "" : `${$("upload-error-text").textContent} `;
    showUploadError(prev + notes.join(" "));
  }
  enqueue(jobs);
}

$("pick-files").addEventListener("click", () => $("file-input").click());
$("pick-folder").addEventListener("click", () => $("folder-input").click());

$("file-input").addEventListener("change", (e) => {
  showUploadError("");
  enqueue(looseJobs([...e.target.files]));
  e.target.value = "";
});

$("folder-input").addEventListener("change", (e) => {
  showUploadError("");
  const entries = [...e.target.files].map((file) => ({ rel: file.webkitRelativePath, file }));
  enqueueFolders(entries, "That folder has no files to upload.");
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

class ScanCancelled extends Error {}

async function walkEntry(entry, prefix, out, ctx) {
  if (ctx.cancelled) throw new ScanCancelled();
  if (entry.name.startsWith(".")) return;
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) out.push({ rel, file: await entryFile(entry) });
  else if (entry.isDirectory) {
    out.push({ rel, dir: true }); // keeps empty folders a program may expect
    for (const child of await readAllEntries(entry.createReader())) await walkEntry(child, rel, out, ctx);
  }
  if (out.length % 100 === 0) showScanning(out.length);
}

const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
// dragleave also fires when moving onto a child; only leaving the zone counts.
dz.addEventListener("dragleave", (e) => { if (!dz.contains(e.relatedTarget)) dz.classList.remove("over"); });
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
  const hasFolder = items.some((i) => i.isDirectory);
  const ctx = { cancelled: false };
  if (hasFolder) { scan = ctx; showScanning(0); }
  try {
    for (const item of items) {
      if (item.isDirectory) await walkEntry(item, "", entries, ctx);
      else if (item.isFile) loose.push(await entryFile(item));
    }
  } catch (err) {
    if (!(err instanceof ScanCancelled)) showUploadError(`Could not read the dropped files: ${err.message || err}`);
    return;
  } finally {
    if (scan === ctx) scan = null;
    if (!uploading) $("upload").hidden = true;
  }
  enqueue(looseJobs(loose));
  if (hasFolder) enqueueFolders(entries, "The dropped folder has no files to upload.");
});

// Anywhere else, a dropped file would make the browser open it in this tab
// and end the session; only the drop zone accepts drops.
window.addEventListener("dragover", (e) => {
  if (!dz.contains(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; }
});
window.addEventListener("drop", (e) => { if (!dz.contains(e.target)) e.preventDefault(); });

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
  renderBrowseUpload();
}

// One upload at a time: its Cancel replaces the Upload button meanwhile.
function renderBrowseUpload() {
  $("browse-upload").hidden = !browse.path || browseUpload.active;
  $("browse-upload-cancel").hidden = !browseUpload.active;
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
  $("editor-conflict").hidden = true;
  if (!on) { browse.doc = null; browse.dirty = false; }
}

const discardOk = () => !browse.dirty || confirm("Discard your unsaved changes?");

$("editor-text").addEventListener("input", () => { browse.dirty = true; });

let saving = false;

// force: overwrite even though the file changed on disk since it was opened.
async function saveFile(force = false) {
  const doc = browse.doc;
  if (!doc || saving) return;
  saving = true;
  $("editor-save").disabled = $("editor-overwrite").disabled = true;
  try {
    const r = await api("PUT", fsUrl(browse.drive, "/text"), {
      path: doc.path, text: $("editor-text").value, encoding: doc.encoding,
      newline: doc.newline, mtime_ns: doc.mtime_ns, force,
    });
    if (browse.doc !== doc) return; // the editor was closed meanwhile
    if (r.status === 409 && r.data && r.data.error === "changed") {
      $("editor-conflict").hidden = false;
      setBrowseStatus("Not saved.", true);
      return;
    }
    if (!r.ok) { setBrowseStatus(errorMessage(r), true); return; }
    doc.mtime_ns = r.data.mtime_ns;
    browse.dirty = false;
    $("editor-conflict").hidden = true;
    setBrowseStatus(`Saved ${doc.path}.`);
    if (doc.path.startsWith("files/")) refresh();
  } finally {
    saving = false;
    $("editor-save").disabled = $("editor-overwrite").disabled = false;
  }
}

$("editor-save").addEventListener("click", () => saveFile());
$("editor-overwrite").addEventListener("click", () => saveFile(true));
$("editor-reload").addEventListener("click", () => { if (browse.doc) openFile(browse.doc.path); });

// Ctrl+S / Cmd+S saves instead of the browser's "Save page as".
$("browse-dialog").addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s" && !$("browse-editor").hidden) {
    e.preventDefault();
    saveFile();
  }
});

$("editor-close").addEventListener("click", async () => {
  if (discardOk()) await browseTo(browse.path);
});

const browseUpload = { xhr: null, cancelled: false, active: false };

$("browse-upload").addEventListener("click", () => $("browse-upload-input").click());

$("browse-upload-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (browseUpload.active || !files.length) return;
  const dir = browse.path;
  browseUpload.cancelled = false;
  browseUpload.active = true;
  renderBrowseUpload();
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
    browseUpload.active = false;
    renderBrowseUpload();
  }
  if (browse.path === dir && $("browse-dialog").open && $("browse-editor").hidden) {
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
  (!browseUpload.active || (confirm("Cancel the upload in progress?") && (cancelBrowseUpload(), true)));

$("drive-browse").addEventListener("click", () => openBrowser(""));
$("browse-close").addEventListener("click", () => { if (closeOk()) $("browse-dialog").close(); });
$("browse-dialog").addEventListener("cancel", (e) => { if (!closeOk()) e.preventDefault(); });
$("browse-dialog").addEventListener("close", () => showEditor(false));

// ---------------------------------------------------------------- desktop
// Opened before Selkies is up (right after install or a restart), the iframe
// holds nginx's 502 page; retry until the desktop answers.

const DESKTOP_RETRY_MS = 3000;

$("desktop").addEventListener("load", () => {
  const frame = $("desktop");
  let title = "";
  try { title = frame.contentDocument ? frame.contentDocument.title : ""; } catch { /* cross-origin: not an error page */ }
  const starting = /^50[234]\b/.test(title);
  $("desktop-wait").hidden = !starting;
  if (starting) setTimeout(() => frame.contentWindow.location.reload(), DESKTOP_RETRY_MS);
});

// ---------------------------------------------------------------- sidebar

function setCollapsed(collapsed) {
  document.body.classList.toggle("collapsed", collapsed);
  const label = collapsed ? "Show sidebar" : "Hide sidebar";
  const toggle = $("toggle");
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(LS_SIDEBAR, collapsed ? "collapsed" : "open");
}

$("toggle").addEventListener("click", () => setCollapsed(!document.body.classList.contains("collapsed")));

// ---------------------------------------------------------------- boot

setCollapsed(localStorage.getItem(LS_SIDEBAR) === "collapsed");
loadStatus();
refresh().then(schedulePoll);
