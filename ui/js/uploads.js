// Uploads from this computer: files and whole folders, in chunks the NAS
// writes into a hidden file and renames into place with the last one. A
// chunk that fails is retried from where the NAS says it got to.

import { api, url, call } from "./api.js";
import { prefs } from "./prefs.js";
import { t } from "./i18n.js";
import { joinPath } from "./format.js";
import { registerLocal, updateLocal } from "./transfers.js";
import { dialog, errorToast } from "./ui.js";
import { svg } from "./icons.js";
import { esc, size } from "./format.js";

const CHUNK = 8 * 1024 * 1024;

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
  let taken = [];
  try {
    taken = (await api.exists(dest, tops)).taken;
  } catch (e) {
    return errorToast(e);
  }
  let policy = prefs.conflict === "ask" ? "ask" : prefs.conflict === "newer" ? "overwrite" : prefs.conflict;
  if (taken.length && policy === "ask") policy = await askConflicts(taken);
  if (policy === "cancel") return;
  const takenNames = new Set(taken.map((x) => x.name));
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
  const plan = [];
  for (const it of items) {
    const [top, ...rest] = it.rel.split("/");
    if (takenNames.has(top) && policy === "skip") continue;
    const rel = [rename.get(top) || top, ...rest].join("/");
    plan.push({ ...it, rel });
  }
  const files = plan.filter((i) => !i.dir);
  const dirs = new Set(plan.filter((i) => i.dir).map((i) => i.rel));
  for (const f of files) {
    const parts = f.rel.split("/");
    for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/"));
  }
  const total = files.reduce((a, f) => a + f.file.size, 0);
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
      phase: "copy", bytes_total: total, bytes_done: 0, files_total: files.length, files_done: 0, dirs: dirs.size,
      skipped: 0, errors: 0, current: "", current_size: 0, current_done: 0, method: "copy", instant: 0, scanning: false, verify_bytes: 0,
    },
    samples: [[0, 0, 0, 0]],
  };
  let paused = false;
  let cancelled = false;
  let xhr = null;
  let resumeWait = null;
  let runSince = performance.now();
  const settle = () => {
    const now = performance.now();
    if (job.state === "running") job.active_ms += now - runSince;
    runSince = now;
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
    cancel() {
      cancelled = true;
      xhr?.abort();
      resumeWait?.();
    },
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

  // folders first, in order, parents before children
  for (const d of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if (cancelled) break;
    try {
      await api.mkdir(dest, d, true);
    } catch (e) {
      fail(d, e.message);
    }
  }

  const sendChunk = (f, dir, name, offset, blob) =>
    new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      const params = { dir, name, offset, total: f.file.size, mtime: Math.floor(f.file.lastModified / 1000), overwrite: policy === "overwrite" ? 1 : undefined };
      xhr.open("POST", url("upload", params));
      xhr.withCredentials = true;
      const token = new URL(url("x"), location.href).searchParams.get("SynoToken");
      if (token) xhr.setRequestHeader("X-SYNO-TOKEN", token);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      let sent = 0;
      xhr.upload.onprogress = (e) => {
        const d = e.loaded - sent;
        sent = e.loaded;
        job.progress.bytes_done += d;
        job.progress.current_done += d;
        sample(false);
      };
      xhr.onload = () => {
        // count what onprogress missed
        const rest = blob.size - sent;
        job.progress.bytes_done += rest;
        job.progress.current_done += rest;
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status === 200) resolve(data);
        else {
          job.progress.bytes_done -= blob.size;
          job.progress.current_done -= blob.size;
          reject(Object.assign(new Error((data && data.error) || `HTTP ${xhr.status}`), { status: xhr.status }));
        }
      };
      xhr.onerror = () => {
        job.progress.bytes_done -= sent;
        job.progress.current_done -= sent;
        reject(Object.assign(new Error(t("connessione interrotta")), { network: true }));
      };
      xhr.onabort = () => {
        job.progress.bytes_done -= sent;
        job.progress.current_done -= sent;
        reject(Object.assign(new Error("abort"), { abort: true }));
      };
      xhr.send(blob);
    });

  for (const f of files) {
    if (cancelled) break;
    const parts = f.rel.split("/");
    const name = parts.pop();
    const dir = parts.length ? joinPath(dest, parts.join("/")) : dest;
    const p = job.progress;
    p.current = f.rel;
    p.current_size = f.file.size;
    p.current_done = 0;
    let offset = 0;
    let tries = 0;
    let ok = true;
    do {
      if (paused) await new Promise((r) => (resumeWait = r));
      if (cancelled) break;
      const blob = f.file.slice(offset, offset + CHUNK);
      try {
        const r = await sendChunk(f, dir, name, offset, blob);
        offset = r.received;
        tries = 0;
      } catch (e) {
        if (e.abort) break;
        if (e.status === 409 && offset === 0 && /esiste|exists/i.test(e.message)) {
          fail(f.rel, t("esiste già"));
          ok = false;
          break;
        }
        if (++tries > 4) {
          fail(f.rel, e.message);
          ok = false;
          break;
        }
        // ask the NAS where it got to, then carry on from there
        await new Promise((r) => setTimeout(r, 800 * tries));
        try {
          const st = await call("upload/status", { params: { dir, name } });
          if (st) offset = st.received;
        } catch {}
        p.bytes_done = p.bytes_done - p.current_done + offset;
        p.current_done = offset;
      }
    } while (offset < f.file.size);
    if (f.file.size === 0 && !cancelled && ok) {
      try {
        await sendChunk(f, dir, name, 0, new Blob([]));
      } catch (e) {
        fail(f.rel, e.message);
        ok = false;
      }
    }
    if (cancelled) {
      fetch(url("upload/abort", { dir, name }), { method: "POST", credentials: "same-origin", body: "{}" }).catch(() => {});
      break;
    }
    if (!ok) p.bytes_done += f.file.size - p.current_done;
    p.files_done++;
    sample(false);
  }
  settle();
  job.state = cancelled ? "cancelled" : "done";
  job.finished = Date.now();
  job.msg = cancelled ? t("annullato") : t("completato");
  job.progress.current = "";
  sample(true);
  updateLocal(job);
  onDone?.(job);
}
