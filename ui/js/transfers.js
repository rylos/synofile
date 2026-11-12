// Transfers: the jobs the NAS runs (copy, move, delete) and the uploads
// this page sends, one model for both. The drawer lists them; the dialog
// shows one in detail, with its speed chart.

import { api, notifyUnauth } from "./api.js";
import { prefs } from "./prefs.js";
import { t, count, LANG, LOCALE } from "./i18n.js";
import { esc, size, sizeParts, speed, duration, clock, int, baseName, parentOf, dateTime } from "./format.js";
import { svg } from "./icons.js";
import { h, $, toast, errorToast } from "./ui.js";

const jobs = new Map(); // id -> job
const local = new Map(); // uploads: id -> controller {pause, resume, cancel, answer}
let since = 0;
let pollTimer = 0;
let polling = null; // the poll in flight
let pollAgain = null; // a poll asked for while one was in flight
let pollErrors = 0; // failed polls in a row, for the backoff
let unauth = false; // the session is gone: no polling until the page is back in use
let app = null;
let firstPoll = true;
const dialogs = new Map(); // id -> dialog view
const seenFinished = new Set();
const seenConflict = new Set();
// failed jobs already shown in the drawer (a poll replaces the job objects)
const seenFail = new Set();

const OP = {
  copy: { icon: "copy", running: "Copia in corso", done: "Copia completata", verified: "Copia completata e verificata", noun: "Copia|op" },
  move: { icon: "move", running: "Spostamento in corso", done: "Spostamento completato", verified: "Spostamento completato e verificato", noun: "Spostamento" },
  delete: { icon: "trash", running: "Eliminazione in corso", done: "Eliminazione completata", noun: "Eliminazione" },
  upload: { icon: "upload", running: "Caricamento in corso", done: "Caricamento completato", noun: "Caricamento" },
  compress: { icon: "archive", running: "Compressione in corso", done: "Archivio creato", noun: "Compressione" },
  extract: { icon: "archive", running: "Estrazione in corso", done: "Estrazione completata", noun: "Estrazione" },
};
const STATE = {
  queued: "in coda", running: "in corso", paused: "in pausa", conflict: "da decidere",
  done: "completato", failed: "non riuscito", cancelled: "annullato",
};
const PHASES = {
  copy: [["scan", "Analisi"], ["copy", "Copia"], ["verify", "Verifica"], ["end", "Fine"]],
  move: [["scan", "Analisi"], ["move", "Spostamento"], ["verify", "Verifica"], ["end", "Fine"]],
  delete: [["scan", "Conteggio"], ["delete", "Eliminazione"], ["end", "Fine"]],
  upload: [["copy", "Trasmissione"], ["end", "Fine"]],
  compress: [["scan", "Analisi"], ["compress", "Compressione"], ["end", "Fine"]],
  extract: [["extract", "Estrazione"], ["end", "Fine"]],
};
const LIMITS = [0, 5, 10, 25, 50, 100, 200, 500];
// speed samples kept per job: past this the older ones are thinned out
const MAX_SAMPLES = 2400;
// the most recent samples are never thinned: the speed shown reads them
const KEEP_RECENT = 240;

export const finished = (j) => ["done", "failed", "cancelled"].includes(j.state);
// "done" where every item failed reads as a failure, with the first reason
const allFailed = (j) => j.state === "done" && j.progress.errors > 0 && j.progress.errors >= j.progress.files_done;
const shownState = (j) => (allFailed(j) ? "failed" : j.state);
const firstError = (j) => j.errors?.[0]?.msg || "";
const active = (j) => !finished(j);

export function init(theApp) {
  app = theApp;
  $("#xfer-icon").innerHTML = svg("transfers");
  $("#xfer-btn").onclick = () => toggleDrawer();
  $("#xfer-drawer-close").innerHTML = svg("close");
  $("#xfer-drawer-close").onclick = () => toggleDrawer(false);
  $("#xfer-clear").onclick = clearFinished;
  // a click outside the open drawer closes it
  addEventListener("mousedown", (e) => {
    const d = $("#xfer-drawer");
    if (!d.hidden && !d.contains(e.target) && !$("#xfer-btn").contains(e.target) && !e.target.closest("dialog")) d.hidden = true;
  }, true);
  // back in view, or back in use after the session ran out: look again now
  document.addEventListener("visibilitychange", () => !document.hidden && wake());
  addEventListener("focus", wake);
  addEventListener("synofile:auth", () => unauth && wake());
  poll();
}

/** Polls soon, also after the session ran out (DSM may have a new one). */
function wake() {
  unauth = false;
  pollErrors = 0;
  schedule(200);
}

// ---------- model ----------

function title(job) {
  const op = OP[job.op] || OP.copy;
  const n = job.info.sources.length;
  if (job.op === "upload") return t("{op} di {n}", { op: t(op.noun), n: count(job.progress.files_total || n, "file", "file", int) });
  if (n === 1) return t("{op} di «{x}»", { op: t(op.noun), x: baseName(job.info.sources[0]) });
  return t("{op} di {n}", { op: t(op.noun), n: count(n, "elemento", "elementi", int) });
}

function route(job) {
  // a remote path reads as the server's own address
  const show = (p) => (p && app?.displayPath ? app.displayPath(p) : p);
  const from = job.info.sources.length ? show(parentOf(job.info.sources[0])) : "";
  if (job.op === "delete") return { from, to: job.info.permanent ? t("eliminazione definitiva") : t("Cestino") };
  if (job.op === "upload") return { from: t("questo computer"), to: show(job.info.dest) };
  if (job.op === "extract") return { from: show(job.info.sources[0]), to: show(job.info.dest) };
  return { from, to: show(job.info.dest) };
}

/**
 * The percentage as shown: rounded down while the job runs, so it never
 * reaches 100 early nor goes back (99.5 → "100" → "99.9" looked broken);
 * one decimal below 10. 100 only once finished.
 */
function pctText(pct, done) {
  if (done && pct >= 1) return "100";
  const n = Math.min(pct * 100, 99.9);
  const one = n > 0 && n < 10;
  const v = one ? Math.floor(n * 10) / 10 : Math.floor(n);
  return v.toLocaleString(LANG, { minimumFractionDigits: one ? 1 : 0, maximumFractionDigits: one ? 1 : 0 });
}

/** Everything the views show, worked out once per update. */
export function stats(job) {
  const p = job.progress;
  const verify = job.verify && job.op !== "delete";
  const byBytes = p.bytes_total > 0 && job.op !== "delete";
  const totalWork = byBytes ? p.bytes_total * (verify ? 2 : 1) : p.files_total;
  const doneWork = byBytes ? p.bytes_done + (verify ? p.verify_bytes + (p.verify_skip || 0) : 0) : p.files_done;
  let pct = totalWork > 0 ? Math.min(1, doneWork / totalWork) : job.state === "done" ? 1 : 0;
  if (job.state === "done") pct = 1;
  const s = job.samples;
  const elapsed = job.active_ms + (job.state === "running" && job._polledAt ? Date.now() - job._polledAt : 0);
  // throughput: bytes moved plus bytes verified
  const work = (x) => (byBytes ? x[1] + x[3] : x[2]);
  const windowSpeed = (ms) => {
    if (s.length < 2) return 0;
    const last = s[s.length - 1];
    let k = s.length - 2;
    // not across a pause: the time it lasted moved nothing
    while (k > 0 && last[0] - s[k][0] < ms && s[k][0] - s[k - 1][0] < 2500) k--;
    const dt = (last[0] - s[k][0]) / 1000;
    return dt > 0 ? Math.max(0, (work(last) - work(s[k])) / dt) : 0;
  };
  const now = job.state === "running" ? windowSpeed(2500) : 0;
  const smooth = windowSpeed(10000);
  const avg = elapsed > 500 ? (doneWork / elapsed) * 1000 : 0;
  let peak = 0;
  // over about a second, however close together the samples are
  for (let i = 1, j = 0; i < s.length; i++) {
    while (j + 1 < i && s[i][0] - s[j + 1][0] >= 1000) j++;
    const dt = (s[i][0] - s[j][0]) / 1000;
    if (dt >= 0.5) peak = Math.max(peak, (work(s[i]) - work(s[j])) / dt);
  }
  const rate = smooth || avg;
  const remaining = Math.max(0, totalWork - doneWork);
  const eta = job.state === "running" && rate > 0 && !p.scanning ? (remaining / rate) * 1000 : null;
  const filesRate = elapsed > 1000 ? (p.files_done / elapsed) * 1000 : 0;
  return { pct, now, avg, peak, eta, elapsed, byBytes, verify, filesRate, totalWork, doneWork };
}

