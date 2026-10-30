// Space analysis: what takes up the room below a folder, drawn in rings
// around it (the idea of KDE's Filelight). The NAS reads the folders
// (/space) and sends a pruned tree; a click on a ring opens that folder,
// the centre goes back up.

import { api } from "./api.js";
import { t, count } from "./i18n.js";
import { esc, size, int, baseName, joinPath } from "./format.js";
import { svg, glyph, colorClass } from "./icons.js";
import { dialog, errorToast } from "./ui.js";

const RINGS = 5;
const HUES = ["--t-blue", "--t-cyan", "--t-green", "--t-yellow", "--t-purple", "--t-red", "--accent-2", "--warn"];
// below this angle a piece is not drawn (it still counts in its parent)
const MIN_ANGLE = 0.008;

/**
 * Opens the analysis of `path`. `onOpen(path)` shows a folder in the list.
 */
export function spaceAnalysis(path, onOpen) {
  const dlg = dialog(
    `<div class="dlg-head"><div class="dlg-icon">${svg("pie")}</div><h2>${t("Analisi spazio")}</h2>
       <button class="icon-btn sp-close" title="${t("Chiudi")}">${svg("close")}</button></div>
     <div class="sp-crumbs"></div>
     <div class="sp-main">
       <div class="sp-chart"><div class="sp-wait"><div class="loading-bar"></div><span>${t("Analisi di {p}…", { p: esc(path) })}</span></div></div>
       <div class="sp-side"><div class="sp-list"></div></div>
     </div>
     <div class="dlg-foot"><span class="left hint sp-stats"></span>
       <button class="btn sp-refresh">${svg("refresh")}<span>${t("Aggiorna")}</span></button>
       <button class="btn primary sp-open">${svg("forward")}<span>${t("Apri nella lista")}</span></button></div>`,
    { cls: "space" },
  );
  const chart = dlg.querySelector(".sp-chart");
  const list = dlg.querySelector(".sp-list");
  const crumbs = dlg.querySelector(".sp-crumbs");
  const stats = dlg.querySelector(".sp-stats");
  let data = null; // the answer for `base`
  let base = path; // the folder `data` was read from
  let view = null; // the node at the centre
  let trail = []; // nodes from data.root to view
  let hot = null;
  let closed = false;

  const nodePath = (chain) => chain.slice(1).reduce((p, n) => joinPath(p, n.n), base);
  const here = () => nodePath(trail);

  async function load(target) {
    chart.innerHTML = `<div class="sp-wait"><div class="loading-bar"></div><span>${t("Analisi di {p}…", { p: esc(target) })}</span></div>`;
    stats.textContent = "";
    try {
      const answer = await api.space(target);
      if (closed) return;
      data = answer;
      base = target;
      view = data.root;
      trail = [view];
      draw();
    } catch (e) {
      if (closed) return;
      chart.innerHTML = `<div class="sp-wait error">${esc(e.message)}</div>`;
    }
  }

  function enter(chain) {
    const node = chain[chain.length - 1];
    if (node.k !== "d") return;
    // a small folder seen from far above lost its detail to the pruning:
    // read it again on its own
    if (node.c && node.c.length === 1 && node.c[0].k === "o" && node.f > 1) return load(nodePath(chain));
    if (node.s * 40 < data.root.s && node.c?.some((c) => c.k === "o")) return load(nodePath(chain));
    trail = chain;
    view = node;
    hot = null;
    draw();
  }

  function draw() {
    const W = 520;
    const R = W / 2 - 6;
    const r0 = R * 0.24;
    const depth = Math.min(RINGS, levels(view));
    const step = (R - r0) / Math.max(depth, 1);
    let paths = "";
    const pieces = [];
    // each branch gets its colour where the tree first divides: a folder
    // holding one folder would otherwise paint everything alike
    let split = 0;
    for (let n = view; n.c?.length === 1 && n.c[0].k === "d" && split < depth - 1; n = n.c[0]) split++;
    const walk = (node, chain, a0, a1, level, hue) => {
      if (!node.c || level >= depth) return;
      let a = a0;
      node.c.forEach((c, i) => {
        const span = node.s ? ((a1 - a0) * c.s) / node.s : 0;
        const h = level === split ? HUES[i % HUES.length] : hue;
        if (span >= MIN_ANGLE) {
          const id = pieces.length;
          pieces.push({ node: c, chain: [...chain, c] });
          const fill = c.k === "o" ? "var(--surface-3)" : `var(${h})`;
          const op = c.k === "o" ? 1 : c.k === "f" ? 0.42 : 0.92 - level * 0.12;
          paths += `<path data-i="${id}" class="sp-${c.k}" d="${arc(r0 + level * step, r0 + (level + 1) * step - 1, a, a + span)}" fill="${fill}" fill-opacity="${op}"/>`;
          walk(c, [...chain, c], a, a + span, level + 1, h);
        }
        a += span;
      });
    };
    walk(view, trail, 0, Math.PI * 2, 0, HUES[0]);
    chart.innerHTML = `<svg viewBox="${-W / 2} ${-W / 2} ${W} ${W}" class="sp-svg">${paths}
      <circle r="${r0 - 2}" class="sp-centre"/>
      <text class="sp-c1" y="-6"></text><text class="sp-c2" y="16"></text><text class="sp-c3" y="34"></text></svg>`;
    const s = chart.querySelector("svg");
    const centre = (node) => {
      const n = node || view;
      s.querySelector(".sp-c1").textContent = clip(n.k === "o" ? t("file più piccoli") : n.n || baseName(here()) || "/", 18);
      s.querySelector(".sp-c2").textContent = size(n.s);
      s.querySelector(".sp-c3").textContent = node && node !== view ? pct(n.s / view.s) : n.f ? count(n.f, "file", "file", int) : "";
    };
    centre();
    s.onmousemove = (e) => {
      const p = e.target.closest("path");
      const piece = p ? pieces[+p.dataset.i] : null;
      if (piece?.node === hot) return;
      hot = piece?.node || null;
      s.querySelectorAll("path.hot").forEach((x) => x.classList.remove("hot"));
      p?.classList.add("hot");
      centre(hot);
      list.querySelectorAll(".sp-row").forEach((r) => r.classList.toggle("hot", !!hot && r.dataset.name === hot.n && hot.k !== "o"));
      s.style.cursor = piece?.node.k === "d" ? "pointer" : "";
    };
    s.onmouseleave = () => {
      hot = null;
      s.querySelectorAll("path.hot").forEach((x) => x.classList.remove("hot"));
      centre();
    };
    s.onclick = (e) => {
      const p = e.target.closest("path");
      if (p) return enter(pieces[+p.dataset.i].chain);
      if (e.target.closest(".sp-centre, text") && trail.length > 1) up();
    };
    s.querySelector(".sp-centre").style.cursor = trail.length > 1 ? "pointer" : "";
    drawCrumbs();
    drawList();
    const sec = Math.max(data.ms, 100) / 1000;
    stats.innerHTML =
      t("{f} file in {d} cartelle, letti in {s} s", { f: int(data.root.f), d: int(data.dirs), s: sec.toLocaleString(undefined, { maximumFractionDigits: 1 }) }) +
      (data.partial ? ` · <span class="warn">${t("analisi incompleta: tempo scaduto")}</span>` : "") +
      (data.unreadable ? ` · ${t("{n} non leggibili", { n: int(data.unreadable) })}` : "");
  }

  function up() {
    if (trail.length > 1) {
      trail = trail.slice(0, -1);
      view = trail[trail.length - 1];
      hot = null;
      draw();
    } else if (base !== "/" && base.split("/").length > 2) {
      load(base.slice(0, base.lastIndexOf("/")));
    }
  }

  function drawCrumbs() {
    const parts = here().split("/").filter(Boolean);
    crumbs.innerHTML = parts.map((p, i) => `<button class="crumb" data-i="${i}">${esc(p)}</button>`).join(`<span class="sep">${svg("chev")}</span>`);
    const depthOfBase = base.split("/").filter(Boolean).length;
    crumbs.querySelectorAll(".crumb").forEach((b) => {
      b.onclick = () => {
        const i = +b.dataset.i + 1;
        if (i >= depthOfBase) {
          trail = trail.slice(0, i - depthOfBase + 1);
          view = trail[trail.length - 1];
          hot = null;
          draw();
        } else load("/" + parts.slice(0, i).join("/"));
      };
    });
  }

  function drawList() {
    const items = (view.c || []).slice(0, 40);
    list.innerHTML = items
      .map((c, i) => {
        const entry = { name: c.n, kind: c.k === "d" ? "d" : "f", mode: 0 };
        const icon = c.k === "o" ? `<i class="gi">${svg("more")}</i>` : `<i class="gi ${colorClass(entry)}">${glyph(entry)}</i>`;
        const name = c.k === "o" ? count(c.f, "elemento più piccolo", "elementi più piccoli", int) : esc(c.n);
        const hue = c.k === "o" ? "var(--surface-3)" : `var(${HUES[i % HUES.length]})`;
        return `<div class="sp-row ${c.k === "d" ? "dir" : ""}" data-i="${i}" data-name="${esc(c.n)}">${icon}<span class="nm" title="${esc(c.n)}">${name}</span><span class="sz">${size(c.s)}</span>
          <span class="bar"><i style="width:${((c.s / (view.s || 1)) * 100).toFixed(1)}%;background:${hue}"></i></span></div>`;
      })
      .join("");
    list.querySelectorAll(".sp-row.dir").forEach((r) => (r.onclick = () => enter([...trail, view.c[+r.dataset.i]])));
  }

  dlg.querySelector(".sp-close").onclick = () => dlg.close();
  dlg.querySelector(".sp-refresh").onclick = () => load(here());
  dlg.querySelector(".sp-open").onclick = () => {
    onOpen(here());
    dlg.close();
  };
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) {
      e.preventDefault();
      up();
    }
  });
  dlg.addEventListener("close", () => (closed = true));
  load(path).catch(errorToast);
}

function levels(node) {
  if (!node.c || !node.c.length) return 0;
  let m = 0;
  for (const c of node.c) m = Math.max(m, levels(c));
  return m + 1;
}

function arc(r1, r2, a0, a1) {
  // a whole ring cannot be one arc: two halves
  if (a1 - a0 >= Math.PI * 2 - 1e-6) return arc(r1, r2, a0, a0 + Math.PI) + arc(r1, r2, a0 + Math.PI, a1);
  const p = (r, a) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r2, a0)}A${r2} ${r2} 0 ${large} 1 ${p(r2, a1)}L${p(r1, a1)}A${r1} ${r1} 0 ${large} 0 ${p(r1, a0)}Z`;
}

function pct(x) {
  return (x * 100).toLocaleString(undefined, { maximumFractionDigits: x < 0.1 ? 1 : 0 }) + "%";
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
