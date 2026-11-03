// SynoFile: the application around the panes. App holds the state of the
// page and starts it; its methods live by subject in tabs.js, sidebar.js,
// actions.js, dnd.js, menus.js, keys.js and health.js.

import { api, loadToken } from "./api.js";
import { prefs, save, loadLocal, loadRemote, onChange } from "./prefs.js";
import { t, loadTable } from "./i18n.js";
import { baseName, parentOf, joinPath } from "./format.js";
import { svg } from "./icons.js";
import { $, toast } from "./ui.js";
import * as transfers from "./transfers.js";
import { openSettings } from "./settings.js";
import { moveFolderIcons } from "./iconpick.js";
import { tabMethods } from "./tabs.js";
import { sidebarMethods } from "./sidebar.js";
import { actionMethods } from "./actions.js";
import { dndMethods } from "./dnd.js";
import { menuMethods } from "./menus.js";
import { keyMethods } from "./keys.js";
import { healthMethods } from "./health.js";

// what each preference redraws when it changes (prefsChanged)
const QUIET_PREFS = new Set(["tabs", "folderViews", "sort", "view", "sidebar", "singleClick", "vimKeys", "confirmDelete", "conflict", "verify", "limit", "openDialog", "notify", "dsmTray", "startIn", "newTabIn", "startFolder", "perFolder"]);
const RESORT_PREFS = new Set(["showHidden", "foldersFirst", "hiddenLast"]);
const REPAINT_PREFS = new Set(["columns", "binarySizes", "relativeDates", "todayHighlight", "llColumns", "icons", "colors", "size", "density", "folderIcons", "info"]);
const SIDEBAR_PREFS = new Set(["favorites", "showFavorites", "volumeNames", "volumeOrder", "folderIcons"]);

class App {
  constructor() {
    this.tabs = [];
    this.current = null;
    this.closed = [];
    this.clipboard = null;
    this.shares = [];
    this.user = "";
    this.conns = [];
    this.connKey = null;
    this.hostname = "";
  }

  async start() {
    this.ensureChrome();
    loadLocal();
    this.embedded = window.self !== window.top;
    if (this.embedded) document.body.classList.add("embedded");
    this.translateChrome();
    this.popOutButton();
    $("#tab-new").innerHTML = svg("plus");
    $("#tab-new").onclick = () => this.newTab(this.newTabPath());
    $("#open-settings").innerHTML = svg("settings");
    $("#theme-toggle").onclick = () => this.toggleTheme();
    this.renderThemeButton();
    $("#open-settings").onclick = () => openSettings();
    if (this.embedded) this.bindOpenMessages();
    addEventListener("synofile:unauth", () => this.needLogin());
    addEventListener("synofile:auth", () => this.sessionBack());
    // inside DSM the token is there at once; on its own the page asks DSM
    if (!(await loadToken())) return this.needLogin();
    const init = await this.loadInit();
    if (!init) return;
    if (init.whoami && this.staleBuild(init.whoami.asset)) return;
    await loadRemote(init.prefs);
    onChange((keys) => this.prefsChanged(keys));
    if (init.shares) this.applyShares(init.shares);
    if (init.conns) this.applyConns(init.conns);
    this.restoreTabs();
    this.bindKeys();
    this.bindGlobalDrop();
    this.bindUploadInputs();
    transfers.init(this);
    if (!init.shares) this.loadShares();
    if (!init.conns) this.loadConns();
    if (init.whoami) this.checkHealth(init.whoami);
  }

  /**
   * What the page needs to start, in one request: who is there,
   * preferences, shared folders and connections. A part missing is
   * undefined, and asked for later on its own; null: nothing to start.
   */
  async loadInit() {
    try {
      return await api.init();
    } catch (e) {
      if (e.status === 401) return null; // the login banner is up already
      if (e.status === 403) {
        this.adminOnly();
        return null;
      }
    }
    // a NAS without the init route, or a hiccup: the requests one by one
    const [whoami, prefs] = await Promise.all([api.whoami().catch(() => undefined), api.prefs().catch(() => undefined)]);
    return { whoami, prefs };
  }