function merge(update) {
  const old = jobs.get(update.id);
  if (old) {
    // a poll from an earlier point (since=0 after Retry, one that overlapped)
    // sends samples again: only the ones after what is here count
    const end = old.samples.length ? old.samples[old.samples.length - 1][0] : -1;
    update.samples = old.samples.concat((update.samples || []).filter((x) => x[0] > end));
  }
  update.samples = thin(update.samples || []);
  update._polledAt = Date.now();
  jobs.set(update.id, update);
  return update;
}

/**
 * Keeps a job's samples under MAX_SAMPLES (the daemon's own limit): every other one of the
 * older part goes, so the start of a long transfer grows coarser and the recent part, which the
 * speed shown is read from, stays as it is. The two ends of a pause stay, or it would become a
 * slope: a sample whose gap on one side is much longer than on the other.
 */
function thin(s) {
  if (s.length <= MAX_SAMPLES) return s;
  const cut = s.length - KEEP_RECENT;
  const edge = (i) => {
    if (i === 0 || i + 1 >= s.length) return true;
    const a = s[i][0] - s[i - 1][0];
    const b = s[i + 1][0] - s[i][0];
    return Math.max(a, b) > 2000 && Math.max(a, b) > 3 * Math.min(a, b);
  };
  return s.slice(0, cut).filter((_, i) => i % 2 === 0 || edge(i)).concat(s.slice(cut));
}

/**
 * Asks the NAS what changed. One request at a time: a call while one is in
 * flight gets a fresh one right after it (the caller may wait for a job it
 * just started, which the request in flight may not know of yet).
 */
function poll() {
  if (polling) return (pollAgain ||= polling.catch(() => {}).then(() => ((pollAgain = null), poll())));
  polling = pollNow().finally(() => (polling = null));
  return polling;
}

async function pollNow() {
  clearTimeout(pollTimer);
  try {
    const data = await api.jobs(since);
    pollErrors = 0;
    since = data.now || since;
    const ids = new Set();
    for (const j of data.jobs) {
      ids.add(j.id);
      const job = merge(j);
      const newest = job.samples[job.samples.length - 1];
      job._sampleAge = data.now && job.started && newest ? data.now - job.started - newest[0] : undefined;
      onUpdate(job);
    }
    // jobs the NAS forgot (dismissed elsewhere, daemon restarted)
    for (const [id, j] of jobs) if (j.source !== "local" && !ids.has(id)) jobs.delete(id);
    if (firstPoll && new URLSearchParams(location.search).get("xfer") === "last") {
      const last = [...jobs.values()].sort((a, b) => b.created - a.created)[0];
      if (last) setTimeout(() => openDialog(last.id));
    }
    if (firstPoll) openAsked();
    firstPoll = false;
  } catch (e) {
    if (e.status === 401) {
      // the session is over: polling would only fail (and api.js already said so)
      unauth = true;
      notifyUnauth();
    } else {
      // the daemon may be restarting: keep the last state and retry, less and less often
      pollErrors++;
    }
  }
  renderAll();
  schedule();
}

/** Tells the icon in DSM's taskbar (another page, same origin) to look now. */
function nudgeTray() {
  try {
    localStorage.setItem("synofile.jobsChanged", String(Date.now()));
  } catch {}
}

/**
 * The icon in DSM's taskbar (tray.js) leaves the transfer to show here, in
 * the browser's storage: read at start, and when it changes while open.
 */
function openAsked() {
  let asked = null;
  try {
    asked = JSON.parse(localStorage.getItem("synofile.openXfer") || "null");
    localStorage.removeItem("synofile.openXfer");
  } catch {}
  if (asked && Date.now() - asked.at < 60000 && jobs.has(asked.id)) setTimeout(() => openDialog(asked.id));
}
addEventListener("storage", (e) => {
  if (e.key === "synofile.openXfer" && e.newValue) openAsked();
});

/**
 * With a running job's chart on screen, the ms until its next sample is ready on the NAS (and a
 * little more for it to be recorded): each poll then brings one new sample. Null without one.
 */
function untilNextSample() {
  let wait = null;
  for (const id of dialogs.keys()) {
    const j = jobs.get(id);
    if (!j || j.state !== "running" || j.source === "local") continue;
    const period = samplePeriod(j.samples);
    const age = (((j._sampleAge ?? 0) % period) + period) % period;
    const w = Math.min(1000, Math.max(30, period - age + 20));
    wait = wait === null ? w : Math.min(wait, w);
  }
  return wait;
}

/**
 * When to poll next. Each poll keeps DSM's session alive, so with nothing
 * running it goes once a minute, and not at all while the page is hidden.
 */
function schedule(ms) {
  clearTimeout(pollTimer);
  if (unauth) return;
  const busy = [...jobs.values()].some((j) => active(j) && j.source !== "local");
  const watching = !$("#xfer-drawer").hidden || dialogs.size > 0;
  if (document.hidden && !busy && ms === undefined) return;
  const sample = untilNextSample();
  let wait = ms ?? (busy ? (document.hidden ? 3000 : sample ?? 700) : watching ? 2000 : 60000);
  if (pollErrors) wait = Math.max(wait, Math.min(60000, 1000 * 2 ** pollErrors));
  pollTimer = setTimeout(poll, wait);
}

export function kick() {
  schedule(150);
}

function onUpdate(job) {
  if (finished(job) && !seenFinished.has(job.id)) {
    seenFinished.add(job.id);
    // what had finished before the page opened is history, not news
    if (!firstPoll) announce(job);
  }
  if (job.state === "conflict" && !seenConflict.has(job.id + ":" + job.conflict?.id)) {
    seenConflict.add(job.id + ":" + job.conflict?.id);
    openDialog(job.id);
  }
}

/** "Copy complete", or "… and verified" for a job that read files back without an error
 * (a move that was only a rename read nothing back). */
function doneLabel(job, op) {
  return t(job.verify && op.verified && !job.progress.errors && job.progress.verify_bytes > 0 ? op.verified : op.done);
}

function announce(job) {
  const op = OP[job.op] || OP.copy;
  app?.refreshAfter(job);
  if (allFailed(job)) {
    toast(`${title(job)}: ${firstError(job) || t(STATE.failed)}`, { kind: "error", action: t("Dettagli"), onAction: () => openDialog(job.id), timeout: 9000 });
  } else if (job.state === "done") {
    const errs = job.progress.errors;
    toast(`${doneLabel(job, op)}${errs ? " · " + count(errs, "errore", "errori", int) : ""}`, {
      kind: errs ? "error" : "ok",
      action: job.info.dest ? t("Apri") : t("Dettagli"),
      onAction: () => (job.info.dest ? app.openPath(job.info.dest) : openDialog(job.id)),
    });
  } else if (job.state === "failed" && job.msg === "need_password") {
    openDialog(job.id);
  } else if (job.state === "failed") {
    toast(`${title(job)}: ${job.msg}`, { kind: "error", action: t("Dettagli"), onAction: () => openDialog(job.id), timeout: 9000 });
  }
  if (prefs.notify && document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification("SynoFile", { body: `${title(job)} · ${t(STATE[shownState(job)])}`, icon: "images/icon_64.png" });
  }
}

