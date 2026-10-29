// Decodes HEIC/HEIF photos off the main thread: browsers other than Safari
// cannot show them, so libheif (compiled to WebAssembly) turns the primary
// image into a JPEG, scaled down to the size asked for.

const version = self.location.search;
importScripts(`../vendor/libheif/libheif.js${version}`);

let lib = null;
const ready = () => (lib ??= Promise.resolve(self.libheif({ locateFile: (f) => `../vendor/libheif/${f}${version}` })));

// One photo at a time: a 12 MP image is ~50 MB of pixels while decoding.
let queue = Promise.resolve();
self.onmessage = ({ data }) => (queue = queue.then(() => decode(data)));

async function decode({ id, url, max }) {
  try {
    const heif = await ready();
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const images = new heif.HeifDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    if (!images.length) throw new Error("no image");
    const image = images.find((i) => i.is_primary?.()) || images[0];
    const width = image.get_width();
    const height = image.get_height();
    const pixels = await new Promise((resolve, reject) =>
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? resolve(d) : reject(new Error("decode failed")))));
    for (const i of images) i.free?.();
    const scale = Math.min(1, max / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const full = new OffscreenCanvas(width, height);
    full.getContext("2d").putImageData(new ImageData(pixels.data, width, height), 0, 0);
    let out = full;
    if (scale < 1) {
      out = new OffscreenCanvas(w, h);
      const ctx = out.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full, 0, 0, w, h);
    }
    const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.88 });
    self.postMessage({ id, blob, width, height });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
}
