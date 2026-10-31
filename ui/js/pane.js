// One file pane: a folder shown as a list or a grid, with its own history,
// selection, filter and search. A tab holds one pane, or two side by side.

import { api } from "./api.js";
import { prefs } from "./prefs.js";
import { t, count } from "./i18n.js";
import { esc, size, sizeParts, ezaDate, relative, dateTime, modeString, collator, joinPath, parentOf, baseName, int } from "./format.js";
import { svg, iconHTML, glyph, colorClass, kindLabel, previewKind, shareGlyph } from "./icons.js";
import { h, $, errorToast, toast } from "./ui.js";
import { fuzzy, highlight } from "./fuzzy.js";
import { isHeic, HEIC_LIMIT, fillHeic } from "./heic.js";
import { rememberArchive } from "./archive.js";
import { isRemote } from "./conns.js";

const COLS = {
  mode: { label: "Permessi", width: "92px", cls: "mono pm" },
  size: { label: "Dimensione", width: "84px", cls: "r sz" },
  mtime: { label: "Modificato", width: "128px", cls: "mono dt" },
  kind: { label: "Tipo", width: "130px", cls: "" },
};

const isHidden = (e) => e.name.startsWith(".");
const isToday = (sec) => sec > 0 && new Date(sec * 1000).toDateString() === new Date().toDateString();
const isDirLike = (e) => e.kind === "d" || e.link_dir;

export class Pane {
  constructor(app, state = {}) {
    this.app = app;
    this.path = state.path || "/";
    this.view = state.view || prefs.view;
    this.sort = state.sort || { ...prefs.sort };
    this.back = [];
    this.fwd = [];
    this.entries = [];
    this.visible = [];
    this.sel = new Set();
    this.cursor = 0;
    this.anchor = 0;
    this.filter = "";
    this.searchMode = false;
    this.search = null; // {query, results, partial, controller}
    this.loading = false;
    this.error = null;
    this.writable = false;
    this.space = null;
    this.recycle = false;
    this.dirSizes = new Map();
    this.typeahead = { text: "", at: 0 };
    this.build();
  }

  get state() {
    return { path: this.path, view: this.view, sort: this.sort };
  }