// ---------- local jobs (uploads) ----------

let localSeq = 1;
export function registerLocal(job, controller) {
  job.id = "u" + localSeq++;
  job.source = "local";
  job.samples = job.samples || [];
  jobs.set(job.id, job);
  local.set(job.id, controller);
  renderAll();
  if (prefs.openDialog) openDialog(job.id);
  return job;
}

export function updateLocal(job) {
  job._polledAt = Date.now();
  if (job.samples.length > MAX_SAMPLES) job.samples = thin(job.samples);
  if (finished(job) && !seenFinished.has(job.id)) {
    seenFinished.add(job.id);
    announce(job);
  }
  renderAll();
}

// ---------- actions ----------

export async function start(request) {
  try {
    const { id } = await api.newJob({ conflict: prefs.conflict, verify: false, limit: prefs.limit * 1024 * 1024, ...request });
    nudgeTray();
    since = Math.max(0, since - 1);
    await poll();
    if (prefs.openDialog && request.op !== "delete") openDialog(id);
    return id;
  } catch (e) {
    errorToast(e);
    return null;
  }
}

/** Sends a command to a job; false when it did not get there (the error is shown). */
async function control(job, action, extra = {}) {
  if (job.source === "local") {
    local.get(job.id)?.[action]?.(extra);
    renderAll();
    return true;
  }
  let ok = true;
  try {
    const res = await api.control(job.id, action, extra);
    if (res?.error) toast(res.error, { kind: "error" });
    ok = !res?.error && res?.ok !== false;
  } catch (e) {
    errorToast(e);
    ok = false;
  }
  nudgeTray();
  kick();
  return ok;
}

/** Runs a job again (`extra`: the archive's password) and opens it: the NAS gives it a new id. */
async function retryAndOpen(old, extra = {}) {
  let res;
  try {
    res = await api.control(old.id, "retry", extra);
  } catch (e) {
    return errorToast(e);
  }
  if (res?.error) return toast(res.error, { kind: "error" });
  nudgeTray();
  since = 0;
  await poll();
  if (res?.id != null) openDialog(res.id);
}

function clearFinished() {
  for (const j of [...jobs.values()]) {
    if (!finished(j)) continue;
    if (j.source !== "local") api.control(j.id, "dismiss").catch(() => {});
    jobs.delete(j.id);
  }
  renderAll();
}

// ---------- the button and the drawer ----------

function renderAll() {
  renderButton();
  if (!$("#xfer-drawer").hidden) renderDrawer();
  for (const [id, view] of dialogs) {
    const job = jobs.get(id);
    // a job the NAS forgot (dismissed elsewhere, daemon restarted): its dialog goes too
    if (job) view.update(job);
    else view.dlg.close();
  }
}

function renderButton() {
  const list = [...jobs.values()];
  const running = list.filter(active);
  const btn = $("#xfer-btn");
  btn.classList.toggle("active", running.length > 0);
  const attention = running.some((j) => j.state === "conflict" || j.state === "paused");
  btn.classList.toggle("attention", attention);
  const recentFail = list.some((j) => j.state === "failed" && !seenFail.has(j.id));
  btn.classList.toggle("failed", recentFail && !running.length);
  // one transfer: the ring says it already; the number counts from two,
  // or marks the one waiting for an answer
  const many = running.length > 1 || attention;
  btn.classList.toggle("counted", many || (recentFail && !running.length));
  $("#xfer-count").textContent = many ? running.length : recentFail && !running.length ? "!" : "";
  let total = 0;
  let done = 0;
  for (const j of running) {
    const st = stats(j);
    total += 1;
    done += st.pct;
  }
  const pct = total ? done / total : 0;
  $("#xfer-ring").style.strokeDashoffset = String(94.25 * (1 - pct));
  btn.title = running.length ? t("Trasferimenti: {n} attivi, {p}%", { n: running.length, p: pctText(pct, false) }) : t("Trasferimenti");
}

function toggleDrawer(show) {
  const d = $("#xfer-drawer");
  d.hidden = show === undefined ? !d.hidden : !show;
  if (!d.hidden) {
    for (const j of jobs.values()) if (j.state === "failed") seenFail.add(j.id);
    renderDrawer();
  }
  renderButton();
  schedule(100);
}

export function showDrawer() {
  toggleDrawer(true);
}

function renderDrawer() {
  const list = [...jobs.values()].sort((a, b) => (active(b) - active(a)) || (b.created || 0) - (a.created || 0));
  const el = $("#xfer-list");
  if (!list.length) {
    el.innerHTML = `<div class="drawer-empty">${svg("transfers")}<br>${t("Nessun trasferimento")}</div>`;
    return;
  }
  el.innerHTML = "";
  for (const job of list) {
    const st = stats(job);
    const r = route(job);
    const op = OP[job.op] || OP.copy;
    const meta = active(job)
      ? job.state === "running"
        ? `<span>${st.byBytes ? `${size(job.progress.bytes_done)} / ${size(job.progress.bytes_total)}` : `${int(job.progress.files_done)} / ${int(job.progress.files_total)}`}</span><span>${[st.byBytes ? speed(st.now) : "", st.eta != null ? duration(st.eta) : ""].filter(Boolean).join(" · ")}</span>`
        : `<span>${t(STATE[job.state])}</span><span>${pctText(st.pct, finished(job))}%</span>`
      : `<span>${job.finished ? clock(job.finished) : ""} · ${duration(job.active_ms)}</span><span>${job.progress.errors ? count(job.progress.errors, "errore", "errori", int) : esc(job.msg || "")}</span>`;
    const card = h(`<div class="jcard" tabindex="0" role="button">
      <div class="jcard-top"><div class="op">${svg(op.icon)}</div>
        <div class="tt"><b>${esc(title(job))}</b><small>${esc(r.from)} → ${esc(r.to || "")}</small></div>
        <span class="chip ${shownState(job)}">${t(STATE[shownState(job)])}</span></div>
      <div class="pbar thin mini ${barClass(job)}" style="--p:${(st.pct * 100).toFixed(2)}%"><div class="fill"></div></div>
      <div class="jcard-meta">${meta}</div></div>`);
    card.onclick = () => openDialog(job.id);
    card.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      openDialog(job.id);
    };
    el.append(card);
  }
}

function barClass(job) {
  if (job.state === "paused" || job.state === "conflict" || job.state === "queued") return "paused";
  if (job.state === "done") return job.progress.errors ? "failed" : "done";
  if (job.state === "failed" || job.state === "cancelled") return "failed";
  if (job.progress.scanning) return "indeterminate";
  return "";
}

// ---------- the dialog ----------

export function openDialog(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (dialogs.has(id)) {
    const view = dialogs.get(id);
    if (!view.dlg.open) view.dlg.showModal();
    return;
  }
  const view = new JobDialog(job);
  dialogs.set(id, view);
  view.dlg.addEventListener("close", () => {
    dialogs.delete(id);
    setTimeout(() => view.dlg.remove(), 50);
    view.destroy();
  });
  schedule(100);
}

