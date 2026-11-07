// Uploads from this computer: files and whole folders, in chunks the NAS
// writes into a hidden file and renames into place with the last one. Each
// chunk is a request of its own, and DSM checks the session of every one:
// so several go at once, else those pauses add up (120 MB/s on 2.5 GbE).
// The first chunk creates the file and the last one renames it, each on its
// own; the ones between go in parallel. Every attempt at a file has an id of
// its own, which names its hidden file: a chunk sent again lands in the same
// one, a file started again does not mix with the old pieces.

import { api, call, url, refreshToken, synoToken, notifyUnauth } from "./api.js";
import { prefs } from "./prefs.js";
import { t } from "./i18n.js";
import { esc, size, joinPath } from "./format.js";
import { registerLocal, updateLocal } from "./transfers.js";
import { dialog, errorToast } from "./ui.js";
import { svg } from "./icons.js";

const CHUNK = 16 * 1024 * 1024;
// chunks in flight at once
const PARALLEL = 4;
// attempts at one chunk, for the failures worth another go
const TRIES = 5;

/** A fresh id for one attempt at one file (`[0-9a-f]{24}`). */
function uploadId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// a dropped connection, a timeout, a busy or broken server: sent again
const retryable = (e) => e.network || e.status === 408 || e.status === 429 || (e.status >= 500 && e.status !== 507);
// no permission, no room: every other file would fail the same way
const fatal = (e) => e.status === 403 || e.status === 507;
const aborted = () => Object.assign(new Error("abort"), { abort: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Files from a drop, folders included (webkitGetAsEntry). */
export async function fromDataTransfer(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, rel: file.name }));
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix + entry.name });
    } else if (entry.isDirectory) {
      out.push({ dir: true, rel: prefix + entry.name });
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export function fromInput(files) {
  return [...files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
}

/** Asks what to do with names the folder already has. */
function askConflicts(taken) {
  return new Promise((resolve) => {
    const dlg = dialog(`
      <div class="dlg-head"><div class="dlg-icon">${svg("alert")}</div><h2>${t("Alcuni elementi esistono già")}</h2></div>
      <div class="dlg-body"><p>${t("Nella cartella di destinazione ci sono già {n} elementi con lo stesso nome:", { n: taken.length })}</p>
        <div class="item-list">${taken.slice(0, 40).map((x) => `<div>${esc(x.name)} <span class="hint">${x.dir ? t("cartella") : size(x.size)}</span></div>`).join("")}</div></div>
      <div class="dlg-foot"><button class="btn" data-a="cancel">${t("Annulla")}</button><button class="btn" data-a="skip">${t("Salta")}</button><button class="btn" data-a="rename">${t("Mantieni entrambi")}</button><button class="btn primary" data-a="overwrite">${t("Sovrascrivi")}</button></div>`);
    let answer = "cancel";
    dlg.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => {
      answer = b.dataset.a;
      dlg.close();
    }));
    dlg.addEventListener("close", () => resolve(answer));
  });
}

function freeName(name, used) {
  const i = name.lastIndexOf(".");
  const [stem, ext] = i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
  for (let n = 1; ; n++) {
    const c = `${stem} (${n})${ext}`;
    if (!used.has(c)) return c;
  }
}

