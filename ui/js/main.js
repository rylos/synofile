// SynoFile: the application around the panes — tabs, sidebar, clipboard,
// menus, keyboard, drag and drop, and the jobs they start.

import { api, loadToken } from "./api.js";
import { prefs, save, loadLocal, loadRemote, onChange } from "./prefs.js";
import { t, count, loadTable } from "./i18n.js";
import { esc, size, int, baseName, parentOf, joinPath } from "./format.js";
import { svg, glyph, shareGlyph, previewKind, isArchive, archiveStem, FOLDER_GLYPH } from "./icons.js";
import { $, h, toast, errorToast, openMenu, confirmBox, promptBox, pickFolder, copyText, dialog } from "./ui.js";
import { Pane } from "./pane.js";
import * as transfers from "./transfers.js";
import { upload, fromDataTransfer, fromInput } from "./uploads.js";
import { quickLook } from "./preview.js";
import { openSettings } from "./settings.js";


const isDirLike = (e) => e.kind === "d" || e.link_dir;
const shareOf = (path) => path.split("/").filter(Boolean)[0] || "";

class Tab {
  constructor(app, state) {
    this.id = Math.random().toString(36).slice(2);
    this.panes = (state.panes || [{ path: state.path || "/" }]).map((p) => new Pane(app, p));
    this.split = this.panes.length > 1;
    this.active = Math.min(state.active || 0, this.panes.length - 1);
  }
  get pane() {
    return this.panes[this.active];
  }
  get state() {
    return { panes: this.panes.map((p) => p.state), active: this.active };
  }
}

class App {
  constructor() {
    this.tabs = [];
    this.current = null;
    this.closed = [];
    this.clipboard = null;
    this.shares = [];
    this.user = "";
  }

  async start() {
    this.ensureChrome();
    loadLocal();
    if (window.self !== window.top) document.body.classList.add("embedded");
    $("#tab-new").innerHTML = svg("plus");
    $("#tab-new").onclick = () => this.newTab(this.pane?.path || "/");
    $("#open-settings").innerHTML = svg("settings");
    $("#theme-toggle").onclick = () => this.toggleTheme();
    this.renderThemeButton();
    $("#open-settings").onclick = () => openSettings();
    await loadToken();
    await loadRemote();
    onChange(() => this.prefsChanged());
    this.restoreTabs();
    this.bindKeys();
    this.bindGlobalDrop();
    this.bindUploadInputs();
    transfers.init(this);
    this.loadShares();
    this.checkHealth();
  }

  // ---------- tabs ----------
  restoreTabs() {
    const saved = prefs.tabs;
    let list = saved?.list?.length ? saved.list : [{ panes: [{ path: "/" }] }];
    const q = new URLSearchParams(location.search);
    if (q.get("path")) list = [{ panes: [{ path: q.get("path"), view: q.get("view") || undefined }] }];
    for (const s of list) this.tabs.push(new Tab(this, s));
    const cur = this.tabs[Math.min(saved?.current || 0, this.tabs.length - 1)];
    this.switchTab(cur);
    for (const tab of this.tabs) for (const p of tab.panes) p.load().then(() => p.render());
  }

  saveTabs() {
    clearTimeout(this.tabTimer);
    this.tabTimer = setTimeout(() => {
      save({ tabs: { list: this.tabs.map((t) => t.state), current: this.tabs.indexOf(this.current) } });
    }, 400);
  }

  get pane() {
    return this.current?.pane;
  }

