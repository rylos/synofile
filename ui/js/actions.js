// What is done to files: opening, previews, editing, downloads, archives,
// clipboard, transfers, delete, rename, new folders, sizes and uploads.
// Methods of App (main.js).

import { api } from "./api.js";
import { prefs } from "./prefs.js";
import { t, count } from "./i18n.js";
import { esc, int, baseName, parentOf, joinPath, isDirLike } from "./format.js";
import { svg, glyph, previewKind, archiveStem, isDsmFolder } from "./icons.js";
import { isBrowsable, archiveOf, readOnlyToast } from "./archive.js";
import { $, toast, errorToast, confirmBox, promptBox, pickFolder, copyText, dialog } from "./ui.js";
import * as transfers from "./transfers.js";
import { upload, fromInput } from "./uploads.js";
import { quickLook } from "./preview.js";
import { spaceAnalysis } from "./space.js";
import { moveFolderIcons } from "./iconpick.js";
import { serverAddress } from "./conns.js";

export const actionMethods = {
  /** A text file the editor opens: not in an archive, 8 MB at most. */
  editable(pane, entry) {
    return !pane.archive && entry.kind === "f" && entry.size <= 8 * 1024 * 1024 && previewKind(entry) === "text";
  },

  async edit(pane, entry) {
    const { editFile } = await import("./editor.js");
    const saved = await editFile(entry.path, { label: this.displayPath(entry.path) });
    pane.focus();
    if (saved) this.refreshFolders([parentOf(entry.path)]);
  },

  analyseSpace(path) {
    spaceAnalysis(path, (p) => this.pane.go(p));
  },

  open(pane, entry) {
    if (!entry) return;
    if (isDirLike(entry) || (isBrowsable(entry) && !pane.archive)) return pane.go(entry.path);
    if (previewKind(entry) !== "other") return this.quickLook(pane);
    this.download([entry]);
  },

  quickLook(pane = this.pane) {
    const e = pane.visible[pane.cursor];
    if (!e) return;
    if (isDirLike(e)) return pane.go(e.path);
    quickLook(pane, (list) => this.download(list));
  },

  download(entries) {
    if (!entries.length) return;
    // out of an archive only single files: the rest is extracted
    if (archiveOf(entries[0].path) && (entries.length > 1 || isDirLike(entries[0]))) return toast(t("Dentro un archivio si scaricano solo file singoli: per il resto usa «Copia in…»"), { kind: "error" });
    const a = document.createElement("a");
    a.href = api.download(entries.map((e) => e.path));
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
    if (entries.length > 1 || isDirLike(entries[0])) toast(t("Download come archivio .zip avviato"), { timeout: 2500 });
  },

  compress(pane) {
    if (pane.archive) return readOnlyToast();
    const list = pane.targets().filter((e) => !e.share);
    if (!list.length || pane.path === "/") return;
    const base = list.length === 1 ? (isDirLike(list[0]) ? list[0].name : archiveStem(list[0].name)) : baseName(pane.path) || t("Archivio");
    const dlg = dialog(`<form method="dialog">
      <div class="dlg-head"><div class="dlg-icon">${svg("archive")}</div><h2>${t("Comprimi in .zip")}</h2></div>
      <div class="dlg-body">
        <p>${t("{n} in un archivio zip, nella stessa cartella.", { n: count(list.length, "elemento", "elementi", int) })}</p>
        <label class="field"><span>${t("Nome dell'archivio")}</span><input type="text" class="nm" value="${esc(base)}.zip" spellcheck="false"></label><div class="hint err"></div>
        <label class="field"><span>${t("Compressione")}</span><select class="lv">
          <option value="normal">${t("Normale")}</option><option value="fast">${t("Veloce")}</option><option value="store">${t("Nessuna (solo archivio, il più veloce)")}</option></select></label>
        <p class="hint">${t("Foto, video, musica e archivi vengono solo archiviati: comprimerli di nuovo non fa risparmiare spazio.")}</p>
      </div>
      <div class="dlg-foot"><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${t("Comprimi")}</button></div></form>`);
    const input = dlg.querySelector(".nm");
    input.focus();
    input.setSelectionRange(0, input.value.length - 4);
    dlg.querySelector(".cancel").onclick = () => dlg.close();
    const err = dlg.querySelector(".err");
    input.oninput = () => (err.textContent = "");
    dlg.querySelector("form").onsubmit = (e) => {
      const name = input.value.trim();
      if (!name || name.includes("/") || name === "." || name === "..") {
        e.preventDefault();
        err.textContent = t("Nome non valido");
        err.style.color = "var(--crit)";
        input.focus();
        return;
      }
      transfers.start({ op: "compress", sources: list.map((e) => e.path), dest: pane.path, name, level: dlg.querySelector(".lv").value });
    };
  },

  async extract(pane, entry, mode) {
    let dest = parentOf(entry.path);
    if (mode === "pick") {
      dest = await pickFolder({ title: t("Estrai «{x}» in…", { x: entry.name }), start: this.other()?.path || dest, ok: t("Estrai qui") });
      if (!dest) return;
    }
    transfers.start({ op: "extract", sources: [entry.path], dest, into_folder: mode !== "here", conflict: mode === "here" ? (prefs.conflict === "ask" ? "rename" : prefs.conflict) : "rename" });
  },

  fileStation(path) {
    try {
      // inside DSM's window, or a window opened from it
      const desk = window.parent !== window ? window.parent : window.opener?.parent;
      const sds = desk && desk.SYNO && desk.SYNO.SDS;
      if (sds && sds.AppLaunch) return sds.AppLaunch("SYNO.SDS.App.FileStation3.Instance", { openfile: path.endsWith("/") ? path : path + "/" });
    } catch {}
    toast(t("File Station si apre solo dalla finestra di DSM"), { kind: "error" });
  },

  copyPaths(entries, style) {
    const host = location.hostname;
    const fmt = (p) => {
      const c = this.connOf(p);
      if (c) return serverAddress(c, p, style);
      return style === "smb" ? `\\\\${host}${p.replace(/\//g, "\\")}` : style === "url" ? `smb://${host}/${p.split("/").filter(Boolean).map(encodeURIComponent).join("/")}` : p;
    };
    copyText(entries.map((e) => fmt(e.path || e)).join("\n"));
  },

  cutPaths() {
    return this.clipboard?.op === "cut" ? new Set(this.clipboard.paths) : new Set();
  },

  setClipboard(op, pane) {
    if (op === "cut" && pane.archive) return readOnlyToast();
    // snapshots stay where they are: cutting one copies nothing away
    const list = pane.targets().filter((e) => !e.share && !(op === "cut" && (e.readonly || isDsmFolder(e) || pane.writable === false)));
    if (!list.length) return;
    this.clipboard = { op, paths: list.map((e) => e.path), from: pane.path };
    toast(t(op === "cut" ? "{n} pronti da spostare: incolla con Ctrl+V" : "{n} pronti da copiare: incolla con Ctrl+V", { n: count(list.length, "elemento", "elementi", int) }), { timeout: 2200 });
    this.allPanes().forEach((p) => p.paint());
    pane.renderStatus();
  },

  paste(pane = this.pane, dest = pane.path) {
    const cb = this.clipboard;
    if (!cb || dest === "/") return;
    if (cb.op === "cut" && cb.from === dest) return toast(t("Gli elementi sono già in questa cartella"));
    this.transfer(cb.op === "cut" ? "move" : "copy", cb.paths, dest);
    if (cb.op === "cut") this.clipboard = null;
    this.allPanes().forEach((p) => p.paint());
  },

  transfer(op, paths, dest) {
    if (!paths.length || !dest || dest === "/") return;
    if (archiveOf(dest)) return readOnlyToast();
    const from = archiveOf(paths[0]);
    if (from) {
      // out of an archive: those items are extracted, never moved
      if (paths.some((p) => archiveOf(p)?.root !== from.root)) return;
      return transfers.start({ op: "extract", sources: [from.root], members: paths.map((p) => archiveOf(p).inner), dest, conflict: prefs.conflict === "ask" ? "rename" : prefs.conflict });
    }
    if (paths.some((p) => dest === p || dest.startsWith(p + "/"))) return toast(t("Una cartella non può finire dentro sé stessa"), { kind: "error" });
    if (op === "move" && paths.every((p) => parentOf(p) === dest)) return;
    transfers.start({ op, sources: paths, dest });
  },

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
  },

  toOtherPane(op) {
    const other = this.other();
    if (!other) return toast(t("Apri il doppio pannello con F3"));
    const list = this.pane.targets().filter((e) => !e.share);
    if (list.length) this.transfer(op, list.map((e) => e.path), other.path);
  },

  async remove(pane, permanent = false) {
    if (pane.archive) return readOnlyToast();
    // a recycle bin is emptied, not thrown away (Canc on it does nothing)
    const list = pane.targets().filter((e) => !e.share && e.full === undefined && !e.readonly && !isDsmFolder(e));
    if (!list.length || pane.writable === false) return;
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
  },

  /** Empties a shared folder's recycle bin for good, after asking. */
  async emptyBin(bin) {
    let entries;
    try {
      entries = (await api.list(bin)).entries;
    } catch (err) {
      return errorToast(err);
    }
    if (!entries.length) return toast(t("Il Cestino è già vuoto"));
    const ok = await confirmBox({
      title: t("Svuotare il Cestino?"),
      message: `<b style="color:var(--crit)">${t("{n} verranno eliminati per sempre: non si possono recuperare.", { n: count(entries.length, "elemento", "elementi", int) })}</b>`,
      ok: t("Svuota il Cestino"),
      danger: true,
      icon: "trash",
    });
    if (ok) transfers.start({ op: "delete", sources: entries.map((e) => joinPath(bin, e.name)), permanent: true });
  },

  async renamePrompt(pane, e) {
    if (pane.archive) return readOnlyToast();
    if (e.readonly || isDsmFolder(e) || pane.writable === false) return;
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
      if (isDirLike(e)) moveFolderIcons(e.path, joinPath(parentOf(e.path), name));
      await pane.reload();
      pane.selectPath(joinPath(parentOf(e.path), name));
      this.refreshFolders([pane.path]);
    } catch (err) {
      errorToast(err);
    }
  },

  async newFolder(pane = this.pane) {
    if (pane.path === "/") return;
    if (pane.archive) return readOnlyToast();
    const name = await promptBox({ title: t("Nuova cartella"), label: t("Nome"), value: t("Nuova cartella"), icon: "folderPlus", ok: t("Crea"), validate: (v) => (!v.trim() || v.includes("/") ? t("Nome non valido") : null) });
    if (!name) return;
    try {
      await api.mkdir(pane.path, name);
      await pane.reload();
      pane.selectPath(joinPath(pane.path, name));
    } catch (err) {
      errorToast(err);
    }
  },

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
  },

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
  },

  pickUpload(kind, pane = this.pane) {
    if (pane.path === "/") return toast(t("Apri prima una cartella condivisa"));
    if (pane.archive) return readOnlyToast();
    this.uploadDest = pane.path;
    $(kind === "folder" ? "#upload-folder" : "#upload-files").click();
  },
};