export async function upload(dest, items, onDone) {
  if (!items.length) return;
  // what the destination already has, among the top-level names
  const tops = [...new Set(items.map((i) => i.rel.split("/")[0]))];
  const dirTops = new Set(items.filter((i) => i.dir || i.rel.includes("/")).map((i) => i.rel.split("/")[0]));
  let taken = [];
  try {
    taken = (await api.exists(dest, tops)).taken;
  } catch (e) {
    return errorToast(e);
  }
  let policy = ["overwrite", "skip", "rename", "newer"].includes(prefs.conflict) ? prefs.conflict : "ask";
  if (taken.length && policy === "ask") policy = await askConflicts(taken);
  if (policy === "cancel") return;
  const takenBy = new Map(taken.map((x) => [x.name, x]));
  const rename = new Map();
  if (taken.length && policy === "rename") {
    const used = new Set(tops);
    taken.forEach((x) => used.add(x.name));
    for (const x of taken) {
      const n = freeName(x.name, used);
      used.add(n);
      rename.set(x.name, n);
    }
  }
  // a folder on both sides is merged: what it holds follows the policy file by file
  const merged = new Set(taken.filter((x) => x.dir && dirTops.has(x.name) && policy !== "rename").map((x) => x.name));
  const plan = [];
  let skippedFiles = 0;
  let skippedBytes = 0;
  for (const it of items) {
    const [top, ...rest] = it.rel.split("/");
    if (takenBy.has(top) && policy === "skip" && !merged.has(top)) {
      // a file, or a folder against a file: left as it is, counted as skipped
      if (!it.dir) {
        skippedFiles++;
        skippedBytes += it.file.size;
      }
      continue;
    }
    plan.push({ ...it, rel: [rename.get(top) || top, ...rest].join("/"), merged: merged.has(top) });
  }
  const files = plan.filter((i) => !i.dir);
  const dirs = new Set(plan.filter((i) => i.dir).map((i) => i.rel));
  for (const f of files) {
    const parts = f.rel.split("/");
    for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/"));
  }
  // mkdir with parents creates the ancestors too: only the deepest folders are asked for
  const inner = new Set();
  for (const d of dirs) {
    const parts = d.split("/");
    for (let k = 1; k < parts.length; k++) inner.add(parts.slice(0, k).join("/"));
  }
  const leaves = [...dirs].filter((d) => !inner.has(d));
  const total = files.reduce((a, f) => a + f.file.size, 0) + skippedBytes;
  const job = {
    op: "upload",
    info: { sources: tops.map((n) => joinPath(dest, n)), dest },
    state: "running",
    created: Date.now(),
    started: Date.now(),
    finished: null,
    active_ms: 0,
    verify: false,
    limit: 0,
    errors: [],
    conflict: null,
    msg: "",
    progress: {
      phase: "copy", bytes_total: total, bytes_done: skippedBytes, files_total: files.length + skippedFiles, files_done: skippedFiles, dirs: dirs.size,
      skipped: skippedFiles, errors: 0, current: "", current_size: 0, current_done: 0, method: "copy", instant: 0, scanning: false, verify_bytes: 0,
    },
    samples: [[0, 0, 0, 0]],
  };
  let paused = false;
  let cancelled = false;
  // what stops the whole job (session gone, no permission, no room): one message
  let failure = null;
  const xhrs = new Set();
  let resumeWait = null;
  let pausedP = null;
  // every chunk in flight waits here while paused
  const gate = () => (pausedP ||= new Promise((r) => (resumeWait = () => ((pausedP = null), r()))));
  let runSince = performance.now();
  const settle = () => {
    const now = performance.now();
    if (job.state === "running") job.active_ms += now - runSince;
    runSince = now;
  };
  const stopAll = () => {
    cancelled = true;
    xhrs.forEach((x) => x.abort());
    resumeWait?.();
  };
  const controller = {
    pause() {
      if (job.state !== "running") return;
      paused = true;
      settle();
      job.state = "paused";
      updateLocal(job);
    },
    resume() {
      if (job.state !== "paused") return;
      paused = false;
      runSince = performance.now();
      job.state = "running";
      resumeWait?.();
      updateLocal(job);
    },
    cancel: stopAll,
  };
  registerLocal(job, controller);
  let lastSample = 0;
  job._t0 = performance.now();
  const sample = (force) => {
    const now = performance.now();
    if (!force && now - lastSample < 500) return;
    lastSample = now;
    settle();
    const p = job.progress;
    job.samples.push([Math.round(now - job._t0), p.bytes_done, p.files_done, 0]);
    updateLocal(job);
  };

  const fail = (path, msg) => {
    job.progress.errors++;
    if (job.errors.length < 500) job.errors.push({ path, msg });
  };
  const stopJob = (e) => {
    failure ||= e;
    stopAll();
  };
  const sessionGone = () => {
    notifyUnauth();
    return Object.assign(new Error(t("Sessione DSM scaduta")), { fatal: true });
  };

  // the folders, before any file; one that fails takes its files with it
  const brokenDirs = new Map(); // relative path -> reason
  for (const d of leaves) {
    if (cancelled) break;
    try {
      await api.mkdir(dest, d, true);
    } catch (e) {
      if (e.status === 401) stopJob(sessionGone());
      else if (fatal(e)) stopJob(e);
      else {
        brokenDirs.set(d, e.message);
        fail(d, e.message);
      }
    }
  }
  const brokenDir = (rel) => {
    for (const [d, msg] of brokenDirs) if (d === rel || rel.startsWith(d + "/")) return msg;
    return null;
  };

  // what a merged folder already holds, asked once per folder, so that
  // "skip" and "newer" decide before sending a byte
  const namesIn = new Map(); // folder path -> names of the files going there
  const where = (f) => {
    const parts = f.rel.split("/");
    const name = parts.pop();
    return { name, rel: parts.join("/"), dir: parts.length ? joinPath(dest, parts.join("/")) : dest };
  };
  if (policy === "skip" || policy === "newer") {
    for (const f of files) {
      if (!f.merged) continue;
      const w = where(f);
      if (!namesIn.has(w.dir)) namesIn.set(w.dir, []);
      namesIn.get(w.dir).push(w.name);
    }
  }
  const known = new Map([[dest, Promise.resolve(takenBy)]]);
  const lookup = async (dir, name) => {
    if (policy !== "skip" && policy !== "newer") return null;
    let m = known.get(dir);
    if (!m && namesIn.has(dir)) {
      // on failure the NAS decides on its own, at the first chunk
      m = api.exists(dir, namesIn.get(dir)).then((r) => new Map(r.taken.map((x) => [x.name, x])), () => new Map());
      known.set(dir, m);
    }
    return m ? (await m).get(name) || null : null;
  };

  const sendChunk = (run, offset) =>
    new Promise((resolve, reject) => {
      const { f } = run;
      const blob = f.file.slice(offset, offset + CHUNK);
      const p = job.progress;
      const xhr = new XMLHttpRequest();
      xhrs.add(xhr);
      xhr.onloadend = () => xhrs.delete(xhr);
      const params = {
        dir: run.dir, name: run.name, id: run.id, offset, total: f.file.size, mtime: run.mtime,
        overwrite: policy === "overwrite" ? 1 : undefined, newer: policy === "newer" ? 1 : undefined,
      };
      xhr.open("POST", url("upload", params));
      xhr.withCredentials = true;
      const token = synoToken();
      if (token) xhr.setRequestHeader("X-SYNO-TOKEN", token);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      let sent = 0;
      xhr.upload.onprogress = (e) => {
        const d = e.loaded - sent;
        sent = e.loaded;
        p.bytes_done += d;
        p.current_done += d;
        sample(false);
      };
      const takeBack = () => {
        p.bytes_done -= sent;
        p.current_done -= sent;
      };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 200) {
          // count what onprogress missed
          const rest = blob.size - sent;
          p.bytes_done += rest;
          p.current_done += rest;
          resolve(data);
        } else {
          takeBack();
          // errors DSM's nginx would hide come as 422 with the real status aside
          const status = +xhr.getResponseHeader("X-Synofile-Status") || xhr.status;
          reject(Object.assign(new Error((data && data.error) || t("errore {n}", { n: status })), { status, offset }));
        }
      };
      xhr.onerror = () => {
        takeBack();
        reject(Object.assign(new Error(t("connessione interrotta")), { network: true, offset }));
      };
      xhr.onabort = () => {
        takeBack();
        reject(aborted());
      };
      xhr.send(blob);
    });

  // one chunk, sent again when that may help: a chunk written twice is the same data
  const sendRetrying = async (run, offset) => {
    let refreshed = false;
    for (let tries = 1; ; ) {
      if (paused) await gate();
      if (cancelled || run.stop) throw aborted();
      try {
        return await sendChunk(run, offset);
      } catch (e) {
        if (e.abort || cancelled || run.stop) throw e;
        if (e.status === 401) {
          // DSM handed out a new token meanwhile, or the session is over
          if (!refreshed && (await refreshToken())) {
            refreshed = true;
            continue;
          }
          throw sessionGone();
        }
        if (fatal(e)) throw Object.assign(e, { fatal: true });
        if (!retryable(e) || tries >= TRIES) throw e;
        await sleep(800 * tries);
        tries++;
      }
    }
  };

  // the hidden file of an attempt that did not make it
  const dropPart = (run) => call("upload/abort", { params: { dir: run.dir, name: run.name, id: run.id }, body: {} }).catch(() => {});

  // one file, start to end: "done", "skipped", or throws
  const sendFile = async (f, w, mtime) => {
    const p = job.progress;
    const size = f.file.size;
    // an empty file, or one of a single chunk, is all in the first request
    const last = size > 0 ? Math.floor((size - 1) / CHUNK) * CHUNK : 0;
    for (let attempt = 1; ; attempt++) {
      const run = { f, dir: w.dir, name: w.name, mtime, id: uploadId(), stop: false, error: null };
      try {
        // the first chunk creates the hidden file (or finds the name taken)
        const first = await sendRetrying(run, 0);
        if (first?.skipped) return "skipped";
        if (last > 0) {
          // the ones between, several at once; the last renames the file, so it goes after them all
          let next = CHUNK;
          const worker = async () => {
            while (next < last && !cancelled && !run.stop) {
              const offset = next;
              next += CHUNK;
              try {
                await sendRetrying(run, offset);
              } catch (e) {
                // the first failure stops the other chunks of this file
                if (!run.stop) {
                  run.stop = true;
                  run.error = e;
                  xhrs.forEach((x) => x.abort());
                }
                return;
              }
            }
          };
          await Promise.all(Array.from({ length: PARALLEL }, worker));
          if (run.error) throw run.error;
          if (cancelled) throw aborted();
          await sendRetrying(run, last);
        }
        return "done";
      } catch (e) {
        // a name taken at the first chunk: nothing was written
        const taken = e.status === 409 && e.offset === 0;
        if (!taken) dropPart(run);
        // the hidden file went missing (cleaned up meanwhile): once more from the start
        if (e.status === 409 && e.offset > 0 && attempt === 1 && !cancelled) {
          p.bytes_done -= p.current_done;
          p.current_done = 0;
          continue;
        }
        throw e;
      }
    }
  };

  for (const f of files) {
    if (cancelled) break;
    const w = where(f);
    const p = job.progress;
    p.current = f.rel;
    p.current_size = f.file.size;
    p.current_done = 0;
    const mtime = Math.floor(f.file.lastModified / 1000);
    let outcome = null;
    let error = brokenDir(w.rel);
    if (!error) {
      const old = await lookup(w.dir, w.name);
      if (cancelled) break;
      if (old && (policy === "skip" || (policy === "newer" && !old.dir && old.mtime >= mtime))) outcome = "skipped";
      else {
        try {
          outcome = await sendFile(f, w, mtime);
        } catch (e) {
          if (e.fatal) stopJob(e);
          else if (!e.abort) {
            const exists = e.status === 409 && e.offset === 0 && policy !== "overwrite" && policy !== "newer";
            if (exists && policy === "skip") outcome = "skipped";
            else error = exists ? t("esiste già") : e.message;
          }
        }
      }
    }
    if (cancelled) break;
    if (outcome === "skipped") p.skipped++;
    else if (outcome !== "done") fail(f.rel, error || t("non riuscito"));
    // skipped or failed: its bytes count as handled, so the bar and the time left stay true
    p.bytes_done += f.file.size - p.current_done;
    p.current_done = f.file.size;
    p.files_done++;
    sample(false);
  }
  settle();
  job.state = failure ? "failed" : cancelled ? "cancelled" : "done";
  job.finished = Date.now();
  job.msg = failure ? failure.message : cancelled ? t("annullato") : t("completato");
  job.progress.current = "";
  sample(true);
  updateLocal(job);
  onDone?.(job);
}
