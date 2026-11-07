// HEIC/HEIF previews: decoded in a worker (see heic-worker.js) one at a
// time, kept as object URLs so scrolling back and reopening are instant.
// The queue lives here, not in the worker: a photo whose tile scrolled away
// or whose folder was left before its turn is dropped, not decoded.

import { api } from "./api.js";

export const isHeic = (name) => /\.(heic|heif)$/i.test(name);

// Bigger photos are not worth the wait or the memory.
export const HEIC_LIMIT = 40 * 1024 * 1024;

const CACHE_SIZE = 300;
const cache = new Map(); // key → Promise<object URL>
const queue = []; // entries waiting for the worker, in order
const queued = new Map(); // key → its entry in `queue`
let worker = null;
let current = null; // the entry the worker is decoding

function spawn() {
  const src = new URL("./heic-worker.js", import.meta.url);
  src.search = new URL(import.meta.url).search;
  worker = new Worker(src);
  worker.onmessage = ({ data }) => {
    const job = current;
    current = null;
    if (job) {
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(URL.createObjectURL(data.blob));
    }
    pump();
  };
  worker.onerror = () => {
    current?.reject(new Error("heic worker failed"));
    current = null;
    worker = null;
    pump();
  };
}

/** Still wanted: asked for without an image (the preview), or one of its images is on the page. */
const wanted = (entry) => !entry.imgs || entry.imgs.some((img) => img.isConnected);

/** Hands the worker the next photo still wanted. */
function pump() {
  while (!current && queue.length) {
    const entry = queue.shift();
    queued.delete(entry.key);
    if (!wanted(entry)) {
      entry.reject(new Error("gone"));
      continue;
    }
    if (!worker) spawn();
    current = entry;
    worker.postMessage({ id: entry.key, url: new URL(api.view(entry.e.path), location.href).href, max: entry.max });
  }
}

/// An object URL with a JPEG of the photo, at most `max` pixels on the long
/// side. With `img`, the decoding is skipped if the image has left the page
/// by its turn (the promise then rejects).
export function heicURL(e, max, img) {
  const key = `${e.path}|${e.mtime}|${e.size}|${max}`;
  let p = cache.get(key);
  if (p) {
    cache.delete(key);
    cache.set(key, p);
    // one more image waiting for it, or someone who wants it anyway
    const entry = queued.get(key);
    if (entry && entry.imgs) {
      if (img) entry.imgs.push(img);
      else entry.imgs = null;
    }
    return p;
  }
  const entry = { key, e, max, imgs: img ? [img] : null };
  p = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
  const mine = p;
  p.catch(() => cache.get(key) === mine && cache.delete(key));
  cache.set(key, p);
  queue.push(entry);
  queued.set(key, entry);
  while (cache.size > CACHE_SIZE) {
    const [old, url] = cache.entries().next().value;
    cache.delete(old);
    // one pushed out before its turn is not decoded at all
    const waiting = queued.get(old);
    if (waiting) {
      queue.splice(queue.indexOf(waiting), 1);
      queued.delete(old);
      waiting.reject(new Error("gone"));
    }
    // the one being decoded may be on its way into an <img>: give it time to load
    const late = current?.key === old ? 30000 : 0;
    url.then((u) => (late ? setTimeout(() => URL.revokeObjectURL(u), late) : URL.revokeObjectURL(u)), () => {});
  }
  pump();
  return p;
}

/// Fills `<img data-heic>` placeholders inside `root` once their photo is
/// decoded; the icon next to it stays until then, and for good on failure.
export function fillHeic(root, find, max) {
  for (const img of root.querySelectorAll("img[data-heic]")) {
    const e = find(img);
    if (!e) continue;
    heicURL(e, max, img).then(
      (u) => {
        if (!img.isConnected) return;
        img.onload = () => img.parentElement?.querySelectorAll(".gi").forEach((g) => g.remove());
        img.src = u;
      },
      () => {},
    );
  }
}