class JobDialog {
  constructor(job) {
    this.axis = "progress";
    try {
      this.axis = localStorage.getItem("synofile.axis") || "progress";
    } catch {}
    const ttlId = `xf-ttl-${job.id}`;
    const op = OP[job.op] || OP.copy;
    this.dlg = h(`<dialog class="dlg xfer" tabindex="-1" aria-labelledby="${ttlId}">
      <div class="xf-head"><div class="op">${svg(op.icon)}</div>
        <div class="tt"><h2><span class="ttl" id="${ttlId}"></span><span class="chip"></span></h2>
          <div class="route"><span class="from"></span>${svg("forward")}<span class="to"></span></div></div>
        <button class="icon-btn b-min" title="${t("Riduci (continua in background)")}">${svg("minimize")}</button>
      </div>
      <div class="xf-body">
        <div class="xf-steps"></div>
        <div class="xf-pct">
          <div class="big"><span class="pct">0</span><small>%</small></div>
          <div class="side"><div class="bytes"></div><div class="files"></div></div>
        </div>
        <div class="pbar big main glide" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-labelledby="${ttlId}"><div class="fill"></div><div class="verify"></div></div>
        <div class="xf-substate" role="status"><span class="sub-l"></span><span class="sub-r"></span></div>
        <div class="xf-chart"><canvas role="img" aria-label="${t("Velocità")}"></canvas>
          <div class="legend"><span><i style="background:var(--accent)"></i>${t("velocità")}</span><span><i style="background:var(--muted)"></i>${t("media")}</span><button type="button" class="axis-toggle"></button></div>
        </div>
        <div class="xf-stats"></div>
        <div class="xf-current"></div>
        <div class="xf-conflict" hidden></div>
        <details class="xf-errors" hidden><summary></summary><ul></ul></details>
        <div class="xf-summary" role="status" hidden></div>
      </div>
      <div class="xf-foot">
        <div class="left">${svg("zap")}<span>${t("Limite")}</span><select class="limit" aria-label="${t("Limite")}">${LIMITS.map((l) => `<option value="${l}">${l ? speed(l * 1024 * 1024) : t("nessuno")}</option>`).join("")}</select></div>
        <button class="btn b-start" hidden>${t("Avvia ora")}</button>
        <button class="btn b-pause"></button>
        <button class="btn b-cancel">${svg("stop")} ${t("Annulla")}</button>
        <button class="btn b-retry" hidden>${svg("refresh")} ${t("Riprova")}</button>
        <button class="btn b-open" hidden>${svg("external")} ${t("Apri destinazione")}</button>
        <button class="btn primary b-close" hidden>${t("Chiudi")}</button>
      </div></dialog>`);
    document.body.append(this.dlg);
    this.dlg.addEventListener("keydown", (e) => e.stopPropagation());
    this.canvas = $("canvas", this.dlg);
    this.chartBox = $(".xf-chart", this.dlg);
    this.tip = null;
    this.hoverX = null;
    $(".b-min", this.dlg).onclick = () => this.dlg.close();
    $(".b-close", this.dlg).onclick = () => this.dlg.close();
    $(".b-cancel", this.dlg).onclick = () => control(this.job, "cancel");
    $(".b-start", this.dlg).onclick = () => control(this.job, "start");
    $(".b-pause", this.dlg).onclick = () => control(this.job, this.job.state === "paused" ? "resume" : "pause");
    $(".b-retry", this.dlg).onclick = () => {
      // the same job again
      this.dlg.close();
      retryAndOpen(this.job);
    };
    $(".b-open", this.dlg).onclick = () => {
      this.dlg.close();
      app.openPath(this.job.info.dest);
    };
    $(".limit", this.dlg).onchange = async (e) => {
      // not changed on the NAS: back to the limit in force
      if (!(await control(this.job, "limit", { bps: +e.target.value * 1024 * 1024 }))) e.target.value = String(Math.round((this.job.limit || 0) / 1024 / 1024));
    };
    $(".axis-toggle", this.dlg).onclick = () => {
      this.axis = this.axis === "progress" ? "time" : "progress";
      try {
        localStorage.setItem("synofile.axis", this.axis);
      } catch {}
      this.draw();
    };
    // one drawing per frame, however fast the mouse moves
    this.frame = 0;
    // the moving line: at most ~30 drawings a second, only while something on it moves
    this.anim = 0;
    this.drawn = 0;
    this.still = matchMedia("(prefers-reduced-motion: reduce)");
    this.dark = matchMedia("(prefers-color-scheme: dark)");
    this.nextFrame = (now) => {
      this.anim = 0;
      if (now - this.drawn < 30) {
        this.anim = requestAnimationFrame(this.nextFrame);
        return;
      }
      this.drawn = now;
      this.draw();
    };
    // the bars: each poll's value is walked to, not jumped to (see glide)
    this.glides = new Map();
    this.barAnim = 0;
    this.barFrame = (now) => {
      this.barAnim = 0;
      let moving = false;
      for (const g of this.glides.values()) {
        g.apply(glidePos(g, now));
        moving ||= now < g.at + g.dur;
      }
      if (moving) this.barAnim = requestAnimationFrame(this.barFrame);
    };
    this.canvas.addEventListener("mousemove", (e) => {
      this.hoverX = e.offsetX;
      this.frame ||= requestAnimationFrame(() => {
        this.frame = 0;
        this.draw();
      });
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hoverX = null;
      this.draw();
    });
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(this.chartBox);
    this.tick = setInterval(() => this.job && active(this.job) && this.update(this.job, true), 1000);
    this.dlg.showModal();
    this.update(job);
    // no button should look pressed when the dialog opens, unless a conflict waits for one
    if (!$(".xf-conflict", this.dlg).contains(document.activeElement)) this.dlg.focus();
  }

