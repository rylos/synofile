// Transfers: the jobs the NAS runs (copy, move, delete) and the uploads
// this page sends, one model for both. The drawer lists them; the dialog
// shows one in detail, with its speed chart.

import { api } from "./api.js";
import { prefs } from "./prefs.js";
import { t, count } from "./i18n.js";
import { esc, size, speed, duration, clock, int, baseName, parentOf, dateTime } from "./format.js";
import { svg } from "./icons.js";
import { h, $, toast, errorToast } from "./ui.js";

const jobs = new Map(); // id -> job
const local = new Map(); // uploads: id -> controller {pause, resume, cancel, answer}
let since = 0;
let pollTimer = 0;
let app = null;
let firstPoll = true;
const dialogs = new Map(); // id -> dialog view
const seenFinished = new Set();
const seenConflict = new Set();

const OP = {
  copy: { icon: "copy", running: "Copia in corso", done: "Copia completata", noun: "Copia|op" },
  move: { icon: "move", running: "Spostamento in corso", done: "Spostamento completato", noun: "Spostamento" },
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
  move: [["scan", "Analisi"], ["move", "Spostamento"], ["end", "Fine"]],
  delete: [["scan", "Conteggio"], ["delete", "Eliminazione"], ["end", "Fine"]],
  upload: [["copy", "Trasmissione"], ["end", "Fine"]],
  compress: [["scan", "Analisi"], ["compress", "Compressione"], ["end", "Fine"]],
  extract: [["extract", "Estrazione"], ["end", "Fine"]],
};
const LIMITS = [0, 5, 10, 25, 50, 100, 200, 500];

const finished = (j) => ["done", "failed", "cancelled"].includes(j.state);
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
  document.addEventListener("visibilitychange", () => schedule(200));
  poll();
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
  const from = job.info.sources.length ? parentOf(job.info.sources[0]) : "";
  if (job.op === "delete") return { from, to: job.info.permanent ? t("eliminazione definitiva") : t("Cestino") };
  if (job.op === "upload") return { from: t("questo computer"), to: job.info.dest };
  if (job.op === "extract") return { from: job.info.sources[0], to: job.info.dest };
  return { from, to: job.info.dest };
}

/** Everything the views show, worked out once per update. */
export function stats(job) {
  const p = job.progress;
  const verify = job.verify && job.op !== "delete";
  const byBytes = p.bytes_total > 0 && job.op !== "delete";
  const totalWork = byBytes ? p.bytes_total * (verify ? 2 : 1) : p.files_total;
  const doneWork = byBytes ? p.bytes_done + (verify ? p.verify_bytes : 0) : p.files_done;
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
    while (k > 0 && last[0] - s[k][0] < ms) k--;
    const dt = (last[0] - s[k][0]) / 1000;
    return dt > 0 ? Math.max(0, (work(last) - work(s[k])) / dt) : 0;
  };
  const now = job.state === "running" ? windowSpeed(2500) : 0;
  const smooth = windowSpeed(10000);
  const avg = elapsed > 500 ? (doneWork / elapsed) * 1000 : 0;
  let peak = 0;
  for (let i = 2; i < s.length; i++) {
    const dt = (s[i][0] - s[i - 2][0]) / 1000;
    if (dt > 0) peak = Math.max(peak, (work(s[i]) - work(s[i - 2])) / dt);
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
    update.samples = old.samples.concat(update.samples || []);
  }
  update._polledAt = Date.now();
  jobs.set(update.id, update);
  return update;
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const data = await api.jobs(since);
    since = data.now || since;
    const ids = new Set();
    for (const j of data.jobs) {
      ids.add(j.id);
      onUpdate(merge(j));
    }
    // jobs the NAS forgot (dismissed elsewhere, daemon restarted)
    for (const [id, j] of jobs) if (j.source !== "local" && !ids.has(id)) jobs.delete(id);
    if (firstPoll && new URLSearchParams(location.search).get("xfer") === "last") {
      const last = [...jobs.values()].sort((a, b) => b.created - a.created)[0];
      if (last) setTimeout(() => openDialog(last.id));
    }
    firstPoll = false;
  } catch {
    // the daemon may be restarting: keep the last state and retry
  }
  renderAll();
  schedule();
}

