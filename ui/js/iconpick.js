// The icon of a folder, chosen by hand: a small panel beside the folder's
// icon (the info panel, or the sidebar's menu) with a grid of glyphs, the
// palette's colours, and whether it is for this folder or every folder of
// that name.

import { prefs, save } from "./prefs.js";
import { t } from "./i18n.js";
import { esc, baseName } from "./format.js";
import { h } from "./ui.js";
import { ICON_CHOICES, ICON_COLORS, folderIcon, autoFolderGlyph } from "./icons.js";

let current = null;

function rules() {
  const r = prefs.folderIcons || {};
  return { paths: { ...(r.paths || {}) }, names: { ...(r.names || {}) } };
}

/** Opens the picker for the folder at `path`; `at`: an element or a point. */
export function pickIcon(at, path) {
  current?.close();
  const name = baseName(path) || path;
  const has = rules();
  let scope = !has.paths[path] && has.names[name] ? "names" : "paths";
  let query = "";
  const colorNames = { "": t("Predefinito"), red: t("Rosso"), yellow: t("Giallo"), green: t("Verde"), cyan: t("Azzurro"), purple: t("Rosa"), white: t("Bianco"), gray: t("Grigio") };

  const el = h(`<div class="icon-pick" role="dialog">
    <div class="ip-head"><span class="ip-name">${esc(name)}</span></div>
    <div class="seg ip-scope">
      <button type="button" data-scope="paths">${t("Solo questa cartella")}</button>
      <button type="button" data-scope="names">${t("Tutte le «{n}»", { n: esc(name) })}</button>
    </div>
    <input type="search" class="input ip-search" placeholder="${t("Cerca un'icona…")}" spellcheck="false">
    <div class="ip-grid"></div>
    <div class="ip-colors">${ICON_COLORS.map((c) => `<button type="button" class="ip-color ${c ? "ic-" + c : "ez-dir"}" data-color="${c}" title="${colorNames[c]}"></button>`).join("")}</div>
    <div class="ip-foot"><button type="button" class="btn small ip-reset">${t("Icona automatica")}</button><span style="flex:1"></span><button type="button" class="btn small ip-close">${t("Chiudi")}</button></div>
  </div>`);
  document.body.append(el);

  const key = () => (scope === "paths" ? path : name);
  const rule = () => rules()[scope][key()] || null;
  const shown = () => folderIcon({ kind: "d", path, name });

  function paint() {
    el.querySelectorAll(".ip-scope button").forEach((b) => b.classList.toggle("on", b.dataset.scope === scope));
    const g = shown()?.g;
    const c = shown()?.c || "";
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = ICON_CHOICES.filter(([, w]) => words.every((q) => w.includes(q)));
    el.querySelector(".ip-grid").innerHTML = list.length
      ? list.map(([gl, w]) => `<button type="button" class="gi ${c ? "ic-" + c : "ez-dir"} ${gl === g ? "on" : ""}" data-g="${gl}" title="${esc(w)}">${gl}</button>`).join("")
      : `<div class="hint">${t("Nessuna icona trovata")}</div>`;
    el.querySelectorAll(".ip-color").forEach((b) => b.classList.toggle("on", b.dataset.color === c));
    el.querySelector(".ip-reset").disabled = !rule();
  }

  function set(patch) {
    const r = rules();
    const now = r[scope][key()] || { g: shown()?.g || autoFolderGlyph(name), c: shown()?.c || "" };
    r[scope][key()] = { ...now, ...patch };
    // a rule for the name shows on this folder too: its own icon would hide it
    if (scope === "names") delete r.paths[path];
    save({ folderIcons: r });
    paint();
  }

  el.querySelectorAll(".ip-scope button").forEach((b) => (b.onclick = () => ((scope = b.dataset.scope), paint())));
  el.querySelector(".ip-grid").onclick = (e) => {
    const b = e.target.closest("[data-g]");
    if (b) set({ g: b.dataset.g });
  };
  el.querySelectorAll(".ip-color").forEach((b) => (b.onclick = () => set({ c: b.dataset.color })));
  el.querySelector(".ip-reset").onclick = () => {
    const r = rules();
    delete r[scope][key()];
    save({ folderIcons: r });
    paint();
  };
  const search = el.querySelector(".ip-search");
  search.oninput = () => ((query = search.value), paint());
  paint();

  // beside the icon, inside the window
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  const box = el.getBoundingClientRect();
  let x = r.right + 8;
  if (x + box.width > innerWidth - 8) x = Math.max(8, r.left - box.width - 8);
  el.style.left = x + "px";
  el.style.top = Math.max(8, Math.min(r.top, innerHeight - box.height - 8)) + "px";
  search.focus();

  const onDown = (e) => !el.contains(e.target) && close();
  const onKey = (e) => {
    if (e.key === "Escape") close();
    e.stopPropagation();
  };
  function close() {
    document.removeEventListener("mousedown", onDown, true);
    el.remove();
    current = null;
  }
  el.addEventListener("keydown", onKey);
  el.querySelector(".ip-close").onclick = close;
  setTimeout(() => document.addEventListener("mousedown", onDown, true));
  current = { close };
}


/** A folder renamed or moved: the icons given to it, and below it, follow. */
export function moveFolderIcons(from, to) {
  const r = rules();
  let changed = false;
  for (const p of Object.keys(r.paths)) {
    if (p === from || p.startsWith(from + "/")) {
      r.paths[to + p.slice(from.length)] = r.paths[p];
      delete r.paths[p];
      changed = true;
    }
  }
  if (changed) save({ folderIcons: r });
}
