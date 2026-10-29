// HEIC/HEIF previews: decoded in a worker (see heic-worker.js) one at a
// time, kept as object URLs so scrolling back and reopening are instant.

import { api } from "./api.js";

export const isHeic = (name) => /\.(heic|heif)$/i.test(name);

// Bigger photos are not worth the wait or the memory.
export const HEIC_LIMIT = 40 * 1024 * 1024;

const CACHE_SIZE = 300;
const cache = new Map(); // key → Promise<object URL>
let worker = null;
let seq = 0;
const waiting = new Map(); // id → {resolve, reject}

function spawn() {
  const src = new URL("./heic-worker.js", import.meta.url);
  src.search = new URL(import.meta.url).search;
  worker = new Worker(src);
  worker.onmessage = ({ data }) => {
    const job = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error) job?.reject(new Error(data.error));
    else job?.resolve(URL.createObjectURL(data.blob));
  };
  worker.onerror = () => {
    for (const job of waiting.values()) job.reject(new Error("heic worker failed"));
    waiting.clear();
    worker = null;
  };
}

/// An object URL with a JPEG of the photo, at most `max` pixels on the long side.
export function heicURL(e, max) {
  const key = `${e.path}|${e.mtime}|${e.size}|${max}`;
  let p = cache.get(key);
  if (p) {
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  if (!worker) spawn();
  const id = ++seq;
  p = new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, url: new URL(api.view(e.path), location.href).href, max });
  });
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > CACHE_SIZE) {
    const [old, url] = cache.entries().next().value;
    cache.delete(old);
    url.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return p;
}

/// Fills `<img data-heic>` placeholders inside `root` once their photo is
/// decoded; the icon next to it stays until then, and for good on failure.
export function fillHeic(root, find, max) {
  for (const img of root.querySelectorAll("img[data-heic]")) {
    const e = find(img);
    if (!e) continue;
    heicURL(e, max).then(
      (u) => {
        if (!img.isConnected) return;
        img.onload = () => img.parentElement?.querySelectorAll(".gi").forEach((g) => g.remove());
        img.src = u;
      },
      () => {},
    );
  }
}