function schedule(ms) {
  clearTimeout(pollTimer);
  const busy = [...jobs.values()].some((j) => active(j) && j.source !== "local");
  const watching = !$("#xfer-drawer").hidden || dialogs.size > 0;
  const wait = ms ?? (busy ? (document.hidden ? 3000 : 700) : watching ? 2000 : 6000);
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

function announce(job) {
  const op = OP[job.op] || OP.copy;
  app?.refreshAfter(job);
  if (allFailed(job)) {
    toast(`${title(job)}: ${firstError(job) || t(STATE.failed)}`, { kind: "error", action: t("Dettagli"), onAction: () => openDialog(job.id), timeout: 9000 });
  } else if (job.state === "done") {
    const errs = job.progress.errors;
    toast(`${t(op.done)}${errs ? " · " + count(errs, "errore", "errori", int) : ""}`, {
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
    new Notification("SynoFile", { body: `${title(job)} · ${t(STATE[job.state])}`, icon: "images/icon_64.png" });
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
  if (finished(job) && !seenFinished.has(job.id)) {
    seenFinished.add(job.id);
    announce(job);
  }
  renderAll();
}

// ---------- actions ----------

export async function start(request) {
  try {
    const { id } = await api.newJob({ conflict: prefs.conflict, verify: prefs.verify, limit: prefs.limit * 1024 * 1024, ...request });
    since = Math.max(0, since - 1);
    await poll();
    if (prefs.openDialog && request.op !== "delete") openDialog(id);
    return id;
  } catch (e) {
    errorToast(e);
    return null;
  }
}

async function control(job, action, extra = {}) {
  if (job.source === "local") {
    local.get(job.id)?.[action]?.(extra);
    renderAll();
    return;
  }
  try {
    await api.control(job.id, action, extra);
  } catch (e) {
    errorToast(e);
  }
  kick();
}

function clearFinished() {
  for (const j of [...jobs.values()]) {
    if (!finished(j)) continue;
    if (j.source === "local") jobs.delete(j.id);
    else api.control(j.id, "dismiss").catch(() => {});
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
    if (job) view.update(job);
  }
}

function renderButton() {
  const list = [...jobs.values()];
  const running = list.filter(active);
  const btn = $("#xfer-btn");
  btn.classList.toggle("active", running.length > 0);
  btn.classList.toggle("attention", running.some((j) => j.state === "conflict" || j.state === "paused"));
  const recentFail = list.some((j) => j.state === "failed" && !j._seenFail);
  btn.classList.toggle("failed", recentFail && !running.length);
  $("#xfer-count").textContent = running.length || (recentFail ? "!" : "");
  let total = 0;
  let done = 0;
  for (const j of running) {
    const st = stats(j);
    total += 1;
    done += st.pct;
  }
  const pct = total ? done / total : 0;
  $("#xfer-ring").style.strokeDashoffset = String(94.25 * (1 - pct));
  btn.title = running.length ? t("Trasferimenti: {n} attivi, {p}%", { n: running.length, p: Math.round(pct * 100) }) : t("Trasferimenti");
}

function toggleDrawer(show) {
  const d = $("#xfer-drawer");
  d.hidden = show === undefined ? !d.hidden : !show;
  if (!d.hidden) {
    for (const j of jobs.values()) if (j.state === "failed") j._seenFail = true;
    renderDrawer();
    const close = (e) => {
      if (!d.contains(e.target) && !$("#xfer-btn").contains(e.target) && !e.target.closest("dialog")) {
        d.hidden = true;
        removeEventListener("mousedown", close, true);
      }
    };
    setTimeout(() => addEventListener("mousedown", close, true));
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
        ? `<span>${st.byBytes ? `${size(job.progress.bytes_done)} / ${size(job.progress.bytes_total)}` : `${int(job.progress.files_done)} / ${int(job.progress.files_total)}`}</span><span>${st.byBytes ? speed(st.now) : ""}${st.eta != null ? " · " + duration(st.eta) : ""}</span>`
        : `<span>${t(STATE[job.state])}</span><span>${Math.round(st.pct * 100)}%</span>`
      : `<span>${job.finished ? clock(job.finished) : ""} · ${duration(job.active_ms)}</span><span>${job.progress.errors ? count(job.progress.errors, "errore", "errori", int) : esc(job.msg || "")}</span>`;
    const card = h(`<div class="jcard">
      <div class="jcard-top"><div class="op">${svg(op.icon)}</div>
        <div class="tt"><b>${esc(title(job))}</b><small>${esc(r.from)} → ${esc(r.to || "")}</small></div>
        <span class="chip ${job.state}">${t(STATE[job.state])}</span></div>
      <div class="pbar thin mini ${barClass(job)}" style="--p:${(st.pct * 100).toFixed(2)}%"><div class="fill"></div></div>
      <div class="jcard-meta">${meta}</div></div>`);
    card.onclick = () => openDialog(job.id);
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
    this.axis = localStorage.getItem("synofile.axis") || "progress";
    const op = OP[job.op] || OP.copy;
    this.dlg = h(`<dialog class="dlg xfer" tabindex="-1">
      <div class="xf-head"><div class="op">${svg(op.icon)}</div>
        <div class="tt"><h2><span class="ttl"></span><span class="chip"></span></h2>
          <div class="route"><span class="from"></span>${svg("forward")}<span class="to"></span></div></div>
        <button class="icon-btn b-min" title="${t("Riduci (continua in background)")}">${svg("minimize")}</button>
      </div>
      <div class="xf-body">
        <div class="xf-steps"></div>
        <div class="xf-pct">
          <div class="big"><span class="pct">0</span><small>%</small></div>
          <div class="side"><div class="bytes"></div><div class="files"></div></div>
        </div>
        <div class="pbar big main"><div class="fill"></div><div class="verify"></div></div>
        <div class="xf-substate"><span class="sub-l"></span><span class="sub-r"></span></div>
        <div class="xf-chart"><canvas></canvas>
          <div class="legend"><span><i style="background:var(--accent)"></i>${t("velocità")}</span><span><i style="background:var(--muted)"></i>${t("media")}</span><span class="axis-toggle" style="pointer-events:auto;cursor:pointer;text-decoration:underline dotted"></span></div>
        </div>
        <div class="xf-stats"></div>
        <div class="xf-current"></div>
        <div class="xf-conflict" hidden></div>
        <details class="xf-errors" hidden><summary></summary><ul></ul></details>
        <div class="xf-summary" hidden></div>
      </div>
      <div class="xf-foot">
        <div class="left">${svg("zap")}<span>${t("Limite")}</span><select class="limit">${LIMITS.map((l) => `<option value="${l}">${l ? speed(l * 1024 * 1024) : t("nessuno")}</option>`).join("")}</select></div>
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
      // the same job again: the NAS gives it a new id
      const old = this.job;
      this.dlg.close();
      api.control(old.id, "retry").then(() => {
        since = 0;
        poll().then(() => {
          const next = [...jobs.values()].filter((j) => j.op === old.op && active(j)).sort((a, b) => b.created - a.created)[0];
          if (next) openDialog(next.id);
        });
      }).catch(errorToast);
    };
    $(".b-open", this.dlg).onclick = () => {
      this.dlg.close();
      app.openPath(this.job.info.dest);
    };
    $(".limit", this.dlg).onchange = (e) => control(this.job, "limit", { bps: +e.target.value * 1024 * 1024 });
    $(".axis-toggle", this.dlg).onclick = () => {
      this.axis = this.axis === "progress" ? "time" : "progress";
      localStorage.setItem("synofile.axis", this.axis);
      this.draw();
    };
    this.canvas.addEventListener("mousemove", (e) => {
      this.hoverX = e.offsetX;
      this.draw();
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
    // no button should look pressed when the dialog opens
    this.dlg.focus();
  }

  destroy() {
    clearInterval(this.tick);
    this.resize.disconnect();
  }

  update(job, tickOnly = false) {
    this.job = job;
    const p = job.progress;
    const st = stats(job);
    this.st = st;
    const d = this.dlg;
    const op = OP[job.op] || OP.copy;
    const r = route(job);
    const state = shownState(job);
    $(".ttl", d).textContent = finished(job) ? (state === "done" ? t(op.done) : title(job)) : t(op.running);
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
    if (job.state === "done") now = "end";
    if (job.state === "queued") now = "";
    const nowIndex = visiblePhases.findIndex(([k]) => k === now);
    const broken = job.state === "failed" || job.state === "cancelled";
    $(".xf-steps", d).innerHTML = visiblePhases
      .map(([k, label], i) => {
        const cls = i < nowIndex || job.state === "done" ? "past" : i === nowIndex ? (broken ? "stop" : "now") : "";
        const mark = cls === "past" ? "✓" : cls === "stop" ? "✕" : i + 1;
        return (i ? `<span class="line ${i <= nowIndex ? "past" : ""}"></span>` : "") + `<span class="st ${cls}"><i>${mark}</i>${t(label)}</span>`;
      })
      .join("");

    // the big numbers
    $(".pct", d).textContent = st.pct >= 0.999 && !finished(job) ? "99,9" : (st.pct * 100).toFixed(st.pct < 0.1 && st.pct > 0 ? 1 : 0).replace(".", ",");
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
    bar.className = "pbar big main " + barClass(job);
    const copyShare = st.verify && st.byBytes ? p.bytes_done / st.totalWork : st.pct;
    bar.style.setProperty("--p", (Math.min(1, copyShare) * 100).toFixed(2) + "%");
    $(".verify", bar).style.width = st.verify && st.byBytes ? ((p.verify_bytes / st.totalWork) * 100).toFixed(2) + "%" : "0";
    $(".verify", bar).style.left = st.verify && st.byBytes ? ((p.bytes_done / st.totalWork) * 100).toFixed(2) + "%" : "0";

    const subL = job.state === "queued" ? t("In attesa che finisca un altro trasferimento") : job.state === "paused" ? t("In pausa") : job.state === "conflict" ? t("In attesa di una tua scelta") : p.scanning ? t("Conteggio di file e cartelle…") : "";
    $(".sub-l", d).textContent = subL;
    const notes = [];
    if (st.verify && st.byBytes) notes.push(t("verificati {a} di {b}", { a: size(p.verify_bytes), b: size(p.bytes_total) }));
    if (p.instant) notes.push(t("{n} senza copiare dati (reflink o rinomina)", { n: int(p.instant) }));
    if (p.skipped) notes.push(t("{n} saltati", { n: int(p.skipped) }));
    $(".sub-r", d).textContent = notes.join(" · ");

    // stats
    const end = st.eta != null ? Date.now() + st.eta : null;
    const methods = {
      clone: t("Reflink btrfs"), copy: t("Copia dati"), rename: t("Rinomina"), recycle: t("Cestino DSM"), delete: t("Eliminazione"),
      deflate: t("Zip (deflate)"), store: t("Zip senza compressione"), "7z": "7-Zip", unrar: "unrar",
    };
    const cells = [
      [t("Velocità"), st.byBytes ? speed(st.now) : t("{n}/s", { n: int(Math.round(st.filesRate)) }), true],
      [t("Media"), st.byBytes ? speed(st.avg) : "—"],
      [t("Picco"), st.byBytes ? speed(st.peak) : "—"],
      [t("File al secondo"), st.filesRate ? st.filesRate.toFixed(st.filesRate < 10 ? 1 : 0).replace(".", ",") : "—"],
      [t("Trascorso"), duration(st.elapsed)],
      [t("Rimanente"), finished(job) ? "—" : st.eta != null ? "~ " + duration(st.eta) : p.scanning ? t("calcolo…") : "—", true],
      [t("Fine prevista"), end ? clock(end) : finished(job) && job.finished ? clock(job.finished) : "—"],
      [t("Metodo"), methods[p.method] || "—"],
    ];
    $(".xf-stats", d).innerHTML = cells.map(([k, v, hl]) => `<div class="stat ${hl ? "hl" : ""}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("");

    // the item in flight
    const cur = $(".xf-current", d);
    if (p.current && active(job)) {
      cur.hidden = false;
      const name = baseName(p.current) || p.current;
      const cp = p.current_size ? Math.min(1, p.current_done / p.current_size) : 0;
      cur.innerHTML = `<div class="row1">${svg(p.phase === "verify" ? "shield" : "file")}<span class="nm">${esc(name)}</span><span class="meth">${esc(p.phase === "verify" ? t("verifica") : methods[p.method] || "")}</span></div>
        <div class="path">${esc(p.current)}</div>
        ${p.current_size ? `<div class="pbar thin ${barClass(job)}" style="--p:${(cp * 100).toFixed(1)}%"><div class="fill"></div></div><div class="row3"><span>${size(p.current_done)} ${t("di")} ${size(p.current_size)}</span><span>${Math.round(cp * 100)}%</span></div>` : ""}`;
    } else cur.hidden = true;

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
          sum.innerHTML = `${svg("shield")}<div style="flex:1"><b>${t("L'archivio è protetto da password")}</b>
            <form class="pw" style="display:flex;gap:8px;margin-top:8px"><input type="password" class="input" style="flex:1" placeholder="${t("Password")}" autocomplete="off"><button class="btn primary">${t("Estrai")}</button></form></div>`;
          const form = $(".pw", sum);
          form.onsubmit = (e) => {
            e.preventDefault();
            const password = $("input", form).value;
            if (!password) return;
            this.dlg.close();
            api.control(job.id, "retry", { password }).then(() => {
              since = 0;
              poll().then(() => {
                const next = [...jobs.values()].filter((j) => j.op === "extract" && active(j)).sort((a, b) => b.created - a.created)[0];
                if (next) openDialog(next.id);
              });
            }).catch(errorToast);
          };
          setTimeout(() => $("input", form)?.focus());
        }
      } else {
        const head = allFailed(job) ? `${t(STATE.failed)}: ${firstError(job)}` : job.state === "done" ? t(op.done) : `${t(STATE[job.state])}: ${job.msg}`;
        sum.innerHTML = `${svg(ok ? "check" : "alert")}<div><b>${esc(head)}</b>${esc(parts.join(" · "))}</div>`;
      }
    } else sum.hidden = true;

    // buttons
    $(".b-pause", d).hidden = finished(job) || job.state === "queued" || job.op === "delete" && job.source !== "local";
    $(".b-pause", d).innerHTML = job.state === "paused" ? `${svg("play")} ${t("Riprendi")}` : `${svg("pause")} ${t("Pausa")}`;
    $(".b-cancel", d).hidden = finished(job);
    $(".b-start", d).hidden = job.state !== "queued" || job.source === "local";
    $(".b-close", d).hidden = !finished(job);
    $(".b-open", d).hidden = !finished(job) || !job.info.dest;
    $(".b-retry", d).hidden = !job.interrupted;
    $(".xf-foot .left", d).style.visibility = finished(job) || job.op === "delete" ? "hidden" : "visible";
    const sel = $(".limit", d);
    const mb = Math.round((job.limit || 0) / 1024 / 1024);
    if (document.activeElement !== sel) {
      if (![...sel.options].some((o) => +o.value === mb)) sel.append(h(`<option value="${mb}">${speed(mb * 1024 * 1024)}</option>`));
      sel.value = String(mb);
    }
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
    box.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => {
      control(job, "answer", { policy: b.dataset.a, all: $(".all", box).checked, conflict: c.id });
      box.hidden = true;
    }));
  }

  renderErrors(job) {
    const box = $(".xf-errors", this.dlg);
    const errs = job.errors || [];
    box.hidden = !errs.length;
    if (!errs.length) return;
    $("summary", box).textContent = count(job.progress.errors || errs.length, "errore", "errori", int);
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
    const css = getComputedStyle(document.documentElement);
    const col = (v) => css.getPropertyValue(v).trim();
    const st = this.st || stats(job);
    const work = (x) => (st.byBytes ? x[1] + x[3] : x[2]);
    const s = job.samples;
    const pad = { l: 8, r: 64, t: 26, b: 18 };
    const w = W - pad.l - pad.r;
    const hh = H - pad.t - pad.b;

    // speed per sample, smoothed over a short window
    const pts = [];
    for (let i = 1; i < s.length; i++) {
      let k = i - 1;
      while (k > 0 && s[i][0] - s[k][0] < 1500) k--;
      const dt = (s[i][0] - s[k][0]) / 1000;
      const v = dt > 0 ? Math.max(0, (work(s[i]) - work(s[k])) / dt) : 0;
      const verifying = s[i][3] > s[i - 1][3];
      const gap = s[i][0] - s[i - 1][0] > 2500;
      pts.push({ t: s[i][0], w: work(s[i]), v, verifying, gap });
    }
    const xmax = this.axis === "progress" ? Math.max(1, st.totalWork) : Math.max(30000, st.elapsed, s.length ? s[s.length - 1][0] : 0);
    const xOf = (p) => pad.l + (Math.min(xmax, this.axis === "progress" ? p.w : p.t) / xmax) * w;
    // the scale ignores the odd spike (a reflink of a big file is instant)
    const sorted = pts.map((p) => p.v).sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    let ymax = Math.max(p95 * 1.25, st.avg * 1.3, 1);
    const nice = niceStep(ymax / 3);
    ymax = nice * Math.ceil(ymax / nice);
    const yOf = (v) => pad.t + hh - (Math.min(v, ymax) / ymax) * hh;

    if (pts.length < 2) {
      g.fillStyle = col("--faint");
      g.font = "12px " + col("--font");
      g.textAlign = "center";
      g.fillText(active(job) ? t("in attesa dei primi dati…") : t("nessun dato"), W / 2, H / 2 + 6);
      g.textAlign = "start";
      return;
    }
    // grid
    g.font = "10.5px " + col("--font");
    g.textBaseline = "middle";
    for (let k = 0; k <= ymax / nice; k++) {
      const y = yOf(k * nice);
      g.strokeStyle = col("--border");
      g.lineWidth = 1;
      g.setLineDash(k ? [2, 4] : []);
      g.beginPath();
      g.moveTo(pad.l, Math.round(y) + 0.5);
      g.lineTo(pad.l + w, Math.round(y) + 0.5);
      g.stroke();
      if (k) {
        g.fillStyle = col("--faint");
        g.fillText(st.byBytes ? speed(k * nice) : t("{n}/s", { n: int(k * nice) }), pad.l + w + 6, y);
      }
    }
    g.setLineDash([]);
    // the progress so far, faintly, on the progress axis
    if (this.axis === "progress") {
      g.fillStyle = col("--accent-soft");
      g.globalAlpha = 0.45;
      g.fillRect(pad.l, pad.t, (st.doneWork / xmax) * w, hh);
      g.globalAlpha = 1;
    } else {
      g.fillStyle = col("--faint");
      g.textBaseline = "alphabetic";
      g.fillText(fmtTime(0), pad.l, H - 4);
      const endLabel = fmtTime(xmax);
      g.fillText(endLabel, pad.l + w - g.measureText(endLabel).width, H - 4);
    }
    if (pts.length > 1) {
      const accent = col("--accent");
      const grad = g.createLinearGradient(0, pad.t, 0, pad.t + hh);
      grad.addColorStop(0, hexA(accent, 0.45));
      grad.addColorStop(1, hexA(accent, 0.02));
      // area
      g.beginPath();
      g.moveTo(xOf(pts[0]), yOf(0));
      for (const p of pts) g.lineTo(xOf(p), yOf(p.gap ? 0 : p.v));
      g.lineTo(xOf(pts[pts.length - 1]), yOf(0));
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      // line, green where the data is being verified
      g.lineWidth = 2;
      g.lineJoin = "round";
      for (let i = 1; i < pts.length; i++) {
        g.strokeStyle = pts[i].verifying ? col("--ok") : accent;
        g.beginPath();
        g.moveTo(xOf(pts[i - 1]), yOf(pts[i - 1].gap ? 0 : pts[i - 1].v));
        g.lineTo(xOf(pts[i]), yOf(pts[i].gap ? 0 : pts[i].v));
        g.stroke();
      }
      // the head of the line
      const last = pts[pts.length - 1];
      if (active(job)) {
        g.fillStyle = accent;
        g.beginPath();
        g.arc(xOf(last), yOf(last.v), 3.5, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = hexA(accent, 0.35);
        g.lineWidth = 6;
        g.stroke();
      }
    }
    // average
    if (st.avg > 0) {
      const y = yOf(st.avg);
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
      for (const p of pts) if (Math.abs(xOf(p) - this.hoverX) < Math.abs(xOf(best) - this.hoverX)) best = p;
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
      this.tip.textContent = `${fmtTime(best.t)} · ${st.byBytes ? speed(best.v) : t("{n}/s", { n: int(best.v) })} · ${pct}%`;
      this.tip.style.left = Math.min(W - this.tip.offsetWidth - 4, Math.max(4, x - this.tip.offsetWidth / 2)) + "px";
      this.tip.style.top = "4px";
      this.tip.hidden = false;
    } else if (this.tip) this.tip.hidden = true;
  }
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function niceStep(x) {
  if (x <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

function hexA(color, a) {
  const m = color.match(/^#([0-9a-f]{6})$/i);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function all() {
  return [...jobs.values()];
}
