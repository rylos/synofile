// The sidebar: favourites, shared folders by volume, remote connections;
// reordering them, their menus, ejecting USB drives. Methods of App (main.js).

import { api, dsm } from "./api.js";
import { sharePermissions } from "./perms.js";
import { prefs, save } from "./prefs.js";
import { t } from "./i18n.js";
import { esc, size, baseName, isDirLike } from "./format.js";
import { svg, glyph, shareGlyph, folderGlyphHTML } from "./icons.js";
import { $, toast, errorToast, openMenu, confirmBox, promptBox, copyText } from "./ui.js";
import * as transfers from "./transfers.js";
import { pickIcon } from "./iconpick.js";
import { isRemote, connId, editConnection, renameConnection, parseAddress, serverAddress, startPath } from "./conns.js";

// the volumes of USB and eSATA drives: volumeUSB1, volumeSATA1…
const REMOVABLE = /^volume(USB|SATA)\d/i;

// a moment within which the shared folders just read are not read again
const SHARES_FRESH_MS = 1500;

export const sidebarMethods = {
  applyShares(data) {
    this.shares = data.shares || [];
    this.user = data.user || this.user;
    this.volumeNames = data.volumes || {};
    this.hostname = data.hostname || "";
    this.sharesAt = Date.now();
    this.renderSidebar();
  },

  /** Reads the shared folders again (one request at a time); throws on failure. */
  fetchShares() {
    this.sharesReq ??= api
      .shares()
      .then((data) => {
        this.applyShares(data);
        return this.shares;
      })
      .finally(() => (this.sharesReq = null));
    return this.sharesReq;
  },

  /** The shared folders, for the pane at the top: those just read, else asked again. */
  async freshShares() {
    if (this.sharesAt && Date.now() - this.sharesAt < SHARES_FRESH_MS) return this.shares;
    return this.fetchShares();
  },

  async loadShares() {
    try {
      await this.fetchShares();
    } catch (e) {
      // a 401 has its banner already
      if (e.status === 403) this.adminOnly();
    }
  },

  applyConns(data) {
    this.conns = data.conns || [];
    this.connKey = data.key || null;
    this.renderSidebar();
    this.allPanes().forEach((p) => isRemote(p.path) && p.renderChrome());
  },

  async loadConns() {
    try {
      this.applyConns(await api.conns());
    } catch {}
  },

  connOf(path) {
    const id = connId(path);
    return id ? this.conns.find((c) => c.id === id) || null : null;
  },

  /** The last part of a path; a connection's root goes by its name. */
  pathName(path) {
    return isRemote(path) && path.split("/").filter(Boolean).length === 1 ? this.connName(path) : baseName(path);
  },

  connName(path) {
    return this.connOf(path)?.name || t("Connessione eliminata");
  },

  /** A path as people read it: a server's own address for a remote one. */
  displayPath(path) {
    const c = this.connOf(path);
    return c ? serverAddress(c, path, "smb") : path;
  },

  async addConnection(draft = {}) {
    const saved = await editConnection(draft, this.connKey);
    if (!saved) return null;
    await this.loadConns();
    return saved;
  },

  async editConn(conn) {
    const saved = await editConnection(conn, this.connKey);
    if (saved) await this.loadConns();
  },

  async renameConn(conn) {
    const name = await promptBox({ title: t("Rinomina connessione"), label: t("Nome nella barra laterale"), value: conn.name, ok: t("Rinomina"), validate: (v) => (!v.trim() ? t("Il nome non può essere vuoto") : null) });
    if (!name || name.trim() === conn.name) return;
    try {
      await renameConnection(conn, name.trim());
      await this.loadConns();
    } catch (e) {
      errorToast(e);
    }
  },

  async deleteConn(conn) {
    const ok = await confirmBox({ title: t("Eliminare la connessione?"), message: t("«{n}» sparisce dalla barra laterale, con la password salvata. I file sul server restano dove sono.", { n: esc(conn.name) }), ok: t("Elimina"), danger: true });
    if (!ok) return;
    try {
      await api.deleteConn(conn.id);
      await this.loadConns();
      for (const p of this.allPanes()) if (connId(p.path) === conn.id) p.go("/");
    } catch (e) {
      errorToast(e);
    }
  },

  async moveConn(from, to) {
    const ids = this.conns.map((c) => c.id);
    to = Math.max(0, Math.min(ids.length - 1, to));
    if (from === to) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    this.conns.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    this.renderSidebar();
    try {
      await api.orderConns(ids);
    } catch (e) {
      errorToast(e);
    }
  },

  connMenu(conn, x, y) {
    const i = this.conns.indexOf(conn);
    const path = startPath(conn);
    const fav = (prefs.favorites || []).some((f) => f.path === path);
    openMenu(x, y, [
      { title: conn.host },
      { label: t("Apri"), icon: "forward", action: () => this.pane.go(path) },
      { label: t("Apri in una nuova scheda"), icon: "plus", action: () => this.newTab(path) },
      this.isSplit() && { label: t("Apri nell'altro pannello"), icon: "split", action: () => this.other().go(path) },
      conn.kind === "smb" && conn.path && { label: t("Cartelle condivise del server"), icon: "server", action: () => this.pane.go("/:" + conn.id) },
      "-",
      { label: t("Rinomina…"), icon: "rename", action: () => this.renameConn(conn) },
      { label: t("Modifica…"), icon: "settings", action: () => this.editConn(conn) },
      i > 0 && { label: t("Sposta su"), icon: "up", action: () => this.moveConn(i, i - 1) },
      i < this.conns.length - 1 && { label: t("Sposta giù"), icon: "up", action: () => this.moveConn(i, i + 1) },
      "-",
      fav ? { label: t("Togli dai preferiti"), icon: "star", action: () => this.toggleFavorite(path) } : { label: t("Aggiungi ai preferiti"), icon: "star", action: () => this.toggleFavorite(path) },
      { label: t("Copia indirizzo"), icon: "link", action: () => copyText(serverAddress(conn, path, "smb")) },
      "-",
      { label: t("Elimina connessione"), icon: "trash", danger: true, action: () => this.deleteConn(conn) },
    ]);
  },

  /**
   * An address typed in the path bar: \\server\share, smb://, sftp://,
   * the NAS itself, /volume1/share… A server with no connection yet opens
   * the dialog to add one.
   */
  async goAddress(text, pane = this.pane) {
    const v = text.trim();
    if (isRemote(v)) return pane.go(v);
    const a = /^(\\\\|\/\/|smb:|cifs:|sftp:|ssh:)/i.test(v) ? parseAddress(v) : null;
    if (!a) return pane.go(v.replace(/\\/g, "/").replace(/^\/volume\d+/, ""));
    const host = a.host.toLowerCase();
    const short = (h) => h.split(".")[0];
    const nas = [location.hostname, this.hostname].filter(Boolean).map((h) => h.toLowerCase());
    if (a.kind !== "sftp" && nas.some((n) => n === host || short(n) === short(host))) return pane.go("/" + a.path);
    const conn = this.conns.find((c) => (c.host.toLowerCase() === host || short(c.host.toLowerCase()) === short(host)) && (!a.kind || c.kind === a.kind) && (!a.port || !c.port || c.port === a.port));
    if (conn) return pane.go("/:" + conn.id + (a.path ? "/" + a.path : ""));
    const saved = await this.addConnection({ kind: a.kind || "smb", host: v });
    if (saved) pane.go(startPath(saved));
  },

  renderSidebar() {
    const el = $("#sidebar");
    const cur = this.pane?.path || "/";
    const item = (path, name, gl, sub = "", extra = "", fav = null, gone = false) => {
      const active = cur === path || (path !== "/" && cur.startsWith(path + "/") && !extra.includes("nested"));
      const favAttrs = fav === null ? "" : ` data-fav="${fav}" draggable="true"`;
      return `<button class="side-item ${active ? "active" : ""} ${gone ? "gone" : ""}" data-path="${esc(path)}"${favAttrs}><i class="gi">${gl}</i><span class="si-text"><span class="si-name">${esc(name)}</span>${sub}</span>${extra.replace("nested", "")}</button>`;
    };
    let html = "";
    const favs = prefs.favorites || [];
    if (prefs.showFavorites) {
      html += `<div class="side-title fav-title">${t("Preferiti")}</div>`;
      // a favourite on a shared folder that is gone (a USB drive unplugged)
      const there = new Set(this.shares.map((s) => s.name));
      const gone = (f) => (isRemote(f.path) ? !this.connOf(f.path) : this.shares.length && !there.has(f.path.split("/")[1]));
      if (favs.length) html += favs.map((f, i) => item(f.path, f.name || baseName(f.path), f.path.split("/").length === 2 && isRemote(f.path) ? svg("server") : folderGlyphHTML(f.path, baseName(f.path), glyph({ kind: "d", name: baseName(f.path) })), gone(f) ? `<span class="si-sub">${t("non disponibile")}</span>` : "", "nested" + (gone(f) ? "" : this.ejectButton(f.path)), i, gone(f))).join("");
      else html += `<div class="hint" style="padding:2px 10px 6px">${t("Ctrl+D aggiunge la cartella aperta")}</div>`;
    }
    const volumes = new Map();
    for (const s of this.shares) {
      const v = s.home ? "home" : s.volume;
      if (!volumes.has(v)) volumes.set(v, []);
      volumes.get(v).push(s);
    }
    for (const vol of this.volumeOrder([...volumes.keys()])) {
      const list = volumes.get(vol);
      const first = list[0];
      const used = first.total ? 1 - first.free / first.total : 0;
      const plain = vol === "home" ? t("Personale") : vol.replace("volume", t("Volume") + " ").replace("USB", "USB ");
      // the name given in Storage Manager, with the plain one as the tooltip
      const named = prefs.volumeNames ? this.volumeNames?.[vol] : null;
      const title = named || plain;
      html += `<div class="side-title vol-title" data-vol="${esc(vol)}" draggable="true"${named ? ` title="${esc(plain)}"` : ""}><span>${esc(title)}</span>${first.total && vol !== "home" ? `<span title="${t("{f} liberi di {t}", { f: size(first.free), t: size(first.total) })}">${size(first.free)}</span>` : ""}</div>`;
      if (first.total && vol !== "home") html += `<div class="vol-bar ${used > 0.95 ? "full" : used > 0.85 ? "high" : ""}" style="margin:0 10px 6px"><div style="width:${(used * 100).toFixed(1)}%"></div></div>`;
      for (const s of list) {
        const badges = (s.encrypted ? `<span class="si-badge" title="${t("Cartella crittografata")}">🔒</span>` : "") + (s.hidden ? `<span class="si-badge" title="${t("Nascosta in Rete")}">${t("nasc.")}</span>` : "") + this.ejectButton("/" + s.name);
        html += item("/" + s.name, s.home ? t("Home ({u})", { u: this.user }) : s.name, folderGlyphHTML("/" + s.name, s.name, s.home ? shareGlyph("home") : shareGlyph(s.name)), s.comment ? `<span class="si-sub">${esc(s.comment)}</span>` : "", badges);
      }
    }
    html += `<div class="side-title conn-title"><span>${t("Connessioni")}</span><button class="side-add" title="${t("Nuova connessione")}">${svg("plus")}</button></div>`;
    if (this.conns.length) {
      html += this.conns
        .map((c, i) => {
          const path = startPath(c);
          const active = connId(cur) === c.id;
          return `<button class="side-item ${active ? "active" : ""}" data-path="${esc(path)}" data-conn="${i}" draggable="true"><i class="gi">${svg("server")}</i><span class="si-text"><span class="si-name">${esc(c.name)}</span><span class="si-sub">${esc((c.kind === "sftp" ? "SFTP · " : "") + c.host)}</span></span></button>`;
        })
        .join("");
    } else html += `<div class="hint" style="padding:2px 10px 6px">${t("Server SMB o SFTP: \\\\server nel percorso, o il +")}</div>`;
    el.innerHTML = html;
    el.querySelector(".side-add").onclick = async () => {
      const saved = await this.addConnection();
      if (saved) this.pane.go(startPath(saved));
    };
    this.bindConnDrag(el);
    el.querySelectorAll(".si-eject").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        this.eject(b.dataset.share);
      };
    });
    el.querySelectorAll(".side-item").forEach((b) => {
      b.onclick = () => this.pane.go(b.dataset.path);
      b.onauxclick = (e) => e.button === 1 && this.newTab(b.dataset.path, false);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        if (b.dataset.conn !== undefined) return this.connMenu(this.conns[+b.dataset.conn], e.clientX, e.clientY);
        this.sideMenu(b.dataset.path, e.clientX, e.clientY, b.dataset.fav === undefined ? null : +b.dataset.fav);
      };
      this.makeDropTarget(b, () => b.dataset.path);
    });
    this.bindFavoriteDrag(el);
    this.bindVolumeDrag(el);
  },

  /**
   * The groups of the sidebar: the order chosen (dragging a title,
   * or its menu), the others after it in the natural one: personal home,
   * volume1, volume2…, then USB and the rest.
   */
  volumeOrder(vols) {
    const rank = (v) => {
      if (v === "home") return [0, 0];
      const m = v.match(/^volume(\d+)$/);
      if (m) return [1, +m[1]];
      const u = v.match(/^volumeUSB(\d+)$/);
      if (u) return [2, +u[1]];
      return [3, 0];
    };
    const natural = [...vols].sort((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0] - y[0] || x[1] - y[1] || a.localeCompare(b);
    });
    const saved = (prefs.volumeOrder || []).filter((v) => vols.includes(v));
    return [...saved, ...natural.filter((v) => !saved.includes(v))];
  },

  moveVolume(vol, to) {
    const order = this.volumeOrder([...new Set(this.shares.map((s) => (s.home ? "home" : s.volume)))]);
    const from = order.indexOf(vol);
    if (from < 0) return;
    to = Math.max(0, Math.min(order.length - 1, to));
    if (from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, vol);
    save({ volumeOrder: order });
  },

  /**
   * Items of the sidebar that reorder by dragging (favourites, connections,
   * volume groups): a line shows where the item lands, `move(from, to)`
   * gets the indexes in `items`.
   */
  bindReorder(items, type, move) {
    const clear = () => items.forEach((x) => x.classList.remove("fav-before", "fav-after"));
    items.forEach((b, i) => {
      b.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData(type, String(i));
        e.dataTransfer.effectAllowed = "move";
      });
      b.addEventListener("dragover", (e) => {
        if (!e.dataTransfer.types.includes(type)) return;
        e.preventDefault();
        e.stopPropagation();
        const r = b.getBoundingClientRect();
        clear();
        b.classList.add(e.clientY < r.top + r.height / 2 ? "fav-before" : "fav-after");
      });
      b.addEventListener("dragleave", () => b.classList.remove("fav-before", "fav-after"));
      b.addEventListener("drop", (e) => {
        if (!e.dataTransfer.types.includes(type)) return;
        e.preventDefault();
        e.stopPropagation();
        const after = b.classList.contains("fav-after");
        clear();
        const from = +e.dataTransfer.getData(type);
        let to = i + (after ? 1 : 0);
        if (from < to) to--;
        move(from, to);
      });
      b.addEventListener("dragend", clear);
    });
  },

  bindVolumeDrag(el) {
    const titles = [...el.querySelectorAll(".vol-title")];
    this.bindReorder(titles, "application/x-synofile-vol", (from, to) => titles[from] && this.moveVolume(titles[from].dataset.vol, to));
    titles.forEach((b, i) => {
      b.oncontextmenu = (e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          i > 0 && { label: t("Sposta su"), icon: "up", action: () => this.moveVolume(b.dataset.vol, i - 1) },
          i < titles.length - 1 && { label: t("Sposta giù"), icon: "up", action: () => this.moveVolume(b.dataset.vol, i + 1) },
          (prefs.volumeOrder || []).length > 0 && "-",
          (prefs.volumeOrder || []).length > 0 && { label: t("Ordine predefinito"), icon: "refresh", action: () => save({ volumeOrder: [] }) },
          ...(() => {
            const share = this.shares.find((s) => s.volume === b.dataset.vol && REMOVABLE.test(s.volume));
            return share ? ["-", { label: t("Espelli"), icon: "eject", action: () => this.eject(share.name) }] : [];
          })(),
        ]);
      };
    });
  },

  /** Connections reorder by dragging, like the favourites. */
  bindConnDrag(el) {
    this.bindReorder([...el.querySelectorAll("[data-conn]")], "application/x-synofile-conn", (from, to) => this.moveConn(from, to));
  },

  /** Favourites reorder by dragging; a folder dropped on their title becomes one. */
  bindFavoriteDrag(el) {
    this.bindReorder([...el.querySelectorAll("[data-fav]")], "application/x-synofile-fav", (from, to) => this.moveFavorite(from, to));
    const title = el.querySelector(".fav-title");
    if (!title) return;
    title.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes("application/x-synofile")) return;
      e.preventDefault();
      title.classList.add("drop");
    });
    title.addEventListener("dragleave", () => title.classList.remove("drop"));
    title.addEventListener("drop", (e) => {
      title.classList.remove("drop");
      const raw = e.dataTransfer.getData("application/x-synofile");
      if (!raw) return;
      e.preventDefault();
      const known = new Set((prefs.favorites || []).map((f) => f.path));
      const dirs = JSON.parse(raw).paths.filter((p) => !known.has(p) && this.allPanes().some((pane) => pane.visible.some((x) => x.path === p && isDirLike(x))));
      if (dirs.length) save({ favorites: [...(prefs.favorites || []), ...dirs.map((p) => ({ path: p, name: baseName(p) }))] });
    });
  },

  moveFavorite(from, to) {
    const favs = [...(prefs.favorites || [])];
    if (from < 0 || from >= favs.length) return;
    to = Math.max(0, Math.min(favs.length - 1, to));
    if (from === to) return;
    const [moved] = favs.splice(from, 1);
    favs.splice(to, 0, moved);
    save({ favorites: favs });
  },

  sideMenu(path, x, y, favIndex = null) {
    const fav = (prefs.favorites || []).some((f) => f.path === path);
    const share = this.shares.find((s) => "/" + s.name === path);
    const last = (prefs.favorites || []).length - 1;
    openMenu(x, y, [
      favIndex !== null && favIndex > 0 && { label: t("Sposta su"), icon: "up", action: () => this.moveFavorite(favIndex, favIndex - 1) },
      favIndex !== null && favIndex < last && { label: t("Sposta giù"), icon: "up", action: () => this.moveFavorite(favIndex, favIndex + 1) },
      favIndex !== null && (favIndex > 0 || favIndex < last) && "-",
      { label: t("Apri"), icon: "forward", action: () => this.pane.go(path) },
      { label: t("Apri in una nuova scheda"), icon: "plus", action: () => this.newTab(path) },
      this.isSplit() && { label: t("Apri nell'altro pannello"), icon: "split", action: () => this.other().go(path) },
      share?.recycle && { label: t("Apri il Cestino"), icon: "trash", action: () => this.pane.go(path + "/#recycle") },
      !isRemote(path) && { label: t("Analisi spazio"), icon: "pie", action: () => this.analyseSpace(path) },
      "-",
      fav ? { label: t("Togli dai preferiti"), icon: "star", action: () => this.toggleFavorite(path) } : { label: t("Aggiungi ai preferiti"), icon: "star", action: () => this.toggleFavorite(path) },
      { label: t("Copia percorso"), icon: "link", action: () => copyText(this.displayPath(path)) },
      !isRemote(path) && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(path) },
      !(isRemote(path) && path.split("/").length === 2) && { label: t("Icona…"), icon: "palette", action: () => pickIcon({ x, y }, path) },
      share && !share.home && share.volume && !this.removableShare(path) && { label: t("Descrizione…"), icon: "rename", action: () => this.shareDescription(share) },
      share && !share.home && share.volume && !this.removableShare(path) && { label: t("Permessi…"), icon: "shield", action: () => sharePermissions(share) },
      this.removableShare(path) && "-",
      this.removableShare(path) && { label: t("Espelli"), icon: "eject", action: () => this.eject(this.removableShare(path).name) },
    ]);
  },

  /** The description of a shared folder, as in DSM's Control Panel; empty takes it away. */
  async shareDescription(share) {
    const desc = await promptBox({ title: t("Descrizione di «{x}»", { x: share.name }), label: t("Descrizione (vuota per toglierla)"), value: share.comment || "", ok: t("Salva") });
    if (desc === null || desc.trim() === (share.comment || "")) return;
    try {
      await dsm("SYNO.Core.Share", "set", {
        name: JSON.stringify(share.name),
        shareinfo: JSON.stringify({ name: share.name, vol_path: "/" + share.volume, desc: desc.trim() }),
      });
      // shown at once: DSM's own list catches up a moment later
      share.comment = desc.trim();
      this.renderSidebar();
      this.loadShares();
    } catch (e) {
      errorToast(new Error(t("Descrizione non salvata: {e}", { e: e.message })));
    }
  },

  /** The shared folder on a USB or eSATA drive that holds `path`, if any. */
  removableShare(path) {
    if (!path || isRemote(path)) return null;
    const name = path.split("/")[1];
    return this.shares.find((s) => s.name === name && REMOVABLE.test(s.volume)) || null;
  },

  ejectButton(path) {
    const share = this.removableShare(path);
    return share ? `<span class="si-eject" role="button" data-share="${esc(share.name)}" title="${t("Espelli")}">${svg("eject")}</span>` : "";
  },

  /** Ejects the drive of a shared folder the way DSM's External Devices does. */
  async eject(shareName) {
    let found = null;
    try {
      for (const [apiName, types] of [["SYNO.Core.ExternalDevice.Storage.USB", /^(usbDisk|sdCard)$/], ["SYNO.Core.ExternalDevice.Storage.eSATA", /^eSataDisk$/]]) {
        const data = await dsm(apiName, "list", { additional: ["dev_type", "product", "status", "partitions"] }).catch(() => null);
        const dev = (data?.devices || []).find((d) => types.test(d.dev_type) && (d.partitions || []).some((p) => p.share_name === shareName));
        if (dev) found = { apiName, dev };
        if (found) break;
      }
    } catch {}
    if (!found) return toast(t("Il dispositivo di «{s}» non risulta collegato", { s: shareName }), { kind: "error" });
    const { apiName, dev } = found;
    const names = (dev.partitions || []).map((p) => p.share_name).filter(Boolean);
    const inUse = (p) => names.some((n) => p === "/" + n || p?.startsWith("/" + n + "/"));
    if (transfers.all().some((j) => !transfers.finished(j) && [...(j.info.sources || []), j.info.dest].some(inUse))) {
      return toast(t("Ci sono trasferimenti in corso su «{s}»: aspetta che finiscano o annullali", { s: shareName }), { kind: "error" });
    }
    const title = dev.dev_title || dev.product || shareName;
    const ok = await confirmBox({
      title: t("Espellere «{d}»?", { d: title }),
      message: t("Le cartelle condivise del dispositivo non saranno disponibili finché non lo ricolleghi."),
      items: names.map((n) => `<i class="gi">${shareGlyph(n)}</i>${esc(n)}`),
      ok: t("Espelli"),
      icon: "eject",
    });
    if (!ok) return;
    try {
      await dsm(apiName, "eject", { dev_id: dev.dev_id });
    } catch (e) {
      return toast(t("DSM non riesce a espellere «{d}» ({e}): forse è ancora in uso", { d: title, e: e.message }), { kind: "error", timeout: 9000 });
    }
    toast(t("«{d}» espulso: si può scollegare", { d: title }), { kind: "ok" });
    for (const p of this.allPanes()) if (inUse(p.path)) p.go("/");
    await this.loadShares();
  },

  toggleFavorite(path = this.pane.path) {
    if (path === "/") return;
    let favs = [...(prefs.favorites || [])];
    if (favs.some((f) => f.path === path)) {
      favs = favs.filter((f) => f.path !== path);
      toast(t("Tolta dai preferiti"), { timeout: 1500 });
    } else {
      favs.push({ path, name: this.pathName(path) });
      toast(t("Aggiunta ai preferiti"), { kind: "ok", timeout: 1500 });
    }
    save({ favorites: favs });
  },
};