  destroy() {
    clearInterval(this.tick);
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.anim);
    cancelAnimationFrame(this.barAnim);
    this.resize.disconnect();
  }

  /**
   * How far along the samples the line has got. It follows the samples and nothing else: its
   * target is the second-newest point (the piece before it has both tangents, so a new sample
   * reshapes nothing on screen) and it walks from one sample to the next at the pace they were
   * taken, faster only when more than a sample and a half is waiting. No sample, no movement.
   */
  headTime(job, pts) {
    const last = pts[pts.length - 1].t;
    const still = this.still.matches;
    const target = active(job) && !still ? pts[Math.max(0, pts.length - 2)].t : last;
    const wall = performance.now();
    const period = samplePeriod(job.samples);
    const c = (this.head ||= { wall, shown: active(job) ? target - period : last, target });
    c.target = target;
    const rate = Math.max(1, (target - c.shown) / (1.5 * period));
    c.shown = still ? target : Math.min(target, c.shown + Math.min(250, wall - c.wall) * rate);
    c.wall = wall;
    return c.shown;
  }

  /** The top of the scale on screen: it glides to `top` as the dashboard's charts do. */
  shownTop(top) {
    const now = performance.now();
    const c = (this.yShow ||= { from: top, to: top, at: 0 });
    const at = () => {
      const f = Math.min(1, (now - c.at) / 600);
      return c.from + (c.to - c.from) * (1 - (1 - f) ** 3);
    };
    if (c.to !== top) {
      c.from = this.still.matches ? top : at();
      c.to = top;
      c.at = now;
    }
    this.yMoving = now - c.at < 600 && c.from !== c.to;
    return at();
  }

  /**
   * Moves a bar to `value` over a little more than the time since its previous value, so that it
   * keeps going at the pace of the transfer instead of jumping at each poll. Going back is at
   * once; `fresh` (a new file, or its verify pass) starts the bar from 0.
   */
  glide(key, value, apply, fresh = false) {
    const now = performance.now();
    let g = this.glides.get(key);
    if (!g || fresh) {
      g = { from: fresh ? 0 : value, to: value, at: now, dur: fresh && !this.still.matches ? 300 : 0, last: now };
      this.glides.set(key, g);
    } else if (value !== g.to) {
      const pos = glidePos(g, now);
      g.dur = value < pos || this.still.matches ? 0 : Math.min(1500, 1.3 * (now - g.last));
      Object.assign(g, { from: pos, to: value, at: now, last: now });
    }
    g.apply = apply;
    apply(glidePos(g, now));
    if (g.dur && !this.barAnim) this.barAnim = requestAnimationFrame(this.barFrame);
  }

  /** The job's bar and the current file's, with every poll (the numbers next to them wait). */
  glideBars(job, st) {
    const p = job.progress;
    const split = st.verify && st.byBytes;
    const main = $(".pbar.main", this.dlg);
    const ver = $(".verify", main);
    this.glide("copy", split ? p.bytes_done / st.totalWork : st.pct, (v) => {
      main.style.setProperty("--p", (Math.min(1, v) * 100).toFixed(2) + "%");
      ver.style.left = split ? (v * 100).toFixed(2) + "%" : "0";
    });
    this.glide("verify", split ? (p.verify_bytes + (p.verify_skip || 0)) / st.totalWork : 0, (v) => (ver.style.width = (v * 100).toFixed(2) + "%"));

    // the item in flight: built once per file (and once for its verify pass), as soon as it starts
    const cur = $(".xf-current", this.dlg);
    if (!p.current || !active(job)) {
      cur.hidden = true;
      this.fileKey = null;
      return;
    }
    cur.hidden = false;
    const fresh = this.fileKey !== fileKey(p);
    if (fresh) {
      this.fileKey = fileKey(p);
      const name = baseName(p.current) || p.current;
      cur.innerHTML = `<div class="row1">${svg(p.phase === "verify" ? "shield" : "file")}<span class="nm">${esc(name)}</span><span class="meth">${esc(p.phase === "verify" ? t("verifica") : methodLabels()[p.method] || "")}</span></div>
        <div class="path">${esc(p.current)}</div>
        ${p.current_size ? `<div class="pbar thin glide ${barClass(job)}"><div class="fill"></div></div><div class="row3"><span class="done">${size(p.current_done)} ${t("di")} ${size(p.current_size)}</span><span class="share">${pctText(fileShare(p), false)}%</span></div>` : ""}`;
    }
    const bar = $(".pbar", cur);
    // one file's share only grows: a hair below the last value is a counter read early, much
    // below it the file started over (an upload resending a part)
    const raw = fileShare(p);
    const last = this.glides.get("file")?.to ?? 0;
    const again = !fresh && raw < last - 0.02;
    const share = fresh || again ? raw : Math.max(raw, last);
    if (bar) this.glide("file", share, (v) => bar.style.setProperty("--p", (v * 100).toFixed(2) + "%"), fresh || again);
  }

  update(job, tickOnly = false) {
    this.job = job;
    // the chart and the bars take every poll
    const st = stats(job);
    this.st = st;
    this.glideBars(job, st);
    // the chart takes every poll, the numbers change at a pace that can be read
    const shown = job.state;
    const wall = performance.now();
    if (shown === this.shownKey && wall - this.shownAt < 600) {
      this.draw();
      return;
    }
    this.shownKey = shown;
    this.shownAt = wall;
    const p = job.progress;
    const d = this.dlg;
    const op = OP[job.op] || OP.copy;
    const r = route(job);
    const state = shownState(job);
    $(".ttl", d).textContent = finished(job) ? (state === "done" ? doneLabel(job, op) : title(job)) : t(op.running);
    $(".ttl", d).title = title(job);
    const chip = $(".chip", d);
    chip.className = "chip " + state;
    chip.textContent = t(STATE[state]);
    $(".from", d).textContent = r.from;
    $(".from", d).title = job.info.sources.join("\n");
    $(".to", d).textContent = r.to || "";

    // phases
    const phases = PHASES[job.op] || PHASES.copy;
    const visiblePhases = phases.filter(([k]) => k !== "verify" || st.verify);
    let now = p.scanning ? "scan" : p.phase || "scan";
    // files are checked one by one: until the last one is copied, the step is the copy's
    if (now === "verify" && p.bytes_done < p.bytes_total) now = job.op === "move" ? "move" : "copy";
    if (job.state === "done") now = "end";
    if (job.state === "queued") now = "";
    let nowIndex = visiblePhases.findIndex(([k]) => k === now);
    // a phase this list does not have (an extraction before its first event): the first step
    if (nowIndex < 0 && now && active(job)) nowIndex = 0;
    const broken = job.state === "failed" || job.state === "cancelled";
    setHTML($(".xf-steps", d), visiblePhases
      .map(([k, label], i) => {
        const cls = i < nowIndex || job.state === "done" ? "past" : i === nowIndex ? (broken ? "stop" : "now") : "";
        const mark = cls === "past" ? "✓" : cls === "stop" ? "✕" : i + 1;
        return (i ? `<span class="line ${i <= nowIndex ? "past" : ""}"></span>` : "") + `<span class="st ${cls}"><i>${mark}</i>${t(label)}</span>`;
      })
      .join(""));

    // the big numbers
    $(".pct", d).textContent = pctText(st.pct, finished(job));
    if (st.byBytes) {
      $(".bytes", d).innerHTML = `${size(p.bytes_done)} <span>${t("di")} ${size(p.bytes_total)}</span>`;
    } else {
      $(".bytes", d).innerHTML = `${int(p.files_done)} <span>${t("di")} ${int(p.files_total)}</span>`;
    }
    $(".files", d).textContent = p.scanning
      ? t("Analisi: {f} file, {b} trovati…", { f: int(p.files_total), b: size(p.bytes_total) })
      : st.byBytes
        ? t("{a} di {b} file", { a: int(p.files_done), b: int(p.files_total) }) + (p.dirs ? " · " + count(p.dirs, "cartella", "cartelle", int) : "")
        : count(p.files_total, "elemento", "elementi", int);
    const bar = $(".pbar.main", d);
    bar.className = "pbar big main glide " + barClass(job);
    bar.setAttribute("aria-valuenow", String(Math.round(st.pct * 100)));

    const subL = job.state === "queued" ? t("In attesa che finisca un altro trasferimento") : job.state === "paused" ? t("In pausa") : job.state === "conflict" ? t("In attesa di una tua scelta") : p.scanning ? t("Conteggio di file e cartelle…") : "";
    $(".sub-l", d).textContent = subL;
    const notes = [];
    if (st.verify && st.byBytes) notes.push(t("verificati {a} di {b}", { a: size(p.verify_bytes), b: size(p.bytes_total - (p.verify_skip || 0)) }));
    if (p.instant) notes.push(t("{n} senza copiare dati (reflink o rinomina)", { n: int(p.instant) }));
    if (p.skipped) notes.push(t("{n} saltati", { n: int(p.skipped) }));
    $(".sub-r", d).textContent = notes.join(" · ");

    // stats
    const end = st.eta != null ? Date.now() + st.eta : null;
    const methods = methodLabels();
    const cells = [
      [t("Velocità"), job.state !== "running" ? "—" : st.byBytes ? speed(st.now) : t("{n}/s", { n: decimal(st.now) }), true],
      [t("Media"), st.byBytes ? speed(st.avg) : "—"],
      [t("Picco"), st.byBytes ? speed(st.peak) : "—"],
      [t("File al secondo"), st.filesRate ? decimal(st.filesRate) : "—"],
      [t("Trascorso"), duration(st.elapsed)],
      [t("Rimanente"), finished(job) ? "—" : st.eta != null ? "~ " + duration(st.eta) : p.scanning ? t("calcolo…") : "—", true],
      [t("Fine prevista"), end ? clock(end) : finished(job) && job.finished ? clock(job.finished) : "—"],
      [t("Metodo"), methods[p.method] || "—"],
    ];
    setHTML($(".xf-stats", d), cells.map(([k, v, hl]) => `<div class="stat ${hl ? "hl" : ""}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join(""));

    // the item in flight is built by glideBars, with every poll; its numbers change here
    const cur = $(".xf-current", d);
    const fileBar = $(".pbar", cur);
    if (!cur.hidden && fileBar) {
      fileBar.className = "pbar thin glide " + barClass(job);
      $(".done", cur).textContent = `${size(p.current_done)} ${t("di")} ${size(p.current_size)}`;
      $(".share", cur).textContent = `${pctText(fileShare(p), false)}%`;
    }

    if (!tickOnly) {
      this.renderConflict(job);
      this.renderErrors(job);
    }

    // the end
    const sum = $(".xf-summary", d);
    if (finished(job)) {
      sum.hidden = false;
      const ok = job.state === "done" && !p.errors;
      sum.className = "xf-summary " + (ok ? "ok" : job.state === "done" ? "failed" : job.state);
      const parts = [t("in {d}", { d: duration(job.active_ms) })];
      if (st.byBytes && st.avg) parts.push(t("media {s}", { s: speed(st.avg) }));
      parts.push(count(p.files_done, "elemento", "elementi", int));
      if (p.skipped) parts.push(t("{n} saltati", { n: int(p.skipped) }));
      if (p.errors) parts.push(count(p.errors, "errore", "errori", int));
      if (job.msg === "need_password") {
        sum.className = "xf-summary failed";
        if (!$(".pw", sum)) {
          sum._html = null;
          sum.innerHTML = `${svg("shield")}<div style="flex:1"><b>${t("L'archivio è protetto da password")}</b>
            <form class="pw" style="display:flex;gap:8px;margin-top:8px"><input type="password" class="input" style="flex:1" placeholder="${t("Password")}" autocomplete="off"><button class="btn primary">${t("Estrai")}</button></form></div>`;
          const form = $(".pw", sum);
          form.onsubmit = (e) => {
            e.preventDefault();
            const password = $("input", form).value;
            if (!password) return;
            this.dlg.close();
            retryAndOpen(job, { password });
          };
          setTimeout(() => $("input", form)?.focus());
        }
      } else {
        const head = allFailed(job) ? `${t(STATE.failed)}: ${firstError(job)}` : job.state === "done" ? doneLabel(job, op) : !job.msg || job.msg === t(STATE[job.state]) ? t(STATE[job.state]) : `${t(STATE[job.state])}: ${job.msg}`;
        setHTML(sum, `${svg(ok ? "check" : "alert")}<div><b>${esc(head)}</b>${esc(parts.join(" · "))}</div>`);
      }
    } else sum.hidden = true;

    // buttons (the browser drops the focus of a button as it hides it: noted first)
    const focused = document.activeElement;
    // in a conflict the job waits for an answer, and the NAS pauses only a running job
    $(".b-pause", d).hidden = finished(job) || job.state === "queued" || job.state === "conflict" || (job.op === "delete" && job.source !== "local");
    setHTML($(".b-pause", d), job.state === "paused" ? `${svg("play")} ${t("Riprendi")}` : `${svg("pause")} ${t("Pausa")}`);
    $(".b-cancel", d).hidden = finished(job);
    $(".b-start", d).hidden = job.state !== "queued" || job.source === "local";
    $(".b-close", d).hidden = !finished(job);
    $(".b-open", d).hidden = !finished(job) || !job.info.dest;
    $(".b-retry", d).hidden = !job.interrupted;
    // no speed limit for uploads from this computer: the browser sends as fast as it can
    $(".xf-foot .left", d).style.visibility = finished(job) || job.op === "delete" || job.source === "local" ? "hidden" : "visible";
    const sel = $(".limit", d);
    const mb = Math.round((job.limit || 0) / 1024 / 1024);
    if (document.activeElement !== sel) {
      if (![...sel.options].some((o) => +o.value === mb)) sel.append(h(`<option value="${mb}">${speed(mb * 1024 * 1024)}</option>`));
      sel.value = String(mb);
    }
    // a button that went away with the focus on it (Cancel, at the end) leaves it to Close
    if (focused !== d && d.contains(focused) && !focused.offsetParent) ($(".b-close:not([hidden])", d) || d).focus();
    $(".axis-toggle", d).textContent = this.axis === "progress" ? t("asse: avanzamento") : t("asse: tempo");
    this.chartBox.hidden = job.op === "delete" && !st.byBytes && job.samples.length < 3;
    this.draw();
  }

  renderConflict(job) {
    const box = $(".xf-conflict", this.dlg);
    const c = job.conflict;
    if (!c || finished(job)) {
      box.hidden = true;
      this.conflictId = null;
      return;
    }
    if (this.conflictId === c.id) return;
    this.conflictId = c.id;
    box.hidden = false;
    const newer = c.source.mtime > c.target.mtime ? "source" : c.source.mtime < c.target.mtime ? "target" : "";
    const side = (s, label, which) => `<div><div class="h"><span>${esc(label)}</span>${newer === which ? `<span class="newer">${t("più recente")}</span>` : ""}</div>
      <div>${s.dir ? t("Cartella") : size(s.size)} ${!s.dir && s.size !== (which === "source" ? c.target.size : c.source.size) ? `<span class="bigger">${(which === "source" ? c.source.size > c.target.size : c.target.size > c.source.size) ? "▲" : "▼"}</span>` : ""}</div>
      <div style="color:var(--muted)">${esc(dateTime(s.mtime))}</div></div>`;
    box.innerHTML = `<h3>${svg("alert")} ${t("Esiste già un elemento con questo nome")}</h3>
      <div class="cname">${esc(c.path)}</div>
      <div class="cmp">${side(c.source, t("Da copiare"), "source")}${side(c.target, t("Nella destinazione"), "target")}</div>
      <div class="acts">
        <button class="btn primary" data-a="overwrite">${t("Sovrascrivi")}</button>
        <button class="btn" data-a="skip">${t("Salta")}</button>
        <button class="btn" data-a="rename" title="${esc(c.rename_to)}">${t("Mantieni entrambi")}</button>
        <button class="btn" data-a="newer">${t("Sovrascrivi se più recente")}</button>
        <label class="check" style="margin-left:auto"><input type="checkbox" class="all"> ${t("Applica a tutti")}</label>
      </div>
      <div class="hint" style="margin-top:6px">${t("«Mantieni entrambi» salva il nuovo come {n}", { n: `<b>${esc(c.rename_to)}</b>` })}</div>`;
    box.querySelectorAll("[data-a]").forEach((b) => (b.onclick = async () => {
      box.hidden = true;
      // not delivered: the question stays, and is drawn again
      if (!(await control(job, "answer", { policy: b.dataset.a, all: $(".all", box).checked, conflict: c.id }))) {
        this.conflictId = null;
        box.hidden = false;
      }
    }));
    $(".btn.primary", box).focus();
  }

  renderErrors(job) {
    const box = $(".xf-errors", this.dlg);
    const errs = job.errors || [];
    box.hidden = !errs.length;
    if (!errs.length) return;
    $("summary", box).textContent = count(job.progress.errors || errs.length, "errore", "errori", int);
    // rebuilt only when it grew: a selection in it stays
    if (this.errorsShown === errs.length) return;
    this.errorsShown = errs.length;
    $("ul", box).innerHTML = errs.map((e) => `<li><span title="${esc(e.path)}">${esc(e.path)}</span><span>${esc(e.msg)}</span></li>`).join("");
  }

  /** The speed chart: throughput against progress (or time), with the average. */
  draw() {
    const job = this.job;
    if (!job || this.chartBox.hidden) return;
    const c = this.canvas;
    const dpr = devicePixelRatio || 1;
    const W = this.chartBox.clientWidth;
    const H = this.chartBox.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // the theme's colours, read once per theme (a full style lookup each frame is not free)
    const theme = `${document.documentElement.dataset.theme || ""}${this.dark.matches}`;
    if (this.colorsFor !== theme) {
      this.colors = new Map();
      this.colorsFor = theme;
    }
    const col = (v) => {
      let c = this.colors.get(v);
      if (c === undefined) {
        c = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        this.colors.set(v, c);
      }
      return c;
    };
    const st = this.st || stats(job);
    const work = (x) => (st.byBytes ? x[1] + x[3] : x[2]);
    const s = job.samples;
    const pad = { l: 8, r: 64, t: 22, b: 10 };
    const w = W - pad.l - pad.r;
    const hh = H - pad.t - pad.b;
    const progressAxis = this.axis === "progress";
    const tEnd = s.length ? s[s.length - 1][0] : 0;

    // the speed at each sample: the work done over the ~2 s before it, from the cumulative
    // counters, so bursts average out instead of drawing spikes; the window widens when a pixel
    // covers more than half a second, in steps, so the curve stays put between one and the next
    const spanMs = progressAxis ? Math.max(tEnd, 1) : Math.max(30000, st.elapsed, tEnd);
    const rawWin = (spanMs / Math.max(w, 1)) * 4;
    const win = rawWin <= 2000 ? 2000 : 2000 * Math.SQRT2 ** Math.ceil(Math.log2(rawWin / 2000) * 2);
    // read once per sample, not once per frame
    const curveKey = `${s.length}/${tEnd}/${win}/${st.byBytes}`;
    if (this.curveKey !== curveKey) {
      this.curveKey = curveKey;
      this.curve = speedCurve(s, work, win);
    }
    const pts = this.curve;
    const headT = pts.length ? this.headTime(job, pts) : 0;
    const xmax = progressAxis ? Math.max(1, st.totalWork) : active(job) ? Math.max(30000, headT) : spanMs;
    const xOf = (p) => pad.l + ((progressAxis ? Math.min(xmax, p.w) : p.t) / xmax) * w;
    // one point per ~2 px: on the progress axis a slow stretch packs many points together (the
    // time axis has evenly spaced points, and its scale moves: merging there would shimmer)
    const plot = [];
    for (const p of pts) {
      const x = xOf(p);
      const last = plot[plot.length - 1];
      if (progressAxis && last && x - last.x < 2) {
        last.n++;
        last.v += (p.v - last.v) / last.n;
        last.verifying ||= p.verifying;
        last.p = p;
      } else plot.push({ x, v: p.v, verifying: p.verifying, n: 1, p });
    }

    // the scale: a round top over the smoothed peak and the average, with hysteresis (it grows
    // at once, shrinks only once everything fits in half of it), so it does not breathe
    const peakV = plot.reduce((a, p) => Math.max(a, p.v), 0);
    const want = Math.max(peakV * 1.1, st.avg * 1.3, 1);
    const scaleFor = `${this.axis}${st.byBytes}`;
    if (!this.yTop || want > this.yTop.top || want < this.yTop.top * 0.5 || this.yAxis !== scaleFor) {
      this.yTop = roundTop(want, st.byBytes);
      this.yAxis = scaleFor;
    }
    const ymax = this.shownTop(this.yTop.top);
    const tick = this.yTop.step;
    const yOf = (v) => pad.t + hh - (Math.min(Math.max(v, 0), ymax) / ymax) * hh;

    if (plot.length < 2) {
      g.fillStyle = col("--faint");
      g.font = "12px " + col("--font");
      g.textAlign = "center";
      g.fillText(active(job) ? t("in attesa dei primi dati…") : t("nessun dato"), W / 2, H / 2 + 6);
      g.textAlign = "start";
      return;
    }
    // grid and round tick labels
    const gridColor = col("--chart-grid") || col("--border");
    g.font = "10.5px " + col("--font");
    g.textBaseline = "middle";
    for (let k = 0; k * tick <= ymax * (1 + 1e-9); k++) {
      const y = yOf(k * tick);
      g.strokeStyle = k ? gridColor : col("--border");
      g.lineWidth = 1;
      g.setLineDash(k ? [2, 4] : []);
      g.beginPath();
      g.moveTo(pad.l, Math.round(y) + 0.5);
      g.lineTo(pad.l + w, Math.round(y) + 0.5);
      g.stroke();
      if (k) {
        g.fillStyle = col("--faint");
        g.fillText(st.byBytes ? tickSpeed(k * tick) : t("{n}/s", { n: decimal(k * tick) }), pad.l + w + 6, y);
      }
    }
    g.setLineDash([]);
    // where the line has got to, between the two points of the grid around that moment
    let hi = pts.length - 1;
    while (hi > 1 && pts[hi - 1].t > headT) hi--;
    const [pa, pb] = [pts[hi - 1], pts[hi]];
    const f = pb.t > pa.t ? Math.min(1, Math.max(0, (headT - pa.t) / (pb.t - pa.t))) : 1;
    const headX = xOf({ t: pa.t + (pb.t - pa.t) * f, w: pa.w + (pb.w - pa.w) * f });
    // the progress so far, faintly, on the progress axis
    if (progressAxis) {
      g.fillStyle = col("--accent-soft");
      g.globalAlpha = 0.45;
      g.fillRect(pad.l, pad.t, active(job) ? Math.max(0, headX - pad.l) : (st.doneWork / xmax) * w, hh);
      g.globalAlpha = 1;
    } else {
      g.fillStyle = col("--faint");
      g.textBaseline = "alphabetic";
      g.fillText(fmtTime(0), pad.l, H - 4);
      const endLabel = fmtTime(xmax);
      g.fillText(endLabel, pad.l + w - g.measureText(endLabel).width, H - 4);
      // pauses (holes in the samples), shaded
      g.globalAlpha = 0.12;
      for (const [a, b] of pauses(s)) if (a < headT) g.fillRect(xOf({ t: a }), pad.t, Math.max(1, xOf({ t: Math.min(b, headT) }) - xOf({ t: a })), hh);
      g.globalAlpha = 1;
    }
    // the curve: monotone cubic through the points, so it never dips below 0 nor overshoots
    // a peak; filled down to the baseline
    const xy = plot.map((p) => [p.x, yOf(p.v)]);
    const m = monotoneTangents(xy);
    const piece = (k) => {
      const [x0, y0] = xy[k];
      const [x1, y1] = xy[k + 1];
      const d = (x1 - x0) / 3;
      g.bezierCurveTo(x0 + d, y0 + m[k] * d, x1 - d, y1 - m[k + 1] * d, x1, y1);
    };
    // the height of the curve at `px`: the same cubic the pieces draw (x is linear in it)
    const curveY = (px) => {
      let k = xy.length - 2;
      while (k > 0 && xy[k][0] > px) k--;
      const [x0, y0] = xy[k];
      const [x1, y1] = xy[k + 1];
      const d = x1 - x0;
      if (d <= 0) return y1;
      const u = Math.min(1, Math.max(0, (px - x0) / d));
      const [c0, c1, v] = [y0 + (m[k] * d) / 3, y1 - (m[k + 1] * d) / 3, 1 - u];
      return v * v * v * y0 + 3 * v * v * u * c0 + 3 * v * u * u * c1 + u * u * u * y1;
    };
    const accent = col("--accent");
    // what is past the head is drawn already, and shows as the head gets there
    g.save();
    g.beginPath();
    g.rect(0, 0, headX + 1, H);
    g.clip();
    const grad = g.createLinearGradient(0, pad.t, 0, pad.t + hh);
    grad.addColorStop(0, alpha(accent, 0.38));
    grad.addColorStop(1, alpha(accent, 0.03));
    g.beginPath();
    g.moveTo(xy[0][0], yOf(0));
    g.lineTo(xy[0][0], xy[0][1]);
    for (let k = 0; k < xy.length - 1; k++) piece(k);
    g.lineTo(xy[xy.length - 1][0], yOf(0));
    g.closePath();
    g.fillStyle = grad;
    g.fill();
    // the line, green where the data is being verified (one path per run of one colour)
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.lineCap = "round";
    for (let a = 0; a < xy.length - 1; ) {
      const ver = plot[a + 1].verifying;
      let b = a;
      while (b < xy.length - 1 && plot[b + 1].verifying === ver) b++;
      g.strokeStyle = ver ? col("--ok") : accent;
      g.beginPath();
      g.moveTo(xy[a][0], xy[a][1]);
      for (let k = a; k < b; k++) piece(k);
      g.stroke();
      a = b;
    }
    g.restore();
    // the head of the line
    if (active(job) || headT < this.head.target) {
      const x = Math.min(headX, xy[xy.length - 1][0]);
      const y = curveY(x);
      g.fillStyle = accent;
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = alpha(accent, 0.35);
      g.lineWidth = 6;
      g.stroke();
    }
    // average
    if (st.avg > 0) {
      const y = Math.round(yOf(st.avg)) + 0.5;
      g.strokeStyle = col("--muted");
      g.lineWidth = 1;
      g.setLineDash([5, 4]);
      g.beginPath();
      g.moveTo(pad.l, y);
      g.lineTo(pad.l + w, y);
      g.stroke();
      g.setLineDash([]);
    }
    // hover
    if (this.hoverX != null && pts.length) {
      let best = pts[0];
      for (const p of pts) if (p.t <= headT && Math.abs(xOf(p) - this.hoverX) < Math.abs(xOf(best) - this.hoverX)) best = p;
      const x = xOf(best);
      g.strokeStyle = col("--border-strong");
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, pad.t);
      g.lineTo(x, pad.t + hh);
      g.stroke();
      g.fillStyle = col("--text");
      g.beginPath();
      g.arc(x, yOf(best.v), 3, 0, Math.PI * 2);
      g.fill();
      if (!this.tip) this.tip = this.chartBox.appendChild(h(`<div class="tip"></div>`));
      const pct = st.totalWork ? Math.round((best.w / st.totalWork) * 100) : 0;
      const text = `${fmtTime(best.t)} · ${st.byBytes ? speed(best.v) : t("{n}/s", { n: decimal(best.v) })} · ${pct}%`;
      this.tip.hidden = false;
      // measured when its text changes, not at every frame
      if (this.tip.textContent !== text) {
        this.tip.textContent = text;
        this.tipW = this.tip.offsetWidth;
      }
      this.tip.style.left = Math.min(W - this.tipW - 4, Math.max(4, x - this.tipW / 2)) + "px";
      this.tip.style.top = "4px";
    } else if (this.tip) this.tip.hidden = true;
    if ((headT < this.head.target || this.yMoving) && !this.anim) this.anim = requestAnimationFrame(this.nextFrame);
  }
}

/** Writes `html` into `el` only when it differs from what was written there last. */
function setHTML(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

/** A rate in the interface's language: two decimals under 1, one under 10, none above. */
function decimal(v) {
  return v.toLocaleString(LOCALE, { maximumFractionDigits: v < 1 ? 2 : v < 10 ? 1 : 0 });
}

function methodLabels() {
  return {
    clone: t("Reflink btrfs"), copy: t("Copia dati"), rename: t("Rinomina"), recycle: t("Cestino DSM"), delete: t("Eliminazione"),
    deflate: t("Zip (deflate)"), store: t("Zip senza compressione"), "7z": "7-Zip", unrar: "unrar",
  };
}

/** Where a glide is at `now` (JobDialog.glide). A frame's time can be a little before the glide began. */
function glidePos(g, now) {
  return g.dur ? g.from + (g.to - g.from) * Math.min(1, Math.max(0, (now - g.at) / g.dur)) : g.to;
}

/** The file in flight: a new one, or its verify pass, gets its own bar. */
function fileKey(p) {
  return `${p.current}\n${p.phase}\n${p.method}\n${p.current_size ? 1 : 0}`;
}

function fileShare(p) {
  return p.current_size ? Math.min(1, p.current_done / p.current_size) : 0;
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Holes in the samples: a pause (nothing is sampled while paused), not thinned samples (those
 * are just farther apart, evenly). [start, end] in ms.
 */
function pauses(s) {
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const dt = s[i][0] - s[i - 1][0];
    const before = i > 1 ? s[i - 1][0] - s[i - 2][0] : 500;
    if (dt > 2500 && dt > 3 * before) out.push([s[i - 1][0], s[i][0] - Math.min(before, 1000)]);
  }
  return out;
}

/** The pace of the samples: the median of the last gaps (forced samples sit a few ms apart). */
function samplePeriod(s) {
  const gaps = [];
  for (let i = Math.max(1, s.length - 9); i < s.length; i++) gaps.push(s[i][0] - s[i - 1][0]);
  gaps.sort((a, b) => a - b);
  return Math.min(1000, Math.max(100, gaps[gaps.length >> 1] || 250));
}

/**
 * The speed at each sample: the work done in the `win` ms before it, divided by `win`. The
 * cumulative work is read between samples by linear interpolation, flat across a pause; before
 * the first sample it is the first sample's, so the curve rises from 0 over the first window
 * instead of starting with the spike of a first short interval. A sample less than 100 ms after
 * the one before it adds no point, and a new sample leaves the earlier points as they were.
 */
function speedCurve(s, work, win) {
  if (s.length < 2) return [];
  const holes = pauses(s);
  const t0 = s[0][0];
  const tEnd = s[s.length - 1][0];
  let k = 0;
  const at = (tm) => {
    if (tm <= t0) return work(s[0]);
    if (tm >= tEnd) return work(s[s.length - 1]);
    while (k > 0 && s[k][0] > tm) k--;
    while (k < s.length - 2 && s[k + 1][0] < tm) k++;
    let [a, b] = [s[k][0], s[k + 1][0]];
    const hole = holes.find(([x]) => x === a);
    if (hole) {
      if (tm <= hole[1]) return work(s[k]);
      a = hole[1];
    }
    const f = b > a ? (tm - a) / (b - a) : 1;
    return work(s[k]) + (work(s[k + 1]) - work(s[k])) * f;
  };
  let v = 1;
  const ver = (tm) => {
    // verifying: the verify counter grew around this point (tm only grows)
    while (v < s.length - 1 && s[v][0] < tm) v++;
    return s[v][3] > s[v - 1][3];
  };
  const times = [];
  for (const x of s) if (!times.length || x[0] - times[times.length - 1] >= 100) times.push(x[0]);
  // a job over within 100 ms still has a start and an end
  if (times.length < 2 && tEnd > times[0]) times.push(tEnd);
  // across a pause there is no sample: the speed reaches zero and stays there until it ends
  for (const [a, b] of holes) {
    if (a + win < b) times.push(a + win);
    times.push(b);
  }
  times.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    if (i && times[i] === times[i - 1]) continue;
    const tm = times[i];
    const v = Math.max(0, (at(tm) - at(tm - win)) / (win / 1000));
    out.push({ t: tm, w: at(tm), v, verifying: ver(tm) });
  }
  return out;
}

/** Fritsch–Carlson tangents of the monotone cubic through [x, y] points (x increasing). */
function monotoneTangents(xy) {
  const n = xy.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const d = [];
  for (let k = 0; k < n - 1; k++) {
    const hx = xy[k + 1][0] - xy[k][0];
    d.push(hx > 0 ? (xy[k + 1][1] - xy[k][1]) / hx : 0);
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) continue;
    const h0 = xy[k][0] - xy[k - 1][0];
    const h1 = xy[k + 1][0] - xy[k][0];
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
  }
  return m;
}

/** A round scale over `v`: 3–5 ticks of 1, 2, 2.5 or 5 × 10ⁿ in the unit the labels use. */
function roundTop(v, bytes = true) {
  // bytes in 1024s (or 1000s), items per second in plain numbers
  const unit = bytes ? speedUnit(v / 3) : 1;
  const step = niceStep(v / unit / 4) * unit;
  return { top: step * Math.ceil(v / step - 1e-9), step };
}

/** The unit a speed is shown in (1024ⁿ or 1000ⁿ B/s, as the sizes). */
function speedUnit(bps) {
  const [, , u] = sizeParts(bps);
  return (sizeParts(1024)[2] === 1 ? 1024 : 1000) ** u;
}

/** A tick label: "100 MiB/s", "2,5 GiB/s" (no forced decimal). */
function tickSpeed(bps) {
  const [, unit] = sizeParts(bps);
  const v = bps / speedUnit(bps);
  return `${(Math.round(v * 10) / 10).toLocaleString(LOCALE)} ${unit}/s`;
}

function niceStep(x) {
  if (x <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

/** `color` at opacity `a` (hex colours directly, anything else through color-mix). */
function alpha(color, a) {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (!m) return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function all() {
  return [...jobs.values()];
}
