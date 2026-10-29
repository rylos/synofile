// The image viewer of quick look: fits the picture to the window by default,
// zooms with the wheel (around the pointer), the buttons or + - 0 1, pans by
// dragging, and a double click switches between fit and 100%.

const MIN = 0.05;
const MAX = 16;

export function imageViewer(stage, img, onChange) {
  let scale = 1;
  let fitted = true;
  let x = 0;
  let y = 0;

  const natural = () => [img.naturalWidth || 1, img.naturalHeight || 1];
  const fitScale = () => {
    const [w, h] = natural();
    return Math.min(1, stage.clientWidth / w, stage.clientHeight / h);
  };

  const clamp = () => {
    const [w, h] = natural();
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const iw = w * scale;
    const ih = h * scale;
    x = iw <= sw ? (sw - iw) / 2 : Math.min(0, Math.max(sw - iw, x));
    y = ih <= sh ? (sh - ih) / 2 : Math.min(0, Math.max(sh - ih, y));
  };

  const apply = () => {
    clamp();
    // Sizing the element rather than scaling it lets the browser resample
    // properly: a transform-scaled 12 MP photo looks grainy when fitted.
    const [w, h] = natural();
    img.style.width = `${w * scale}px`;
    img.style.height = `${h * scale}px`;
    img.style.transform = `translate(${x}px, ${y}px)`;
    stage.classList.toggle("pannable", img.naturalWidth * scale > stage.clientWidth + 1 || img.naturalHeight * scale > stage.clientHeight + 1);
    onChange?.(scale, fitted);
  };

  // Zoom to `next`, keeping the image point under (px, py) in place.
  const zoomAt = (next, px = stage.clientWidth / 2, py = stage.clientHeight / 2) => {
    next = Math.min(MAX, Math.max(MIN, next));
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    fitted = false;
    apply();
  };

  const fit = () => {
    scale = fitScale();
    fitted = true;
    apply();
  };

  const actual = (px, py) => zoomAt(1, px, py);

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  stage.addEventListener("dblclick", (e) => {
    const r = stage.getBoundingClientRect();
    if (fitted && fitScale() < 1) actual(e.clientX - r.left, e.clientY - r.top);
    else fit();
  });

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !stage.classList.contains("pannable")) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("panning");
    const sx = e.clientX - x;
    const sy = e.clientY - y;
    const moveTo = (m) => {
      x = m.clientX - sx;
      y = m.clientY - sy;
      apply();
    };
    const end = () => {
      stage.classList.remove("panning");
      stage.removeEventListener("pointermove", moveTo);
    };
    stage.addEventListener("pointermove", moveTo);
    stage.addEventListener("pointerup", end, { once: true });
    stage.addEventListener("pointercancel", end, { once: true });
  });

  const resize = new ResizeObserver(() => (fitted ? fit() : apply()));
  resize.observe(stage);
  img.addEventListener("load", fit);
  if (img.complete && img.naturalWidth) fit();

  return {
    zoomIn: () => zoomAt(scale * 1.25),
    zoomOut: () => zoomAt(scale / 1.25),
    fit,
    actual: () => actual(),
    destroy: () => resize.disconnect(),
  };
}
