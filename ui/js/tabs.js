// The tabs of the window, and the one or two panes each holds: restoring,
// opening, closing, reordering and switching them. Methods of App (main.js).

import { prefs, save } from "./prefs.js";
import { t } from "./i18n.js";
import { esc } from "./format.js";
import { svg, glyph, shareGlyph, folderGlyphHTML } from "./icons.js";
import { $, h } from "./ui.js";
import { Pane } from "./pane.js";

export class Tab {
  constructor(app, state) {
    this.id = Math.random().toString(36).slice(2);
    this.panes = (state.panes || [{ path: state.path || "/" }]).map((p) => new Pane(app, p));
    this.split = this.panes.length > 1;
    this.active = Math.min(state.active || 0, this.panes.length - 1);
    this.loaded = false; // the panes of a tab restored in the background load when first shown
  }

  /** Loads the panes' folders, the first time only. */
  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    this.ready = Promise.all(this.panes.map((p) => p.load()));
  }
  get pane() {
    return this.panes[this.active];
  }
  get state() {
    return { panes: this.panes.map((p) => p.state), active: this.active };
  }
}

export const tabMethods = {
  restoreTabs() {
    const saved = prefs.tabs;
    let list = saved?.list?.length ? saved.list : [{ panes: [{ path: "/" }] }];
    if (prefs.startIn === "shares") list = [{ panes: [{ path: "/" }] }];
    else if (prefs.startIn === "folder") list = [{ panes: [{ path: prefs.startFolder || "/" }] }];
    const q = new URLSearchParams(location.search);
    if (q.get("path")) list = [{ panes: [{ path: q.get("path"), view: q.get("view") || undefined }] }];
    for (const s of list) this.tabs.push(new Tab(this, s));
    const cur = this.tabs[prefs.startIn === "last" ? Math.min(saved?.current || 0, this.tabs.length - 1) : 0];
    // the other tabs load their folders when first shown
    this.switchTab(cur);
    if (q.get("path") && q.get("select")) this.selectWhenReady(cur, q.get("select"));
    // ?space=/path opens its analysis (the README screenshot)
    if (q.get("space")) this.analyseSpace(q.get("space"));
    // another DSM app opening a folder while the window is already up
    // (SYNO.SDS.AppLaunch, relayed by synofile.js); one that came before
    // the tabs existed waits for them
    for (const m of this.pendingOpen || []) this.openAt(m.path, m.select);
    this.pendingOpen = null;
  },

  /** Listens for the window's loader asking to open a folder. */
  bindOpenMessages() {
    addEventListener("message", (ev) => {
      if (ev.source !== window.parent || ev.origin !== location.origin) return;
      const m = ev.data;
      if (m?.type !== "synofile:open" || typeof m.path !== "string") return;
      if (!this.tabs.length) (this.pendingOpen ||= []).push(m);
      else this.openAt(m.path, m.select);
    });
  },

  /** A new tab at path, with select (a name in it, or a full path) picked. */
  openAt(path, select) {
    const tab = this.newTab(path);
    if (select) this.selectWhenReady(tab, select);
  },

  selectWhenReady(tab, select) {
    tab.ensureLoaded();
    const pane = tab.pane;
    const full = select.startsWith("/") ? select : pane.path.replace(/\/$/, "") + "/" + select;
    tab.ready?.then(() => pane.selectPath(full));
  },

  saveTabs() {
    clearTimeout(this.tabTimer);
    this.tabTimer = setTimeout(() => {
      save({ tabs: { list: this.tabs.map((t) => t.state), current: this.tabs.indexOf(this.current) } });
    }, 400);
  },

  /** Where Ctrl+T and the + of the tab bar open (Settings → Behaviour). */
  newTabPath() {
    if (prefs.newTabIn === "shares") return "/";
    if (prefs.newTabIn === "folder") return prefs.startFolder || "/";
    return this.pane?.path || "/";
  },

  newTab(path = "/", activate = true) {
    const tab = new Tab(this, { panes: [{ path, view: this.pane?.view }] });
    const at = this.current ? this.tabs.indexOf(this.current) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    tab.ensureLoaded();
    if (activate) this.switchTab(tab);
    else this.renderTabs();
    this.saveTabs();
    return tab;
  },

  closeTab(tab = this.current) {
    if (this.tabs.length === 1) {
      // the last tab goes back to the start instead of closing
      tab.panes.forEach((p) => p.go("/"));
      return;
    }
    const i = this.tabs.indexOf(tab);
    this.closed.push(tab.state);
    this.tabs.splice(i, 1);
    if (tab === this.current) this.switchTab(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.renderTabs();
    this.saveTabs();
  },

  reopenTab() {
    const s = this.closed.pop();
    if (!s) return;
    const tab = new Tab(this, s);
    this.tabs.push(tab);
    this.switchTab(tab);
  },

  switchTab(tab) {
    if (!tab) return;
    this.current = tab;
    tab.ensureLoaded();
    const ws = $("#workspace");
    ws.innerHTML = "";
    ws.classList.toggle("split", tab.split);
    tab.panes.forEach((p, i) => {
      p.el.classList.toggle("active", i === tab.active);
      ws.append(p.el);
      p.render();
    });
    this.renderTabs();
    this.renderSidebar();
    this.pane.focus();
    this.saveTabs();
  },

  cycleTab(d) {
    const i = this.tabs.indexOf(this.current);
    this.switchTab(this.tabs[(i + d + this.tabs.length) % this.tabs.length]);
  },

  renderTabs() {
    const el = $("#tabs");
    el.innerHTML = "";
    for (const tab of this.tabs) {
      const p = tab.pane;
      const name = this.pathName(p.path) || t("Cartelle condivise");
      const label = tab.split ? `${name} | ${this.pathName(tab.panes[1 - tab.active].path) || "NAS"}` : name;
      const b = h(`<div class="tab ${tab === this.current ? "active" : ""}" role="tab" title="${esc(p.path)}" draggable="true">
        <span class="tab-icon">${p.path === "/" ? shareGlyph("homes") : folderGlyphHTML(p.path, name, glyph({ kind: "d", name }))}</span>
        <span class="tab-label">${esc(label)}</span>
        <button class="tab-close" title="${t("Chiudi scheda")} (Ctrl+W)">${svg("close")}</button></div>`);
      b.onclick = (e) => {
        if (!e.target.closest(".tab-close")) this.switchTab(tab);
      };
      b.onauxclick = (e) => e.button === 1 && this.closeTab(tab);
      b.querySelector(".tab-close").onclick = () => this.closeTab(tab);
      // reorder by dragging the tab itself
      b.addEventListener("dragstart", (e) => {
        if (e.target !== b) return;
        e.dataTransfer.setData("application/x-synofile-tab", tab.id);
        e.dataTransfer.effectAllowed = "move";
      });
      b.addEventListener("dragover", (e) => {
        if (e.dataTransfer.types.includes("application/x-synofile-tab")) {
          e.preventDefault();
          b.classList.add("drop");
        }
      });
      b.addEventListener("dragleave", () => b.classList.remove("drop"));
      b.addEventListener("drop", (e) => {
        const id = e.dataTransfer.getData("application/x-synofile-tab");
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        b.classList.remove("drop");
        const from = this.tabs.findIndex((x) => x.id === id);
        const to = this.tabs.indexOf(tab);
        if (from < 0 || from === to) return;
        const [moved] = this.tabs.splice(from, 1);
        this.tabs.splice(to, 0, moved);
        this.renderTabs();
        this.saveTabs();
      });
      // files dragged over a tab: wait a moment, then switch to it
      this.makeDropTarget(b, () => (tab.pane.path === "/" ? null : tab.pane.path));
      b.addEventListener("dragenter", (e) => {
        if (e.dataTransfer.types.includes("application/x-synofile-tab")) return;
        clearTimeout(this.tabHover);
        this.tabHover = setTimeout(() => tab !== this.current && this.switchTab(tab), 650);
      });
      b.addEventListener("dragleave", () => clearTimeout(this.tabHover));
      el.append(b);
    }
  },

  isSplit() {
    return !!this.current?.split;
  },

  activate(pane) {
    const tab = this.current;
    const i = tab.panes.indexOf(pane);
    if (i < 0 || i === tab.active) return;
    tab.active = i;
    tab.panes.forEach((p, k) => p.el.classList.toggle("active", k === i));
    this.renderTabs();
    this.renderSidebar();
  },

  other() {
    const tab = this.current;
    return tab.split ? tab.panes[1 - tab.active] : null;
  },

  toggleSplit() {
    const tab = this.current;
    if (tab.split) {
      tab.panes.splice(1 - tab.active, 1);
      tab.active = 0;
      tab.split = false;
    } else {
      const p = new Pane(this, { path: this.pane.path, view: this.pane.view, sort: { ...this.pane.sort } });
      tab.panes.push(p);
      tab.split = true;
      p.load();
    }
    this.switchTab(tab);
  },
};