  // ---------- DOM ----------
  build() {
    this.el = h(`<section class="pane">
      <div class="toolbar">
        <button class="icon-btn b-back" title="${t("Indietro")} (Alt+←)">${svg("back")}</button>
        <button class="icon-btn b-fwd" title="${t("Avanti")} (Alt+→)">${svg("forward")}</button>
        <button class="icon-btn b-up" title="${t("Cartella superiore")} (Backspace)">${svg("up")}</button>
        <button class="icon-btn b-refresh" title="${t("Aggiorna")} (F5)">${svg("refresh")}</button>
        <div class="crumbs" title="${t("Clic sullo spazio vuoto per scrivere un percorso")} (Ctrl+L)"></div>
        <label class="filter-box">${svg("filter")}<input type="text" spellcheck="false" placeholder="${t("Filtra")}"><span class="mode" title="${t("Cerca in tutte le sottocartelle: parole contenute nel nome, oppure *.mkv")} (Ctrl+F)">${t("sottocartelle")}</span></label>
        <div class="seg views">
          <button data-v="list" title="${t("Elenco")} (Ctrl+1)">${svg("list")}</button>
          <button data-v="grid" title="${t("Griglia")} (Ctrl+2)">${svg("grid")}</button>
        </div>
        <button class="icon-btn b-hidden" title="${t("File nascosti")} (Ctrl+H)">${svg("eye")}</button>
        <button class="icon-btn b-split" title="${t("Doppio pannello")} (F3)">${svg("split")}</button>
        <button class="icon-btn b-info" title="${t("Pannello informazioni")} (Ctrl+I)">${svg("info")}</button>
        <div class="sep"></div>
        <button class="icon-btn b-new" title="${t("Nuovo")}">${svg("plus")}</button>
        <button class="icon-btn b-more" title="${t("Altro")}">${svg("more")}</button>
      </div>
      <div class="pane-main">
        <div class="view" tabindex="-1">
          <div class="list-head"></div>
          <div class="scroller" tabindex="0"><div class="rows"></div></div>
        </div>
        <aside class="info" hidden></aside>
      </div>
      <footer class="statusbar"></footer>
    </section>`);
    this.crumbsEl = $(".crumbs", this.el);
    this.filterInput = $(".filter-box input", this.el);
    this.headEl = $(".list-head", this.el);
    this.scroller = $(".scroller", this.el);
    this.rowsEl = $(".rows", this.el);
    this.infoEl = $(".info", this.el);
    this.statusEl = $(".statusbar", this.el);

    $(".b-back", this.el).onclick = () => this.goBack();
    $(".b-fwd", this.el).onclick = () => this.goForward();
    $(".b-up", this.el).onclick = () => this.goUp();
    $(".b-refresh", this.el).onclick = () => this.reload();
    $(".b-hidden", this.el).onclick = () => this.app.toggleHidden();
    $(".b-split", this.el).onclick = () => this.app.toggleSplit();
    $(".b-info", this.el).onclick = () => this.app.toggleInfo();
    $(".b-new", this.el).onclick = (e) => this.app.newMenu(this, e.currentTarget);
    $(".b-more", this.el).onclick = (e) => this.app.moreMenu(this, e.currentTarget);
    this.el.querySelectorAll(".views button").forEach((b) => (b.onclick = () => this.setView(b.dataset.v)));
    $(".filter-box .mode", this.el).onclick = (e) => {
      e.preventDefault();
      this.setSearchMode(!this.searchMode);
      this.filterInput.focus();
    };
    this.filterInput.oninput = () => this.onFilterInput();
    this.filterInput.onkeydown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.clearFilter();
        this.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (this.searchMode) this.runSearch();
        else this.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.focus();
      }
      e.stopPropagation();
    };
    this.crumbsEl.addEventListener("click", (e) => {
      if (e.target === this.crumbsEl) this.editPath();
    });
    this.el.addEventListener("mousedown", () => this.app.activate(this), true);
    this.scroller.addEventListener("scroll", () => this.paint());
    new ResizeObserver(() => this.paint()).observe(this.scroller);
    this.bindPointer();
    this.bindDrop();
  }

  focus() {
    this.scroller.focus({ preventScroll: true });
  }

  rowHeight() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--row")) || 30;
  }

  // ---------- navigation ----------
  async go(path, { push = true, select } = {}) {
    path = "/" + path.split("/").filter(Boolean).join("/");
    if (push && path !== this.path) {
      this.back.push(this.path);
      this.fwd = [];
    }
    const previous = this.path;
    this.path = path;
    if (prefs.perFolder) {
      // the folder's own view and sort, else the last ones used
      const own = prefs.folderViews[path];
      this.view = own?.view || prefs.view;
      this.sort = { ...(own?.sort || prefs.sort) };
    }
    this.clearFilter(false);
    this.sel.clear();
    this.cursor = 0;
    this.scroller.scrollTop = 0;
    await this.load();
    // going up selects the folder we came from, as file managers do
    const want = select || (previous.startsWith(path + "/") ? path + "/" + previous.slice(path.length + 1).split("/")[0] : null);
    if (want) this.selectPath(want);
    this.app.paneChanged(this);
  }

  goBack() {
    if (!this.back.length) return;
    this.fwd.push(this.path);
    this.go(this.back.pop(), { push: false });
  }

  goForward() {
    if (!this.fwd.length) return;
    this.back.push(this.path);
    this.go(this.fwd.pop(), { push: false });
  }

  goUp() {
    if (this.path === "/") return;
    this.go(parentOf(this.path));
  }

  async reload() {
    const keep = new Set(this.sel);
    const cursorPath = this.visible[this.cursor]?.path;
    await this.load();
    this.sel = new Set([...keep].filter((p) => this.visible.some((e) => e.path === p)));
    const i = this.visible.findIndex((e) => e.path === cursorPath);
    if (i >= 0) this.cursor = i;
    this.render();
  }

  async load() {
    this.loading = true;
    this.error = null;
    this.renderChrome();
    const myPath = this.path;
    try {
      if (this.path === "/") {
        const { shares } = await api.shares();
        this.entries = shares.map((s) => ({
          name: s.name, kind: "d", size: 0, mtime: 0, mode: 0o755, path: "/" + s.name, share: s,
        }));
        this.writable = false;
        this.space = null;
        this.archive = null;
        this.remote = null;
      } else {
        const data = await api.list(this.path);
        if (myPath !== this.path) return;
        this.entries = data.entries.map((e) => ({ ...e, path: joinPath(this.path, e.name) }));
        // the shares of an SMB server: like shared folders, not to be moved
        if (data.remote?.top) this.entries.forEach((e) => (e.share = { name: e.name, remote: true }));
        this.remote = data.remote || null;
        this.writable = data.writable;
        this.space = data.space;
        this.recycle = data.recycle;
        this.archive = null;
        if (data.inner !== undefined) {
          const root = data.inner ? this.path.slice(0, this.path.length - data.inner.length - 1) : this.path;
          rememberArchive(root);
          this.archive = { root, inner: data.inner };
        }
      }
    } catch (e) {
      if (myPath !== this.path) return;
      this.entries = [];
      this.error = e.message;
    } finally {
      if (myPath === this.path) {
        this.loading = false;
        this.refilter();
        this.render();
      }
    }
  }

  // ---------- sorting, filtering ----------
  refilter() {
    const src = this.search ? this.search.results : this.entries;
    let list = prefs.showHidden ? src : src.filter((e) => !isHidden(e));
    const query = this.filter.trim();
    this.matches = new Map();
    if (query && this.searchMode) {
      // search results: mark the words the NAS matched
      const words = query.toLowerCase().split(/\s+/).filter((w) => w && !/[*?]/.test(w));
      for (const e of list) {
        const lower = e.name.toLowerCase();
        const positions = [];
        for (const w of words) {
          const at = lower.indexOf(w);
          if (at >= 0) for (let k = 0; k < w.length; k++) positions.push(at + k);
        }
        if (positions.length) this.matches.set(e.path, { positions });
      }
    } else if (query) {
      // the filter: fuzzy, as you type, ranked by relevance
      for (const e of list) {
        const m = fuzzy(query, e.name);
        if (m) this.matches.set(e.path, m);
      }
      list = list.filter((e) => this.matches.has(e.path));
      if (this.sort.key === "name" && this.sort.dir === 1) {
        // a click on a column header sorts the usual way instead
        this.visible = [...list].sort((a, b) => this.matches.get(b.path).score - this.matches.get(a.path).score || collator.compare(a.name, b.name));
        if (this.cursor >= this.visible.length) this.cursor = Math.max(0, this.visible.length - 1);
        return;
      }
    }
    const { key, dir } = this.sort;
    const sizeOf = (e) => (isDirLike(e) ? this.dirSizes.get(e.path)?.bytes ?? -1 : e.size);
    const cmp = {
      name: (a, b) => collator.compare(a.name, b.name),
      size: (a, b) => sizeOf(a) - sizeOf(b) || collator.compare(a.name, b.name),
      mtime: (a, b) => a.mtime - b.mtime || collator.compare(a.name, b.name),
      kind: (a, b) => collator.compare(kindLabel(a), kindLabel(b)) || collator.compare(a.name, b.name),
      mode: (a, b) => a.mode - b.mode || collator.compare(a.name, b.name),
      dir: (a, b) => collator.compare(a.dir || "", b.dir || "") || collator.compare(a.name, b.name),
    }[key] || ((a, b) => collator.compare(a.name, b.name));
    list = [...list].sort((a, b) => {
      if (prefs.foldersFirst) {
        const d = (isDirLike(b) ? 1 : 0) - (isDirLike(a) ? 1 : 0);
        if (d) return d;
      }
      if (prefs.hiddenLast) {
        const d = (isHidden(a) ? 1 : 0) - (isHidden(b) ? 1 : 0);
        if (d) return d;
      }
      return cmp(a, b) * dir;
    });
    this.visible = list;
    if (this.cursor >= list.length) this.cursor = Math.max(0, list.length - 1);
  }

  setSort(key) {
    if (this.sort.key === key) this.sort.dir = -this.sort.dir;
    else this.sort = { key, dir: key === "mtime" || key === "size" ? -1 : 1 };
    this.app.rememberSort(this.sort, this);
    const cur = this.visible[this.cursor]?.path;
    this.refilter();
    const i = this.visible.findIndex((e) => e.path === cur);
    if (i >= 0) this.cursor = i;
    this.render();
  }

  setView(view) {
    this.view = view;
    this.app.rememberView(view, this);
    this.render();
    this.ensureVisible();
  }

  onFilterInput() {
    this.filter = this.filterInput.value;
    if (this.searchMode) {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.runSearch(), 220);
      return;
    }
    this.refilter();
    this.cursor = 0;
    this.sel.clear();
    this.render();
  }

  setSearchMode(on) {
    if (on && isRemote(this.path)) {
      toast(t("Sulle connessioni remote c'è solo il filtro della cartella"));
      on = false;
    }
    this.searchMode = on;
    $(".filter-box .mode", this.el).classList.toggle("on", on);
    this.filterInput.placeholder = on ? t("Cerca in {p}", { p: baseName(this.path) || t("tutte le cartelle") }) : t("Filtra");
    if (!on) {
      this.search?.controller?.abort();
      this.search = null;
    }
    this.onFilterInput();
  }

  async runSearch() {
    const q = this.filter.trim();
    this.search?.controller?.abort();
    if (!q || this.path === "/") {
      this.search = null;
      this.refilter();
      this.render();
      return;
    }
    const controller = new AbortController();
    this.search = { query: q, results: [], partial: false, controller, running: true };
    this.loading = true;
    this.render();
    try {
      const r = await api.search(this.path, q, controller.signal);
      if (this.search?.controller !== controller) return;
      this.search.results = r.hits.map((hit) => {
        const dir = hit.dir ? joinPath(this.path, hit.dir) : this.path;
        return { ...hit, dir: hit.dir || ".", path: joinPath(dir, hit.name) };
      });
      this.search.partial = r.partial;
      this.search.scanned = r.scanned;
    } catch (e) {
      if (e.name !== "AbortError") errorToast(e);
    } finally {
      if (this.search?.controller === controller) {
        this.search.running = false;
        this.loading = false;
        this.cursor = 0;
        this.refilter();
        this.render();
      }
    }
  }

  clearFilter(render = true) {
    this.filterInput.value = "";
    this.filter = "";
    this.search?.controller?.abort();
    this.search = null;
    if (this.searchMode) {
      this.searchMode = false;
      $(".filter-box .mode", this.el).classList.remove("on");
      this.filterInput.placeholder = t("Filtra");
    }
    if (render) {
      this.refilter();
      this.render();
    }
  }

  // ---------- selection ----------
  selected() {
    const list = this.visible.filter((e) => this.sel.has(e.path));
    if (list.length) return list;
    const cur = this.visible[this.cursor];
    return cur && this.sel.size === 0 && this.cursorShown ? [cur] : [];
  }

  /** What an action applies to: the selection, or the item under the cursor. */
  targets() {
    const list = this.visible.filter((e) => this.sel.has(e.path));
    if (list.length) return list;
    const cur = this.visible[this.cursor];
    return cur ? [cur] : [];
  }

  selectPath(path) {
    const i = this.visible.findIndex((e) => e.path === path);
    if (i < 0) return;
    this.cursor = this.anchor = i;
    this.sel = new Set([path]);
    this.render();
    this.ensureVisible();
  }

  selectAll() {
    this.sel = new Set(this.visible.map((e) => e.path));
    this.render();
  }

  invertSelection() {
    this.sel = new Set(this.visible.filter((e) => !this.sel.has(e.path)).map((e) => e.path));
    this.render();
  }

  moveCursor(to, { extend = false, toggle = false } = {}) {
    if (!this.visible.length) return;
    to = Math.max(0, Math.min(this.visible.length - 1, to));
    this.cursor = to;
    this.cursorShown = true;
    if (extend) {
      const [a, b] = [Math.min(this.anchor, to), Math.max(this.anchor, to)];
      this.sel = new Set(this.visible.slice(a, b + 1).map((e) => e.path));
    } else if (!toggle) {
      this.anchor = to;
      this.sel = new Set([this.visible[to].path]);
    }
    this.paint();
    this.ensureVisible();
    this.renderStatus();
    this.app.selectionChanged(this);
  }

  toggleAtCursor() {
    const e = this.visible[this.cursor];
    if (!e) return;
    if (this.sel.has(e.path)) this.sel.delete(e.path);
    else this.sel.add(e.path);
    this.paint();
    this.renderStatus();
    this.app.selectionChanged(this);
  }

  pageSize() {
    const rh = this.view === "grid" ? this.tileH : this.rowHeight();
    return Math.max(1, Math.floor(this.scroller.clientHeight / rh) - 1) * (this.view === "grid" ? this.perRow : 1);
  }

  ensureVisible() {
    const i = this.cursor;
    let top;
    let hgt;
    if (this.view === "grid") {
      top = Math.floor(i / this.perRow) * this.tileH;
      hgt = this.tileH;
    } else {
      hgt = this.rowHeight();
      top = i * hgt;
    }
    const s = this.scroller;
    if (top < s.scrollTop) s.scrollTop = top;
    else if (top + hgt > s.scrollTop + s.clientHeight) s.scrollTop = top + hgt - s.clientHeight;
  }

  /** Type to jump: the next name that starts with what was typed. */
  typeAhead(ch) {
    const now = Date.now();
    this.typeahead.text = now - this.typeahead.at > 900 ? ch : this.typeahead.text + ch;
    this.typeahead.at = now;
    const q = this.typeahead.text.toLowerCase();
    const n = this.visible.length;
    const start = this.typeahead.text.length === 1 ? this.cursor + 1 : this.cursor;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (this.visible[i].name.toLowerCase().startsWith(q)) return this.moveCursor(i);
    }
  }

  // ---------- rendering ----------
  render() {
    this.renderChrome();
    this.renderHead();
    this.paint(true);
    this.renderStatus();
    this.renderInfo();
  }

  renderChrome() {
    $(".b-back", this.el).disabled = !this.back.length;
    $(".b-fwd", this.el).disabled = !this.fwd.length;
    $(".b-up", this.el).disabled = this.path === "/";
    this.el.querySelectorAll(".views button").forEach((b) => b.classList.toggle("on", b.dataset.v === this.view));
    const hb = $(".b-hidden", this.el);
    hb.classList.toggle("on", prefs.showHidden);
    hb.innerHTML = svg(prefs.showHidden ? "eye" : "eyeOff");
    $(".b-info", this.el).classList.toggle("on", prefs.info);
    $(".b-split", this.el).classList.toggle("on", this.app.isSplit());
    if (!this.editingPath) this.renderCrumbs();
    let bar = $(".loading-bar", this.el);
    if (this.loading && !bar) $(".view", this.el).append(h(`<div class="loading-bar"></div>`));
    if (!this.loading && bar) bar.remove();
  }

  renderCrumbs() {
    const parts = this.path.split("/").filter(Boolean);
    let html = `<button class="crumb" data-path="/"><i class="gi keep">${shareGlyph("homes")}</i>${t("NAS")}</button>`;
    let acc = "";
    if (isRemote(this.path)) {
      // a connection starts its own trail, under its name
      acc = "/" + parts.shift();
      html = `<button class="crumb" data-path="${esc(acc)}"><i class="gi keep">${svg("server")}</i>${esc(this.app.connName(acc))}</button>`;
    }
    for (const p of parts) {
      acc += "/" + p;
      html += `<span class="crumb-sep">${svg("chev")}</span><button class="crumb" data-path="${esc(acc)}">${esc(p)}</button>`;
    }
    this.crumbsEl.innerHTML = html;
    this.crumbsEl.querySelectorAll(".crumb").forEach((b) => {
      b.onclick = () => this.go(b.dataset.path);
      this.app.makeDropTarget(b, () => b.dataset.path);
    });
    // keep the end in sight when the path is long
    this.crumbsEl.scrollLeft = this.crumbsEl.scrollWidth;
  }

  editPath() {
    this.editingPath = true;
    const input = h(`<input class="path-input" spellcheck="false" value="${esc(this.path)}">`);
    this.crumbsEl.replaceWith(input);
    input.focus();
    input.select();
    const done = (go) => {
      if (!this.editingPath) return;
      this.editingPath = false;
      input.replaceWith(this.crumbsEl);
      this.renderCrumbs();
      // \\server\share, smb://, sftp://, /volume1/share…: the app knows where they go
      if (go && input.value.trim()) this.app.goAddress(input.value.trim(), this);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false), this.focus();
    };
    input.onblur = () => done(false);
  }

  columns() {
    const cols = [{ key: "name", label: "Nome", width: "minmax(160px, 1fr)" }];
    if (this.search) cols.push({ key: "dir", label: "Cartella", width: "minmax(100px, .6fr)", cls: "" });
    for (const [key, c] of Object.entries(COLS)) if (prefs.columns[key]) cols.push({ key, ...c });
    return cols;
  }

  renderHead() {
    this.barWidth = null;
    const grid = this.view === "list";
    this.headEl.hidden = !grid;
    if (!grid) return;
    const cols = this.columns();
    this.template = cols.map((c) => c.width).join(" ");
    this.headEl.style.gridTemplateColumns = this.template;
    this.headEl.innerHTML = cols
      .map((c) => {
        const arrow = this.sort.key === c.key ? `<span class="arrow">${this.sort.dir > 0 ? "▲" : "▼"}</span>` : "";
        return `<div data-k="${c.key}" class="${c.key === "size" ? "r" : ""}">${t(c.label)}${arrow}</div>`;
      })
      .join("");
    this.headEl.querySelectorAll("div").forEach((d) => (d.onclick = () => this.setSort(d.dataset.k)));
    this.headEl.oncontextmenu = (e) => {
      e.preventDefault();
      this.app.columnsMenu(e.clientX, e.clientY);
    };
  }

  /** Draws the rows (or tiles) in view, and only those. */
  paint(full = false) {
    const list = this.visible;
    const s = this.scroller;
    let empty = $(".empty-state", this.el);
    if (!list.length && !this.loading) {
      const msg = this.error
        ? `<div style="color:var(--crit)">${esc(this.error)}</div>`
        : this.search
          ? t("Nessun risultato")
          : this.filter
            ? t("Nessun elemento corrisponde al filtro")
            : t("Cartella vuota");
      const html = `<div><i class="gi">${glyph({ kind: "d", name: "" })}</i>${msg}</div>`;
      if (!empty) $(".view", this.el).append(h(`<div class="empty-state">${html}</div>`));
      else empty.innerHTML = html;
    } else if (empty) empty.remove();

    if (this.view === "grid") return this.paintGrid(full);
    // the header stops where the rows do: before the scrollbar
    const bar = s.offsetWidth - s.clientWidth;
    if (bar !== this.barWidth) {
      this.barWidth = bar;
      this.headEl.style.paddingRight = `${17 + bar}px`;
    }
    const rh = this.rowHeight();
    this.rowsEl.className = "rows";
    this.rowsEl.style.height = list.length * rh + "px";
    const first = Math.max(0, Math.floor(s.scrollTop / rh) - 8);
    const last = Math.min(list.length, Math.ceil((s.scrollTop + s.clientHeight) / rh) + 8);
    // the same rows as last time: only selection, cursor and cut change, so the
    // nodes stay (rebuilding them under the mouse breaks double clicks)
    const key = `l:${first}:${last}:${list.length}:${this.template}:${rh}`;
    if (!full && key === this.paintKey && list === this.paintList) return this.refreshMarks();
    this.paintKey = key;
    this.paintList = list;
    const cols = this.columns();
    const cut = this.app.cutPaths();
    let html = "";
    for (let i = first; i < last; i++) {
      const e = list[i];
      const cls = ["row", isHidden(e) ? "hidden-file" : "", this.sel.has(e.path) ? "sel" : "", i === this.cursor ? "cursor" : "", cut.has(e.path) ? "cut" : ""].join(" ");
      html += `<div class="${cls}" data-i="${i}" draggable="true" style="top:${i * rh}px;grid-template-columns:${this.template}">`;
      for (const c of cols) html += this.cell(e, c);
      html += `</div>`;
    }
    this.rowsEl.innerHTML = html;
  }

  cell(e, c) {
    switch (c.key) {
      case "name": {
        const link = e.kind === "l" ? `<span class="link-target">→</span>` : "";
        const share = e.share?.volume ? `<span class="si-badge" style="margin-left:6px">${esc(e.share.volume)}</span>` : "";
        const m = this.matches?.get(e.path);
        return `<div class="cell name-cell">${iconHTML(e)}<span class="nm ${colorClass(e)}">${m ? highlight(e.name, m.positions, esc) : esc(e.name)}</span>${link}${share}</div>`;
      }
      case "dir":
        return `<div class="cell" style="color:var(--muted)" title="${esc(e.dir)}">${esc(e.dir)}</div>`;
      case "mode":
        return `<div class="cell ${c.cls}">${this.modeHTML(e)}</div>`;
      case "size": {
        if (isDirLike(e)) {
          const u = this.dirSizes.get(e.path);
          return `<div class="cell ${c.cls}">${u ? this.sizeHTML(u.bytes) + (u.partial ? "+" : "") : '<span class="dash">-</span>'}</div>`;
        }
        return `<div class="cell ${c.cls}">${this.sizeHTML(e.size)}</div>`;
      }
      case "mtime":
        return `<div class="cell ${c.cls}${prefs.todayHighlight && isToday(e.mtime) ? " today" : ""}" title="${esc(dateTime(e.mtime))}">${esc(prefs.relativeDates ? relative(e.mtime) : ezaDate(e.mtime))}</div>`;
      case "kind":
        return `<div class="cell" style="color:var(--muted)">${esc(kindLabel(e))}</div>`;
    }
    return "";
  }

  modeHTML(e) {
    const s = modeString(e.kind, e.mode);
    const cls = (ch, i) => {
      if (i === 0) return ch === "d" ? "t-d" : ch === "l" ? "t-l" : "t-n";
      if (ch === "-") return "t-n";
      const user = i <= 3;
      if (ch === "r") return user ? "t-ur" : "t-r";
      if (ch === "w") return user ? "t-uw" : "t-w";
      if (ch === "x") return user ? (e.kind === "f" ? "t-ux" : "t-x") : "t-x";
      return "t-s";
    };
    return [...s].map((ch, i) => `<span class="${cls(ch, i)}">${ch}</span>`).join("");
  }

  sizeHTML(bytes) {
    const [n, u, mag] = sizeParts(bytes);
    const k = "bkmgtt"[mag] || "t";
    const unit = u === "B" ? "" : prefs.binarySizes ? u.replace("iB", "i").replace("B", "") : u;
    return `<span class="n-${k}">${n}</span><span class="u-${k}">${u === "B" ? "" : (prefs.llColumns ? "" : " ") + unit}</span>`;
  }

  /** Selection, cursor and cut marks on the nodes already drawn. */
  refreshMarks() {
    const cut = this.app.cutPaths();
    for (const el of this.rowsEl.children) {
      const i = +el.dataset.i;
      const e = this.visible[i];
      if (!e) continue;
      el.classList.toggle("sel", this.sel.has(e.path));
      el.classList.toggle("cursor", i === this.cursor);
      el.classList.toggle("cut", cut.has(e.path));
    }
  }

  paintGrid(full) {
    const list = this.visible;
    const s = this.scroller;
    const w = s.clientWidth - 16;
    const tw = prefs.size === "large" ? 150 : prefs.size === "small" ? 110 : 128;
    this.perRow = Math.max(1, Math.floor(w / tw));
    const cw = w / this.perRow;
    this.tileH = tw + 22;
    const rows = Math.ceil(list.length / this.perRow);
    this.rowsEl.className = "grid-rows";
    this.rowsEl.style.height = rows * this.tileH + 8 + "px";
    const firstRow = Math.max(0, Math.floor(s.scrollTop / this.tileH) - 2);
    const lastRow = Math.min(rows, Math.ceil((s.scrollTop + s.clientHeight) / this.tileH) + 2);
    const key = `g:${firstRow}:${lastRow}:${list.length}:${this.perRow}:${cw}`;
    if (!full && key === this.paintKey && list === this.paintList) return this.refreshMarks();
    this.paintKey = key;
    this.paintList = list;
    const cut = this.app.cutPaths();
    let html = "";
    for (let r = firstRow; r < lastRow; r++) {
      for (let c = 0; c < this.perRow; c++) {
        const i = r * this.perRow + c;
        if (i >= list.length) break;
        const e = list[i];
        const cls = ["tile", isHidden(e) ? "hidden-file" : "", this.sel.has(e.path) ? "sel" : "", i === this.cursor ? "cursor" : "", cut.has(e.path) ? "cut" : ""].join(" ");
        const kind = previewKind(e);
        let thumb = iconHTML(e, "keep");
        if (e.thumb) thumb = `<img loading="lazy" src="${api.thumb(e.path)}" alt="">`;
        else if (kind === "image" && e.size < 8 * 1024 * 1024 && !/\.(heic|heif|tiff?)$/i.test(e.name)) thumb = `<img loading="lazy" src="${api.view(e.path)}" alt="">`;
        else if (isHeic(e.name) && e.size < HEIC_LIMIT) thumb += `<img data-heic alt="">`;
        const sub = isDirLike(e) ? "" : size(e.size);
        html += `<div class="${cls}" data-i="${i}" draggable="true" style="left:${8 + c * cw}px;top:${4 + r * this.tileH}px;width:${cw - 6}px;height:${this.tileH - 6}px">
          <div class="thumb">${thumb}</div><div class="tname ${colorClass(e)}" title="${esc(e.name)}">${esc(e.name)}</div>${sub ? `<div class="tsub">${sub}</div>` : ""}</div>`;
      }
    }
    this.rowsEl.innerHTML = html;
    this.rowsEl.querySelectorAll("img").forEach((img) => (img.onerror = () => {
      const tile = img.closest(".tile");
      const e = list[+tile.dataset.i];
      img.replaceWith(h(iconHTML(e, "keep")));
    }));
    fillHeic(this.rowsEl, (img) => list[+img.closest(".tile").dataset.i], 384);
  }

  renderStatus() {
    const n = this.visible.length;
    const selList = this.visible.filter((e) => this.sel.has(e.path));
    let html = `<span>${count(n, "elemento", "elementi", int)}</span>`;
    if (this.archive) html += `<span class="ro">${svg("archive")} ${t("Archivio · sola lettura")}</span>`;
    const hidden = (this.search ? this.search.results : this.entries).filter(isHidden).length;
    if (!prefs.showHidden && hidden) html += `<span>${t("{n} nascosti", { n: int(hidden) })}</span>`;
    if (selList.length) {
      const bytes = selList.reduce((a, e) => a + (isDirLike(e) ? this.dirSizes.get(e.path)?.bytes || 0 : e.size), 0);
      html += `<span><b>${count(selList.length, "selezionato", "selezionati", int)}</b> · ${size(bytes)}</span>`;
    }
    if (this.search) {
      html += `<span>${this.search.running ? t("ricerca in corso…") : t("{n} elementi esaminati", { n: int(this.search.scanned || 0) })}${this.search.partial ? " · " + t("risultati parziali") : ""}</span>`;
    }
    html += `<span class="grow"></span>`;
    const cb = this.app.clipboard;
    if (cb) html += `<span>${t(cb.op === "cut" ? "{n} da spostare" : "{n} da copiare", { n: int(cb.paths.length) })}</span>`;
    if (this.space && this.space.total) {
      const used = 1 - this.space.free / this.space.total;
      html += `<span class="space">${t("{f} liberi di {t}", { f: size(this.space.free), t: size(this.space.total) })}<span class="vol-bar ${used > 0.95 ? "full" : used > 0.85 ? "high" : ""}"><div style="width:${(used * 100).toFixed(1)}%"></div></span></span>`;
    }
    this.statusEl.innerHTML = html;
  }

  async renderInfo() {
    this.infoEl.hidden = !prefs.info;
    if (!prefs.info) return;
    const list = this.targets();
    const token = (this.infoToken = Symbol());
    if (!list.length) {
      const name = (this.path.split("/").length === 2 && isRemote(this.path) ? this.app.connName(this.path) : baseName(this.path)) || t("Cartelle condivise");
      const dirEntry = { name, kind: "d", mode: 0o755 };
      this.infoEl.innerHTML = `<div class="preview-box">${iconHTML(dirEntry, "keep")}</div><h3>${esc(name)}</h3><div class="kind">${t("Cartella")}</div>
        <dl class="facts"><dt>${t("Elementi")}</dt><dd>${int(this.visible.length)}</dd>${this.space ? `<dt>${t("Spazio libero")}</dt><dd>${size(this.space.free)}</dd>` : ""}</dl>`;
      return;
    }
    if (list.length > 1) {
      const files = list.filter((e) => !isDirLike(e));
      const dirs = list.filter(isDirLike);
      // Folder sizes join the total once computed (Calcola, or earlier).
      const known = dirs.map((e) => this.dirSizes.get(e.path)).filter(Boolean);
      const done = known.length === dirs.length;
      const bytes = files.reduce((a, e) => a + e.size, 0) + known.reduce((a, u) => a + u.bytes, 0);
      const partial = known.some((u) => u.partial);
      const inside = known.reduce((a, u) => [a[0] + u.files, a[1] + Math.max(0, u.dirs - 1)], [0, 0]);
      this.infoEl.innerHTML = `<div class="preview-box">${svg("copy", "i")}</div><h3>${count(list.length, "elemento selezionato", "elementi selezionati", int)}</h3>
        <dl class="facts"><dt>${t("File")}</dt><dd>${int(files.length)}</dd><dt>${t("Cartelle")}</dt><dd>${int(dirs.length)}</dd>
        ${dirs.length && done
          ? `<dt>${t("Dimensione totale")}</dt><dd>${size(bytes)}${partial ? "+" : ""} <span style="color:var(--faint)">(${int(bytes)} B)</span></dd>
             <dt>${t("Contenuto")}</dt><dd>${count(files.length + inside[0], "file", "file", int)}, ${count(inside[1], "cartella", "cartelle", int)}</dd>`
          : `<dt>${t("Dimensione file")}</dt><dd>${size(bytes)}${known.length ? "+" : ""}</dd>`}</dl>
        ${dirs.length && !done ? `<div class="actions"><button class="btn small calc">${t("Calcola dimensione totale")}</button></div>` : ""}`;
      $(".calc", this.infoEl)?.addEventListener("click", () => this.app.computeSizes(this, list));
      return;
    }
    const e = list[0];
    const kind = previewKind(e);
    let preview = iconHTML(e, "keep");
    if (e.thumb) preview = `<img src="${api.thumb(e.path, true)}" alt="">`;
    else if (kind === "image" && e.size < 15 * 1024 * 1024 && !/\.(heic|heif|tiff?)$/i.test(e.name)) preview = `<img src="${api.view(e.path)}" alt="">`;
    else if (isHeic(e.name) && e.size < HEIC_LIMIT) preview += `<img data-heic alt="">`;
    const u = this.dirSizes.get(e.path);
    const sizeText = isDirLike(e) ? (u ? `${size(u.bytes)}${u.partial ? "+" : ""}` : `<button class="btn small calc">${t("Calcola")}</button>`) : `${size(e.size)} <span style="color:var(--faint)">(${int(e.size)} B)</span>`;
    this.infoEl.innerHTML = `<div class="preview-box">${preview}</div><h3>${esc(e.name)}</h3><div class="kind">${esc(kindLabel(e))}</div>
      <dl class="facts">
        <dt>${t("Dimensione")}</dt><dd>${sizeText}</dd>
        ${u ? `<dt>${t("Contenuto")}</dt><dd>${count(u.files, "file", "file", int)}, ${count(Math.max(0, u.dirs - 1), "cartella", "cartelle", int)}</dd>` : ""}
        <dt>${t("Modificato")}</dt><dd>${esc(dateTime(e.mtime))}</dd>
        <dt>${t("Permessi")}</dt><dd class="pm" style="font-family:var(--mono)">${this.modeHTML(e)}</dd>
        <dt>${t("Proprietario")}</dt><dd class="owner">…</dd>
        <dt>${t("Percorso")}</dt><dd style="font-family:var(--mono);font-size:11.5px">${esc(this.app.displayPath(e.path))}</dd>
      </dl>
      <div class="actions">
        ${isDirLike(e) ? "" : `<button class="btn small dl">${svg("download")} ${t("Scarica")}</button><button class="btn small info-preview">${svg("eye")} ${t("Anteprima")}</button>`}
        <button class="btn small cp">${svg("link")} ${t("Copia percorso")}</button>
      </div>`;
    $(".calc", this.infoEl)?.addEventListener("click", () => this.app.computeSizes(this, [e]));
    $(".dl", this.infoEl)?.addEventListener("click", () => this.app.download([e]));
    $(".info-preview", this.infoEl)?.addEventListener("click", () => this.app.quickLook(this));
    $(".cp", this.infoEl).onclick = () => this.app.copyPaths([e], "nas");
    fillHeic(this.infoEl, () => e, 1024);
    if (e.share) {
      $(".owner", this.infoEl).textContent = e.share.comment || "—";
      return;
    }
    try {
      const st = await api.stat(e.path);
      if (token !== this.infoToken) return;
      if (st.archive) {
        $(".owner", this.infoEl).textContent = "—";
        $(".facts", this.infoEl).insertAdjacentHTML("beforeend", `<dt>${t("Archivio")}</dt><dd>${esc(st.owner)}</dd>`);
      } else if (st.remote) $(".owner", this.infoEl).textContent = st.server;
      else $(".owner", this.infoEl).textContent = `${st.owner} : ${st.group}`;
      if (st.target) $(".facts", this.infoEl).insertAdjacentHTML("beforeend", `<dt>${t("Destinazione")}</dt><dd style="font-family:var(--mono)">${esc(st.target)}</dd>`);
    } catch {
      if (token === this.infoToken) $(".owner", this.infoEl).textContent = "—";
    }
  }

  // ---------- pointer ----------
  indexAt(target) {
    const el = target.closest(".row, .tile");
    return el ? +el.dataset.i : -1;
  }

  bindPointer() {
    const s = this.scroller;
    s.addEventListener("click", (ev) => {
      const i = this.indexAt(ev.target);
      if (i < 0) return;
      if (ev.shiftKey) this.moveCursor(i, { extend: true });
      else if (ev.ctrlKey || ev.metaKey) {
        this.cursor = i;
        this.anchor = i;
        this.toggleAtCursor();
      } else {
        this.moveCursor(i);
        if (prefs.singleClick) this.app.open(this, this.visible[i]);
      }
    });
    s.addEventListener("dblclick", (ev) => {
      const i = this.indexAt(ev.target);
      if (i >= 0 && !prefs.singleClick) this.app.open(this, this.visible[i]);
    });
    s.addEventListener("auxclick", (ev) => {
      const i = this.indexAt(ev.target);
      if (ev.button === 1 && i >= 0 && isDirLike(this.visible[i])) {
        ev.preventDefault();
        this.app.newTab(this.visible[i].path, false);
      }
    });
    s.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const i = this.indexAt(ev.target);
      if (i >= 0 && !this.sel.has(this.visible[i].path)) this.moveCursor(i);
      if (i < 0) {
        this.sel.clear();
        this.paint();
        this.renderStatus();
      }
      this.app.contextMenu(this, i >= 0 ? this.visible[i] : null, ev.clientX, ev.clientY);
    });
    // rubber band selection from the empty space
    s.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || this.indexAt(ev.target) >= 0 || ev.target.closest(".rename-input")) return;
      if (ev.offsetX > s.clientWidth) return; // the scrollbar
      const box = s.getBoundingClientRect();
      const x0 = ev.clientX - box.left + s.scrollLeft;
      const y0 = ev.clientY - box.top + s.scrollTop;
      const base = ev.ctrlKey || ev.shiftKey ? new Set(this.sel) : new Set();
      if (!ev.ctrlKey && !ev.shiftKey) {
        this.sel.clear();
        this.paint();
      }
      let band = null;
      const move = (m) => {
        const x1 = m.clientX - box.left + s.scrollLeft;
        const y1 = m.clientY - box.top + s.scrollTop;
        if (!band && Math.abs(x1 - x0) + Math.abs(y1 - y0) < 5) return;
        if (!band) band = this.rowsEl.parentElement.appendChild(h(`<div class="marquee"></div>`));
        const [l, r, tp, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
        Object.assign(band.style, { left: l + "px", top: tp + "px", width: r - l + "px", height: b - tp + "px" });
        const hit = new Set(base);
        if (this.view === "grid") {
          const cw = (s.clientWidth - 16) / this.perRow;
          this.visible.forEach((e, i) => {
            const cx = 8 + (i % this.perRow) * cw;
            const cy = 4 + Math.floor(i / this.perRow) * this.tileH;
            if (cx < r && cx + cw > l && cy < b && cy + this.tileH > tp) hit.add(e.path);
          });
        } else {
          const rh = this.rowHeight();
          const a = Math.max(0, Math.floor(tp / rh));
          const z = Math.min(this.visible.length - 1, Math.floor(b / rh));
          for (let i = a; i <= z; i++) hit.add(this.visible[i].path);
        }
        this.sel = hit;
        this.paint();
        // scroll while dragging at the edges
        if (m.clientY > box.bottom - 20) s.scrollTop += 20;
        if (m.clientY < box.top + 20) s.scrollTop -= 20;
      };
      const up = () => {
        removeEventListener("mousemove", move);
        removeEventListener("mouseup", up);
        band?.remove();
        this.renderStatus();
        this.renderInfo();
        this.app.selectionChanged(this);
      };
      addEventListener("mousemove", move);
      addEventListener("mouseup", up);
    });
    s.addEventListener("dragstart", (ev) => {
      const i = this.indexAt(ev.target);
      if (i < 0) return ev.preventDefault();
      if (!this.sel.has(this.visible[i].path)) this.moveCursor(i);
      const paths = this.targets().map((e) => e.path);
      ev.dataTransfer.setData("application/x-synofile", JSON.stringify({ paths, from: this.path }));
      ev.dataTransfer.setData("text/plain", paths.join("\n"));
      ev.dataTransfer.effectAllowed = "copyMove";
      const ghost = h(`<div style="position:fixed;top:-100px;padding:6px 12px;border-radius:8px;background:var(--accent);color:#fff;font-weight:600">${esc(paths.length === 1 ? baseName(paths[0]) : t("{n} elementi", { n: paths.length }))}</div>`);
      document.body.append(ghost);
      ev.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove());
    });
  }

  bindDrop() {
    // folder rows take drops; the empty space means this folder
    this.app.makeDropTarget(this.scroller, (ev) => {
      const i = ev ? this.indexAt(ev.target) : -1;
      const e = i >= 0 ? this.visible[i] : null;
      if (e && isDirLike(e)) return e.path;
      return this.path === "/" ? null : this.path;
    }, (ev) => {
      const i = this.indexAt(ev.target);
      const e = i >= 0 ? this.visible[i] : null;
      return e && isDirLike(e) ? ev.target.closest(".row, .tile") : null;
    });
  }

  // ---------- inline rename ----------
  rename() {
    const e = this.visible[this.cursor];
    if (!e || e.share) return;
    this.app.renamePrompt(this, e);
  }
}