  newTab(path = "/", activate = true) {
    const tab = new Tab(this, { panes: [{ path, view: this.pane?.view }] });
    const at = this.current ? this.tabs.indexOf(this.current) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    tab.pane.load().then(() => tab.pane.render());
    if (activate) this.switchTab(tab);
    else this.renderTabs();
    this.saveTabs();
    return tab;
  }

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
  }

  reopenTab() {
    const s = this.closed.pop();
    if (!s) return;
    const tab = new Tab(this, s);
    this.tabs.push(tab);
    tab.panes.forEach((p) => p.load().then(() => p.render()));
    this.switchTab(tab);
  }

  switchTab(tab) {
    if (!tab) return;
    this.current = tab;
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
  }

  cycleTab(d) {
    const i = this.tabs.indexOf(this.current);
    this.switchTab(this.tabs[(i + d + this.tabs.length) % this.tabs.length]);
  }

  renderTabs() {
    const el = $("#tabs");
    el.innerHTML = "";
    for (const tab of this.tabs) {
      const p = tab.pane;
      const name = baseName(p.path) || t("Cartelle condivise");
      const label = tab.split ? `${name} | ${baseName(tab.panes[1 - tab.active].path) || "NAS"}` : name;
      const b = h(`<div class="tab ${tab === this.current ? "active" : ""}" role="tab" title="${esc(p.path)}" draggable="true">
        <span class="tab-icon">${p.path === "/" ? shareGlyph("homes") : glyph({ kind: "d", name })}</span>
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
  }

  // ---------- panes ----------
  isSplit() {
    return !!this.current?.split;
  }

  activate(pane) {
    const tab = this.current;
    const i = tab.panes.indexOf(pane);
    if (i < 0 || i === tab.active) return;
    tab.active = i;
    tab.panes.forEach((p, k) => p.el.classList.toggle("active", k === i));
    this.renderTabs();
    this.renderSidebar();
  }

  other() {
    const tab = this.current;
    return tab.split ? tab.panes[1 - tab.active] : null;
  }

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
      p.load().then(() => p.render());
    }
    this.switchTab(tab);
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

  rememberSort(sort) {
    save({ sort: { ...sort } });
  }

  rememberView(view) {
    save({ view });
    this.saveTabs();
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

  prefsChanged() {
    this.renderThemeButton();
    for (const tab of this.tabs)
      for (const p of tab.panes) {
        p.refilter();
        if (tab === this.current) p.render();
      }
    this.renderSidebar();
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
    const dirs = new Set(job.info.sources.map(parentOf));
    if (job.info.dest) dirs.add(job.info.dest);
    this.refreshFolders([...dirs]);
    this.loadShares();
  }

  openPath(path) {
    this.pane.go(path);
  }

  // ---------- sidebar ----------
  async loadShares() {
    try {
      const data = await api.shares();
      this.shares = data.shares;
      this.user = data.user;
      this.renderSidebar();
    } catch (e) {
      if (e.status === 401) this.banner(t("Sessione DSM scaduta: accedi di nuovo a DSM e riapri SynoFile."));
      else if (e.status === 403) this.banner(t("SynoFile è riservato agli amministratori di DSM."));
    }
  }

  renderSidebar() {
    const el = $("#sidebar");
    const cur = this.pane?.path || "/";
    const item = (path, name, gl, sub = "", extra = "") => {
      const active = cur === path || (path !== "/" && cur.startsWith(path + "/") && !extra.includes("nested"));
      return `<button class="side-item ${active ? "active" : ""}" data-path="${esc(path)}"><i class="gi">${gl}</i><span class="si-text"><span class="si-name">${esc(name)}</span>${sub}</span>${extra.replace("nested", "")}</button>`;
    };
    let html = "";
    const favs = prefs.favorites || [];
    html += `<div class="side-title">${t("Preferiti")}</div>`;
    if (favs.length) html += favs.map((f) => item(f.path, f.name || baseName(f.path), glyph({ kind: "d", name: baseName(f.path) }), "", "nested")).join("");
    else html += `<div class="hint" style="padding:2px 10px 6px">${t("Ctrl+D aggiunge la cartella aperta")}</div>`;
    const volumes = new Map();
    for (const s of this.shares) {
      const v = s.home ? "home" : s.volume;
      if (!volumes.has(v)) volumes.set(v, []);
      volumes.get(v).push(s);
    }
    for (const [vol, list] of volumes) {
      const first = list[0];
      const used = first.total ? 1 - first.free / first.total : 0;
      const title = vol === "home" ? t("Personale") : vol.replace("volume", t("Volume") + " ").replace("USB", "USB ");
      html += `<div class="side-title"><span>${esc(title)}</span>${first.total && vol !== "home" ? `<span title="${t("{f} liberi di {t}", { f: size(first.free), t: size(first.total) })}">${size(first.free)}</span>` : ""}</div>`;
      if (first.total && vol !== "home") html += `<div class="vol-bar ${used > 0.95 ? "full" : used > 0.85 ? "high" : ""}" style="margin:0 10px 6px"><div style="width:${(used * 100).toFixed(1)}%"></div></div>`;
      for (const s of list) {
        const badges = (s.encrypted ? `<span class="si-badge" title="${t("Cartella crittografata")}">🔒</span>` : "") + (s.hidden ? `<span class="si-badge" title="${t("Nascosta in Rete")}">${t("nasc.")}</span>` : "");
        html += item("/" + s.name, s.home ? t("Home ({u})", { u: this.user }) : s.name, s.home ? shareGlyph("home") : shareGlyph(s.name), s.comment ? `<span class="si-sub">${esc(s.comment)}</span>` : "", badges);
      }
    }
    el.innerHTML = html;
    el.querySelectorAll(".side-item").forEach((b) => {
      b.onclick = () => this.pane.go(b.dataset.path);
      b.onauxclick = (e) => e.button === 1 && this.newTab(b.dataset.path, false);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        this.sideMenu(b.dataset.path, e.clientX, e.clientY);
      };
      this.makeDropTarget(b, () => b.dataset.path);
    });
  }

  sideMenu(path, x, y) {
    const fav = (prefs.favorites || []).some((f) => f.path === path);
    const share = this.shares.find((s) => "/" + s.name === path);
    openMenu(x, y, [
      { label: t("Apri"), icon: "forward", action: () => this.pane.go(path) },
      { label: t("Apri in una nuova scheda"), icon: "plus", action: () => this.newTab(path) },
      this.isSplit() && { label: t("Apri nell'altro pannello"), icon: "split", action: () => this.other().go(path) },
      share?.recycle && { label: t("Apri il Cestino"), icon: "trash", action: () => this.pane.go(path + "/#recycle") },
      "-",
      fav ? { label: t("Togli dai preferiti"), icon: "star", action: () => this.toggleFavorite(path) } : { label: t("Aggiungi ai preferiti"), icon: "star", action: () => this.toggleFavorite(path) },
      { label: t("Copia percorso"), icon: "link", action: () => copyText(path) },
      { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(path) },
    ]);
  }

  toggleFavorite(path = this.pane.path) {
    if (path === "/") return;
    let favs = [...(prefs.favorites || [])];
    if (favs.some((f) => f.path === path)) {
      favs = favs.filter((f) => f.path !== path);
      toast(t("Tolta dai preferiti"), { timeout: 1500 });
    } else {
      favs.push({ path, name: baseName(path) });
      toast(t("Aggiunta ai preferiti"), { kind: "ok", timeout: 1500 });
    }
    save({ favorites: favs });
  }

  // ---------- opening ----------
  open(pane, entry) {
    if (!entry) return;
    if (isDirLike(entry)) return pane.go(entry.path);
    if (previewKind(entry) !== "other") return this.quickLook(pane);
    this.download([entry]);
  }

  quickLook(pane = this.pane) {
    const e = pane.visible[pane.cursor];
    if (!e) return;
    if (isDirLike(e)) return pane.go(e.path);
    quickLook(pane, (list) => this.download(list));
  }

  download(entries) {
    if (!entries.length) return;
    const a = document.createElement("a");
    a.href = api.download(entries.map((e) => e.path));
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
    if (entries.length > 1 || isDirLike(entries[0])) toast(t("Download come archivio .zip avviato"), { timeout: 2500 });
  }

  // ---------- archives ----------
  compress(pane) {
    const list = pane.targets().filter((e) => !e.share);
    if (!list.length || pane.path === "/") return;
    const base = list.length === 1 ? (isDirLike(list[0]) ? list[0].name : archiveStem(list[0].name)) : baseName(pane.path) || t("Archivio");
    const dlg = dialog(`<form method="dialog">
      <div class="dlg-head"><div class="dlg-icon">${svg("archive")}</div><h2>${t("Comprimi in .zip")}</h2></div>
      <div class="dlg-body">
        <p>${t("{n} in un archivio zip, nella stessa cartella.", { n: count(list.length, "elemento", "elementi", int) })}</p>
        <label class="field"><span>${t("Nome dell'archivio")}</span><input type="text" class="nm" value="${esc(base)}.zip" spellcheck="false"></label>
        <label class="field"><span>${t("Compressione")}</span><select class="lv">
          <option value="normal">${t("Normale")}</option><option value="fast">${t("Veloce")}</option><option value="store">${t("Nessuna (solo archivio, il più veloce)")}</option></select></label>
        <p class="hint">${t("Foto, video, musica e archivi vengono solo archiviati: comprimerli di nuovo non fa risparmiare spazio.")}</p>
      </div>
      <div class="dlg-foot"><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${t("Comprimi")}</button></div></form>`);
    const input = dlg.querySelector(".nm");
    input.focus();
    input.setSelectionRange(0, input.value.length - 4);
    dlg.querySelector(".cancel").onclick = () => dlg.close();
    dlg.querySelector("form").onsubmit = () => {
      const name = input.value.trim();
      if (!name || name.includes("/")) return;
      transfers.start({ op: "compress", sources: list.map((e) => e.path), dest: pane.path, name, level: dlg.querySelector(".lv").value });
    };
  }

  async extract(pane, entry, mode) {
    let dest = parentOf(entry.path);
    if (mode === "pick") {
      dest = await pickFolder({ title: t("Estrai «{x}» in…", { x: entry.name }), start: this.other()?.path || dest, ok: t("Estrai qui") });
      if (!dest) return;
    }
    transfers.start({ op: "extract", sources: [entry.path], dest, into_folder: mode !== "here", conflict: mode === "here" ? (prefs.conflict === "ask" ? "rename" : prefs.conflict) : "rename" });
  }

  fileStation(path) {
    try {
      const sds = window.parent !== window && window.parent.SYNO && window.parent.SYNO.SDS;
      if (sds && sds.AppLaunch) return sds.AppLaunch("SYNO.SDS.App.FileStation3.Instance", { openfile: path.endsWith("/") ? path : path + "/" });
    } catch {}
    toast(t("File Station si apre solo dalla finestra di DSM"), { kind: "error" });
  }

  copyPaths(entries, style) {
    const host = location.hostname;
    const fmt = (p) => (style === "smb" ? `\\\\${host}${p.replace(/\//g, "\\")}` : style === "url" ? `smb://${host}${encodeURI(p)}` : p);
    copyText(entries.map((e) => fmt(e.path || e)).join("\n"));
  }

  // ---------- clipboard and jobs ----------
  cutPaths() {
    return this.clipboard?.op === "cut" ? new Set(this.clipboard.paths) : new Set();
  }

  setClipboard(op, pane) {
    const list = pane.targets().filter((e) => !e.share);
    if (!list.length) return;
    this.clipboard = { op, paths: list.map((e) => e.path), from: pane.path };
    toast(t(op === "cut" ? "{n} pronti da spostare: incolla con Ctrl+V" : "{n} pronti da copiare: incolla con Ctrl+V", { n: count(list.length, "elemento", "elementi", int) }), { timeout: 2200 });
    this.allPanes().forEach((p) => p.paint());
    pane.renderStatus();
  }

  paste(pane = this.pane, dest = pane.path) {
    const cb = this.clipboard;
    if (!cb || dest === "/") return;
    if (cb.op === "cut" && cb.from === dest) return toast(t("Gli elementi sono già in questa cartella"));
    this.transfer(cb.op === "cut" ? "move" : "copy", cb.paths, dest);
    if (cb.op === "cut") this.clipboard = null;
    this.allPanes().forEach((p) => p.paint());
  }

  transfer(op, paths, dest) {
    if (!paths.length || !dest || dest === "/") return;
    if (paths.some((p) => dest === p || dest.startsWith(p + "/"))) return toast(t("Una cartella non può finire dentro sé stessa"), { kind: "error" });
    if (op === "move" && paths.every((p) => parentOf(p) === dest)) return;
    transfers.start({ op, sources: paths, dest });
  }

  async copyTo(pane, op) {
    const list = pane.targets().filter((e) => !e.share);
    if (!list.length) return;
    const other = this.other();
    const dest = await pickFolder({
      title: t(op === "move" ? "Sposta {n} in…" : "Copia {n} in…", { n: count(list.length, "elemento", "elementi", int) }),
      start: other ? other.path : pane.path,
      ok: t(op === "move" ? "Sposta qui" : "Copia qui"),
    });
    if (dest) this.transfer(op, list.map((e) => e.path), dest);
  }

  toOtherPane(op) {
    const other = this.other();
    if (!other) return toast(t("Apri il doppio pannello con F3"));
    const list = this.pane.targets().filter((e) => !e.share);
    if (list.length) this.transfer(op, list.map((e) => e.path), other.path);
  }

  async remove(pane, permanent = false) {
    const list = pane.targets().filter((e) => !e.share);
    if (!list.length) return;
    const inBin = pane.path.split("/").includes("#recycle");
    const recycle = pane.recycle && !permanent && !inBin;
    if (prefs.confirmDelete || !recycle) {
      const names = list.map((e) => `<i class="gi">${glyph(e)}</i>${esc(e.name)}`);
      const ok = await confirmBox({
        title: recycle ? t("Spostare nel Cestino?") : t("Eliminare definitivamente?"),
        message: recycle
          ? t("{n} finiranno nel Cestino di DSM della cartella condivisa, da dove si possono recuperare.", { n: count(list.length, "elemento", "elementi", int) })
          : `<b style="color:var(--crit)">${t("{n} verranno eliminati per sempre: non si possono recuperare.", { n: count(list.length, "elemento", "elementi", int) })}</b>${!pane.recycle && !inBin ? "<br>" + t("Il Cestino di questa cartella condivisa è disattivato.") : ""}`,
        items: names,
        ok: recycle ? t("Sposta nel Cestino") : t("Elimina"),
        danger: !recycle,
        icon: "trash",
      });
      if (!ok) return;
    }
    transfers.start({ op: "delete", sources: list.map((e) => e.path), permanent: !recycle });
  }

  async renamePrompt(pane, e) {
    const name = await promptBox({
      title: t("Rinomina"),
      label: t("Nuovo nome"),
      value: e.name,
      ok: t("Rinomina"),
      select: (v) => {
        const i = v.lastIndexOf(".");
        return [0, isDirLike(e) || i <= 0 ? v.length : i];
      },
      validate: (v) => (!v.trim() || v.includes("/") ? t("Nome non valido") : null),
    });
    if (!name || name === e.name) return;
    try {
      await api.rename(e.path, name);
      await pane.reload();
      pane.selectPath(joinPath(parentOf(e.path), name));
      this.refreshFolders([pane.path]);
    } catch (err) {
      errorToast(err);
    }
  }

  async newFolder(pane = this.pane) {
    if (pane.path === "/") return;
    const name = await promptBox({ title: t("Nuova cartella"), label: t("Nome"), value: t("Nuova cartella"), icon: "folderPlus", ok: t("Crea"), validate: (v) => (!v.trim() || v.includes("/") ? t("Nome non valido") : null) });
    if (!name) return;
    try {
      await api.mkdir(pane.path, name);
      await pane.reload();
      pane.selectPath(joinPath(pane.path, name));
    } catch (err) {
      errorToast(err);
    }
  }

  async computeSizes(pane, entries) {
    const dirs = entries.filter(isDirLike);
    if (!dirs.length) return;
    toast(t("Calcolo delle dimensioni…"), { timeout: 1500 });
    const queue = [...dirs];
    const worker = async () => {
      while (queue.length) {
        const e = queue.shift();
        try {
          const u = await api.usage([e.path]);
          pane.dirSizes.set(e.path, u);
          pane.paint(true);
          pane.renderInfo();
          pane.renderStatus();
        } catch (err) {
          errorToast(err);
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // ---------- uploads ----------
  bindUploadInputs() {
    const files = $("#upload-files");
    const folder = $("#upload-folder");
    const go = (input) => {
      const items = fromInput(input.files);
      const dest = this.uploadDest || this.pane.path;
      input.value = "";
      upload(dest, items, () => this.refreshFolders([dest]));
    };
    files.onchange = () => go(files);
    folder.onchange = () => go(folder);
  }

  pickUpload(kind, pane = this.pane) {
    if (pane.path === "/") return toast(t("Apri prima una cartella condivisa"));
    this.uploadDest = pane.path;
    $(kind === "folder" ? "#upload-folder" : "#upload-files").click();
  }

  // ---------- drag and drop ----------
  /**
   * Makes `el` take drops: items of this page (move or copy) and files
   * from the computer (upload). `dest(ev)` gives the folder, `hot(ev)` the
   * element to light up.
   */
  makeDropTarget(el, dest, hot) {
    let lit = null;
    const light = (on, ev) => {
      lit?.classList.remove("drop");
      lit = on ? (hot ? hot(ev) : el) : null;
      lit?.classList.add("drop");
    };
    el.addEventListener("dragover", (ev) => {
      const types = ev.dataTransfer.types;
      if (types.includes("application/x-synofile-tab")) return;
      const internal = types.includes("application/x-synofile");
      const files = types.includes("Files");
      if (!internal && !files) return;
      const d = dest(ev);
      if (!d) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = files ? "copy" : this.dropOp(ev, d) === "copy" ? "copy" : "move";
      light(true, ev);
    });
    el.addEventListener("dragleave", (ev) => {
      if (!el.contains(ev.relatedTarget)) light(false);
    });
    el.addEventListener("drop", async (ev) => {
      light(false);
      const d = dest(ev);
      if (!d) return;
      ev.preventDefault();
      ev.stopPropagation();
      $("#drop-overlay").hidden = true;
      const raw = ev.dataTransfer.getData("application/x-synofile");
      if (raw) {
        const { paths } = JSON.parse(raw);
        const op = this.dropOp(ev, d, paths);
        if (op === "ask") return this.dropMenu(ev, paths, d);
        this.transfer(op, paths, d);
      } else if (ev.dataTransfer.types.includes("Files")) {
        const items = await fromDataTransfer(ev.dataTransfer);
        upload(d, items, () => this.refreshFolders([d]));
      }
    });
  }

  /** Like Windows: within one shared folder a drop moves, across shares it copies; Ctrl copies, Shift moves, Alt asks. */
  dropOp(ev, dest, paths) {
    if (ev.altKey) return "ask";
    if (ev.ctrlKey) return "copy";
    if (ev.shiftKey) return "move";
    const from = paths ? shareOf(paths[0]) : null;
    return from && from !== shareOf(dest) ? "copy" : "move";
  }

  dropMenu(ev, paths, dest) {
    openMenu(ev.clientX, ev.clientY, [
      { title: baseName(dest) },
      { label: t("Copia qui"), icon: "copy", action: () => this.transfer("copy", paths, dest) },
      { label: t("Sposta qui"), icon: "move", action: () => this.transfer("move", paths, dest) },
      "-",
      { label: t("Annulla"), icon: "close" },
    ]);
  }

  bindGlobalDrop() {
    let depth = 0;
    const overlay = $("#drop-overlay");
    addEventListener("dragenter", (e) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depth++;
      if (this.pane.path !== "/") {
        $("#drop-target").textContent = this.pane.path;
        overlay.hidden = false;
      }
    });
    addEventListener("dragleave", (e) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    addEventListener("dragover", (e) => e.dataTransfer.types.includes("Files") && e.preventDefault());
    addEventListener("drop", (e) => {
      depth = 0;
      overlay.hidden = true;
      e.preventDefault();
    });
  }

  // ---------- menus ----------
  contextMenu(pane, entry, x, y) {
    const list = pane.targets();
    const many = list.length > 1;
    const atRoot = pane.path === "/";
    const canPaste = this.clipboard && !atRoot;
    if (!entry) {
      return openMenu(x, y, [
        !atRoot && { label: t("Nuova cartella"), icon: "folderPlus", key: "Ctrl+Shift+N", action: () => this.newFolder(pane) },
        !atRoot && { label: t("Carica file…"), icon: "upload", key: "Ctrl+U", action: () => this.pickUpload("files", pane) },
        !atRoot && { label: t("Carica cartella…"), icon: "upload", action: () => this.pickUpload("folder", pane) },
        canPaste && "-",
        canPaste && { label: t(this.clipboard.op === "cut" ? "Incolla (sposta {n})" : "Incolla ({n})", { n: this.clipboard.paths.length }), icon: "paste", key: "Ctrl+V", action: () => this.paste(pane) },
        "-",
        { label: t("Seleziona tutto"), key: "Ctrl+A", action: () => pane.selectAll() },
        { label: prefs.showHidden ? t("Nascondi i file nascosti") : t("Mostra i file nascosti"), icon: prefs.showHidden ? "eyeOff" : "eye", key: "Ctrl+H", action: () => this.toggleHidden() },
        { label: t("Calcola dimensione delle cartelle"), icon: "drive", action: () => this.computeSizes(pane, pane.visible) },
        "-",
        !atRoot && { label: t("Copia percorso della cartella"), icon: "link", action: () => copyText(pane.path) },
        !atRoot && { label: t("Aggiungi ai preferiti"), icon: "star", key: "Ctrl+D", action: () => this.toggleFavorite(pane.path) },
        !atRoot && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(pane.path) },
        { label: t("Aggiorna"), icon: "refresh", key: "F5", action: () => pane.reload() },
      ]);
    }
    const dir = isDirLike(entry);
    const share = !!entry.share;
    const other = this.other();
    openMenu(x, y, [
      many ? { title: count(list.length, "elemento selezionato", "elementi selezionati", int) } : null,
      !many && { label: dir ? t("Apri") : t("Anteprima"), icon: dir ? "forward" : "eye", key: dir ? "Invio" : "Spazio", action: () => this.open(pane, entry) },
      !many && dir && { label: t("Apri in una nuova scheda"), icon: "plus", key: "Ctrl+Invio", action: () => this.newTab(entry.path) },
      !many && dir && other && { label: t("Apri nell'altro pannello"), icon: "split", action: () => other.go(entry.path) },
      { label: many || dir ? t("Scarica (.zip)") : t("Scarica"), icon: "download", action: () => this.download(list) },
      !many && isArchive(entry) && "-",
      !many && isArchive(entry) && { label: t("Estrai in «{x}»", { x: archiveStem(entry.name) }), icon: "archive", action: () => this.extract(pane, entry, "folder") },
      !many && isArchive(entry) && { label: t("Estrai qui"), icon: "archive", action: () => this.extract(pane, entry, "here") },
      !many && isArchive(entry) && { label: t("Estrai in…"), icon: "archive", action: () => this.extract(pane, entry, "pick") },
      !share && { label: t("Comprimi in .zip…"), icon: "archive", action: () => this.compress(pane) },
      "-",
      !share && { label: t("Copia"), icon: "copy", key: "Ctrl+C", action: () => this.setClipboard("copy", pane) },
      !share && { label: t("Taglia"), icon: "cut", key: "Ctrl+X", action: () => this.setClipboard("cut", pane) },
      dir && canPaste && !many && { label: t("Incolla dentro"), icon: "paste", action: () => this.paste(pane, entry.path) },
      !share && { label: t("Copia in…"), icon: "copy", key: other ? "F5" : "", action: () => (other ? this.toOtherPane("copy") : this.copyTo(pane, "copy")) },
      !share && { label: t("Sposta in…"), icon: "move", key: other ? "F6" : "", action: () => (other ? this.toOtherPane("move") : this.copyTo(pane, "move")) },
      !share && other && { label: t("Scegli cartella…"), icon: "move", action: () => this.copyTo(pane, "copy") },
      "-",
      !many && !share && { label: t("Rinomina"), icon: "rename", key: "F2", action: () => this.renamePrompt(pane, entry) },
      !share && { label: pane.recycle && !pane.path.includes("#recycle") ? t("Sposta nel Cestino") : t("Elimina"), icon: "trash", key: "Canc", danger: true, action: () => this.remove(pane) },
      !share && pane.recycle && { label: t("Elimina definitivamente"), icon: "trash", key: "Shift+Canc", danger: true, action: () => this.remove(pane, true) },
      "-",
      dir && { label: t("Calcola dimensione"), icon: "drive", action: () => this.computeSizes(pane, list) },
      { label: t("Copia percorso"), icon: "link", key: "Ctrl+Shift+C", action: () => this.copyPaths(list, "nas") },
      { label: t("Copia percorso di rete (\\\\NAS)"), icon: "link", action: () => this.copyPaths(list, "smb") },
      { label: t("Copia indirizzo smb://"), icon: "link", action: () => this.copyPaths(list, "url") },
      !many && dir && { label: t("Aggiungi ai preferiti"), icon: "star", action: () => this.toggleFavorite(entry.path) },
      !many && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(dir ? entry.path : parentOf(entry.path)) },
      !many && { label: t("Proprietà"), icon: "info", key: "Ctrl+I", action: () => !prefs.info && this.toggleInfo() },
    ]);
  }

  newMenu(pane, anchor) {
    const r = anchor.getBoundingClientRect();
    const disabled = pane.path === "/";
    openMenu(r.left, r.bottom + 4, [
      { label: t("Nuova cartella"), icon: "folderPlus", key: "Ctrl+Shift+N", disabled, action: () => this.newFolder(pane) },
      { label: t("Carica file…"), icon: "upload", key: "Ctrl+U", disabled, action: () => this.pickUpload("files", pane) },
      { label: t("Carica cartella…"), icon: "upload", disabled, action: () => this.pickUpload("folder", pane) },
      "-",
      { label: t("Nuova scheda"), icon: "plus", key: "Ctrl+T", action: () => this.newTab(pane.path) },
    ]);
  }

  moreMenu(pane, anchor) {
    const r = anchor.getBoundingClientRect();
    const fav = (prefs.favorites || []).some((f) => f.path === pane.path);
    openMenu(r.right - 240, r.bottom + 4, [
      { label: t("Seleziona tutto"), key: "Ctrl+A", action: () => pane.selectAll() },
      { label: t("Inverti selezione"), key: "Ctrl+Shift+I", action: () => pane.invertSelection() },
      this.clipboard && { label: t("Incolla"), icon: "paste", key: "Ctrl+V", action: () => this.paste(pane) },
      "-",
      { title: t("Ordina per") },
      ...[["name", "Nome"], ["size", "Dimensione"], ["mtime", "Modificato"], ["kind", "Tipo"]].map(([k, l]) => ({
        label: t(l) + (pane.sort.key === k ? (pane.sort.dir > 0 ? "  ▲" : "  ▼") : ""),
        action: () => pane.setSort(k),
      })),
      { label: (prefs.foldersFirst ? "✓ " : "") + t("Cartelle prima"), action: () => save({ foldersFirst: !prefs.foldersFirst }) },
      "-",
      { label: (prefs.sidebar ? "✓ " : "") + t("Barra laterale"), icon: "sidebar", key: "Ctrl+B", action: () => save({ sidebar: !prefs.sidebar }) },
      { label: t("Calcola dimensione delle cartelle"), icon: "drive", action: () => this.computeSizes(pane, pane.visible) },
      pane.path !== "/" && { label: fav ? t("Togli dai preferiti") : t("Aggiungi ai preferiti"), icon: "star", key: "Ctrl+D", action: () => this.toggleFavorite(pane.path) },
      pane.path !== "/" && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(pane.path) },
      "-",
      { label: t("Scorciatoie da tastiera"), icon: "keyboard", key: "?", action: () => openSettings("keys") },
      { label: t("Impostazioni"), icon: "settings", key: "Ctrl+,", action: () => openSettings() },
    ]);
  }

  columnsMenu(x, y) {
    const c = prefs.columns;
    const toggle = (k) => save({ columns: { ...c, [k]: !c[k] } });
    openMenu(x, y, [
      { title: t("Colonne") },
      { label: (c.mode ? "✓ " : "") + t("Permessi"), action: () => toggle("mode") },
      { label: (c.size ? "✓ " : "") + t("Dimensione"), action: () => toggle("size") },
      { label: (c.mtime ? "✓ " : "") + t("Modificato"), action: () => toggle("mtime") },
      { label: (c.kind ? "✓ " : "") + t("Tipo"), action: () => toggle("kind") },
    ]);
  }

  // ---------- keyboard ----------
  bindKeys() {
    let lastG = 0;
    document.addEventListener("keydown", (e) => {
      if (document.querySelector("dialog[open]")) return;
      const tag = e.target.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const pane = this.pane;
      if (!pane) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      const run = (fn) => {
        e.preventDefault();
        fn();
      };
      // tabs and app-wide keys work even while typing in the filter
      if (ctrl && !e.shiftKey && k.toLowerCase() === "t") return run(() => this.newTab(pane.path));
      if (ctrl && e.shiftKey && k.toLowerCase() === "t") return run(() => this.reopenTab());
      if (ctrl && k.toLowerCase() === "w") return run(() => this.closeTab());
      if ((ctrl && k === "Tab") || (ctrl && k === "PageDown") || (ctrl && k === "PageUp")) return run(() => this.cycleTab(k === "PageUp" || e.shiftKey ? -1 : 1));
      if (e.altKey && /^[1-9]$/.test(k)) return run(() => this.switchTab(this.tabs[Math.min(+k, this.tabs.length) - 1]));
      if (ctrl && k === ",") return run(() => openSettings());
      if (ctrl && k.toLowerCase() === "j") return run(() => transfers.showDrawer());
      if (ctrl && k.toLowerCase() === "f") return run(() => {
        pane.setSearchMode(true);
        pane.filterInput.focus();
      });
      if (ctrl && k.toLowerCase() === "l") return run(() => pane.editPath());
      if (ctrl && k.toLowerCase() === "h") return run(() => this.toggleHidden());
      if (ctrl && k.toLowerCase() === "b") return run(() => save({ sidebar: !prefs.sidebar }));
      if (k === "F3") return run(() => this.toggleSplit());
      if (typing) return;

      if (ctrl && k.toLowerCase() === "i" && e.shiftKey) return run(() => pane.invertSelection());
      if (ctrl && k.toLowerCase() === "i") return run(() => this.toggleInfo());
      if (ctrl && k === "1") return run(() => pane.setView("list"));
      if (ctrl && k === "2") return run(() => pane.setView("grid"));
      if (ctrl && k.toLowerCase() === "a") return run(() => pane.selectAll());
      if (ctrl && e.shiftKey && k.toLowerCase() === "c") return run(() => this.copyPaths(pane.targets(), "nas"));
      if (ctrl && k.toLowerCase() === "c") return run(() => this.setClipboard("copy", pane));
      if (ctrl && k.toLowerCase() === "x") return run(() => this.setClipboard("cut", pane));
      if (ctrl && k.toLowerCase() === "v") return run(() => this.paste(pane));
      if (ctrl && k.toLowerCase() === "d") return run(() => this.toggleFavorite(pane.path));
      if (ctrl && k.toLowerCase() === "u") return run(() => this.pickUpload("files", pane));
      if (ctrl && k.toLowerCase() === "r") return run(() => pane.reload());
      if (ctrl && e.shiftKey && k.toLowerCase() === "n") return run(() => this.newFolder(pane));
      if (ctrl && k === "Enter") return run(() => {
        const cur = pane.visible[pane.cursor];
        if (cur && isDirLike(cur)) this.newTab(cur.path, false);
      });
      if (k === "F5" && this.isSplit()) return run(() => this.toOtherPane("copy"));
      if (k === "F5") return run(() => pane.reload());
      if (k === "F6") return run(() => (this.isSplit() ? this.toOtherPane("move") : this.copyTo(pane, "move")));
      if (k === "F2") return run(() => pane.rename());
      if (k === "Delete") return run(() => this.remove(pane, e.shiftKey));
      if (k === "Tab" && this.isSplit()) return run(() => {
        this.activate(this.other());
        this.pane.focus();
      });
      if (e.altKey && k === "ArrowLeft") return run(() => pane.goBack());
      if (e.altKey && k === "ArrowRight") return run(() => pane.goForward());
      if ((e.altKey && k === "ArrowUp") || k === "Backspace") return run(() => pane.goUp());
      if (k === "Enter") return run(() => this.open(pane, pane.visible[pane.cursor]));
      if (k === " ") return run(() => this.quickLook(pane));
      if (k === "Insert") return run(() => {
        pane.toggleAtCursor();
        pane.moveCursor(pane.cursor + 1, { toggle: true });
      });
      if (k === "Escape") return run(() => {
        if (pane.filter || pane.search) pane.clearFilter();
        else {
          pane.sel.clear();
          if (this.clipboard) {
            this.clipboard = null;
            this.allPanes().forEach((p) => p.paint());
          }
          pane.render();
        }
      });
      const grid = pane.view === "grid";
      const step = grid ? pane.perRow || 1 : 1;
      const nav = { ArrowDown: step, ArrowUp: -step, PageDown: pane.pageSize(), PageUp: -pane.pageSize() };
      if (grid) Object.assign(nav, { ArrowRight: 1, ArrowLeft: -1 });
      const opts = { extend: e.shiftKey, toggle: ctrl };
      if (k in nav) return run(() => pane.moveCursor(pane.cursor + nav[k], opts));
      if (k === "Home") return run(() => pane.moveCursor(0, opts));
      if (k === "End") return run(() => pane.moveCursor(pane.visible.length - 1, opts));
      if (prefs.vimKeys && !ctrl && !e.altKey) {
        if (k === "j") return run(() => pane.moveCursor(pane.cursor + step, opts));
        if (k === "k") return run(() => pane.moveCursor(pane.cursor - step, opts));
        if (k === "h") return run(() => pane.goUp());
        if (k === "l") return run(() => this.open(pane, pane.visible[pane.cursor]));
        if (k === "G") return run(() => pane.moveCursor(pane.visible.length - 1));
        if (k === "g") return run(() => {
          if (Date.now() - lastG < 500) pane.moveCursor(0);
          lastG = Date.now();
        });
      }
      if (k === "/") return run(() => pane.filterInput.focus());
      if (k === "?") return run(() => openSettings("keys"));
      if (k.length === 1 && !ctrl && !e.altKey && /\S/.test(k)) return run(() => pane.typeAhead(k));
    });
  }

  /**
   * DSM's desktop keeps the loader of the window it opened first, so after
   * an upgrade a page from the old build may run with new scripts: what
   * the scripts need, they make themselves.
   */
  ensureChrome() {
    if (!$("#theme-toggle")) {
      const b = h(`<button class="icon-btn theme-btn" id="theme-toggle"></button>`);
      $("#open-settings")?.before(b);
    }
  }

  /** The NAS runs another build than this page: load it, once. */
  staleBuild(asset) {
    const mine = new URL(import.meta.url).searchParams.get("v");
    if (!asset || !mine || asset === mine) return false;
    const url = new URL(location.href);
    if (url.searchParams.get("v") === asset) return false;
    url.searchParams.set("v", asset);
    location.replace(url.toString());
    return true;
  }

  // ---------- health ----------
  async checkHealth() {
    try {
      const me = await api.whoami();
      if (this.staleBuild(me.asset)) return;
      this.user = me.user;
      if (!me.setup) this.banner(`${t("Permessi del pacchetto da attivare, una volta dopo ogni installazione o aggiornamento:")} <code>sudo /var/packages/synofile/target/bin/synofile setup</code> ${t("poi riavvia SynoFile dal Centro pacchetti.")}`, true);
      else if (!me.daemon) this.banner(t("Il servizio dei trasferimenti non è attivo: avvia SynoFile dal Centro pacchetti."));
    } catch (e) {
      if (e.status === 401) this.banner(t("Sessione DSM scaduta: accedi di nuovo a DSM e riapri SynoFile."));
      else if (e.status === 403) this.banner(t("SynoFile è riservato agli amministratori di DSM."));
    }
  }

  banner(html, raw = false) {
    const b = h(`<div class="banner">${svg("alert")}<div>${raw ? html : esc(html)}</div></div>`);
    $("#workspace").before(b);
    $(".body").prepend(b);
    b.style.position = "absolute";
    b.style.zIndex = 50;
    b.style.left = "250px";
    b.style.right = "10px";
    b.style.top = "44px";
  }
}

await loadTable();
const app = new App();
window.synofile = app;
app.start();