  get pane() {
    return this.current?.pane;
  }

  paneChanged(pane) {
    if (this.current?.panes.includes(pane)) {
      this.renderTabs();
      this.renderSidebar();
    }
    this.saveTabs();
  }

  selectionChanged(pane) {
    pane.renderInfo();
  }

  rememberSort(sort, pane) {
    save({ sort: { ...sort } });
    this.rememberFolder(pane);
  }

  rememberView(view, pane) {
    save({ view });
    this.rememberFolder(pane);
    this.saveTabs();
  }

  /** With "remember for each folder": this folder's view and sort, the 500 latest. */
  rememberFolder(pane) {
    if (!prefs.perFolder || !pane || pane.path === "/") return;
    const all = { ...prefs.folderViews };
    delete all[pane.path];
    all[pane.path] = { view: pane.view, sort: { ...pane.sort } };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete all[k];
    save({ folderViews: all });
  }

  /** Dark ⇄ light; "as the system" becomes the opposite of what it shows now. */
  toggleTheme() {
    save({ theme: document.documentElement.dataset.theme === "light" ? "dark" : "light" });
  }

  renderThemeButton() {
    const light = document.documentElement.dataset.theme === "light";
    const b = $("#theme-toggle");
    b.innerHTML = svg(light ? "moon" : "sun");
    b.title = t(light ? "Passa al tema scuro" : "Passa al tema chiaro");
  }

  /**
   * Preferences changed (`keys`, or null for any): only what they touch is
   * redrawn. The tabs remembered after each folder opened redraw nothing,
   * so a double click in progress is not lost.
   */
  prefsChanged(keys) {
    const known = (k) => QUIET_PREFS.has(k) || RESORT_PREFS.has(k) || REPAINT_PREFS.has(k) || SIDEBAR_PREFS.has(k) || k === "theme";
    const all = !keys || keys.some((k) => !known(k));
    const any = (set) => all || keys.some((k) => set.has(k));
    if (all || keys.includes("theme")) this.renderThemeButton();
    const resort = any(RESORT_PREFS);
    if (resort || any(REPAINT_PREFS)) {
      // the other tabs draw themselves when shown again
      for (const tab of this.tabs)
        for (const p of tab.panes) {
          if (resort) p.refilter();
          if (tab === this.current) p.render();
        }
    }
    if (all || keys.includes("folderIcons")) this.renderTabs();
    if (any(SIDEBAR_PREFS)) this.renderSidebar();
  }

  toggleHidden() {
    save({ showHidden: !prefs.showHidden });
    toast(prefs.showHidden ? t("File nascosti visibili") : t("File nascosti non visibili"), { timeout: 1500 });
  }

  toggleInfo() {
    save({ info: !prefs.info });
  }

  allPanes() {
    return this.tabs.flatMap((t) => t.panes);
  }

  /** Reloads every pane showing one of these folders. */
  refreshFolders(paths) {
    const set = new Set(paths);
    for (const p of this.allPanes()) if (set.has(p.path)) p.reload();
  }

  refreshAfter(job) {
    if (job.op === "move" && job.state === "done" && !job.progress.errors) for (const p of job.info.sources) moveFolderIcons(p, joinPath(job.info.dest, baseName(p)));
    const dirs = new Set(job.info.sources.map(parentOf));
    // a deletion fills or empties a bin: the share's top shows which
    if (job.op === "delete") for (const p of job.info.sources) dirs.add("/" + p.split("/")[1]);
    if (job.info.dest) dirs.add(job.info.dest);
    this.refreshFolders([...dirs]);
    this.loadShares();
  }

  openPath(path) {
    this.pane.go(path);
  }
}

// the rest of App's methods, by subject
Object.assign(App.prototype, tabMethods, sidebarMethods, actionMethods, dndMethods, menuMethods, keyMethods, healthMethods);

await loadTable();
const app = new App();
window.synofile = app;
app.start();
