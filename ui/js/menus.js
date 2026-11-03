// The context menu of the panes and the menus of their toolbar.
// Methods of App (main.js).

import { sharePermissions } from "./perms.js";
import { prefs, save } from "./prefs.js";
import { t, count } from "./i18n.js";
import { int, parentOf, isDirLike } from "./format.js";
import { isArchive, archiveStem } from "./icons.js";
import { isBrowsable } from "./archive.js";
import { openMenu, copyText } from "./ui.js";
import { openSettings } from "./settings.js";
import { isRemote } from "./conns.js";

export const menuMethods = {
  contextMenu(pane, entry, x, y) {
    const list = pane.targets();
    const many = list.length > 1;
    const atRoot = pane.path === "/";
    const canPaste = this.clipboard && !atRoot;
    const remote = isRemote(pane.path);
    if (!entry) {
      const atRootOrRo = atRoot || !!pane.archive;
      return openMenu(x, y, [
        !atRootOrRo && { label: t("Nuova cartella"), icon: "folderPlus", key: "Ctrl+Shift+N", action: () => this.newFolder(pane) },
        !atRootOrRo && { label: t("Carica file…"), icon: "upload", key: "Ctrl+U", action: () => this.pickUpload("files", pane) },
        !atRootOrRo && { label: t("Carica cartella…"), icon: "upload", action: () => this.pickUpload("folder", pane) },
        canPaste && !pane.archive && "-",
        canPaste && !pane.archive && { label: t(this.clipboard.op === "cut" ? "Incolla (sposta {n})" : "Incolla ({n})", { n: this.clipboard.paths.length }), icon: "paste", key: "Ctrl+V", action: () => this.paste(pane) },
        "-",
        { label: t("Seleziona tutto"), key: "Ctrl+A", action: () => pane.selectAll() },
        { label: prefs.showHidden ? t("Nascondi i file nascosti") : t("Mostra i file nascosti"), icon: prefs.showHidden ? "eyeOff" : "eye", key: "Ctrl+H", action: () => this.toggleHidden() },
        { label: t("Calcola dimensione delle cartelle"), icon: "drive", action: () => this.computeSizes(pane, pane.visible) },
      pane.path !== "/" && !pane.archive && !remote && { label: t("Analisi spazio"), icon: "pie", action: () => this.analyseSpace(pane.path) },
        "-",
        !atRoot && { label: t("Copia percorso della cartella"), icon: "link", action: () => copyText(this.displayPath(pane.path)) },
        !atRoot && { label: t("Aggiungi ai preferiti"), icon: "star", key: "Ctrl+D", action: () => this.toggleFavorite(pane.path) },
        !atRootOrRo && !remote && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(pane.path) },
        { label: t("Aggiorna"), icon: "refresh", key: "F5", action: () => pane.reload() },
      ]);
    }
    const dir = isDirLike(entry);
    const share = !!entry.share;
    const shareObj = share ? this.shares.find((s) => "/" + s.name === entry.path) : null;
    const other = this.other();
    // inside an archive: read-only, and folders come out by copying
    const ro = !!pane.archive;
    const enter = !many && !ro && isBrowsable(entry);
    openMenu(x, y, [
      many ? { title: count(list.length, "elemento selezionato", "elementi selezionati", int) } : null,
      !many && { label: dir || enter ? t("Apri") : t("Anteprima"), icon: dir || enter ? "forward" : "eye", key: dir || enter ? "Invio" : "Spazio", action: () => this.open(pane, entry) },
      enter && { label: t("Apri in una nuova scheda"), icon: "plus", action: () => this.newTab(entry.path) },
      !many && dir && { label: t("Apri in una nuova scheda"), icon: "plus", key: "Ctrl+Invio", action: () => this.newTab(entry.path) },
      !many && dir && other && { label: t("Apri nell'altro pannello"), icon: "split", action: () => other.go(entry.path) },
      !many && this.editable(pane, entry) && { label: t("Modifica"), icon: "rename", key: "F4", action: () => this.edit(pane, entry) },
      (!ro || (!many && !dir)) && { label: many || dir ? t("Scarica (.zip)") : t("Scarica"), icon: "download", action: () => this.download(list) },
      !many && !ro && !remote && isArchive(entry) && "-",
      !many && !ro && !remote && isArchive(entry) && { label: t("Estrai in «{x}»", { x: archiveStem(entry.name) }), icon: "archive", action: () => this.extract(pane, entry, "folder") },
      !many && !ro && !remote && isArchive(entry) && { label: t("Estrai qui"), icon: "archive", action: () => this.extract(pane, entry, "here") },
      !many && !ro && !remote && isArchive(entry) && { label: t("Estrai in…"), icon: "archive", action: () => this.extract(pane, entry, "pick") },
      !share && !ro && !remote && { label: t("Comprimi in .zip…"), icon: "archive", action: () => this.compress(pane) },
      "-",
      !share && { label: t("Copia"), icon: "copy", key: "Ctrl+C", action: () => this.setClipboard("copy", pane) },
      !share && !ro && { label: t("Taglia"), icon: "cut", key: "Ctrl+X", action: () => this.setClipboard("cut", pane) },
      dir && canPaste && !many && !ro && { label: t("Incolla dentro"), icon: "paste", action: () => this.paste(pane, entry.path) },
      !share && { label: t("Copia in…"), icon: "copy", key: other ? "F5" : "", action: () => (other ? this.toOtherPane("copy") : this.copyTo(pane, "copy")) },
      !share && !ro && { label: t("Sposta in…"), icon: "move", key: other ? "F6" : "", action: () => (other ? this.toOtherPane("move") : this.copyTo(pane, "move")) },
      !share && other && { label: t("Scegli cartella…"), icon: "move", action: () => this.copyTo(pane, "copy") },
      "-",
      !many && !share && !ro && { label: t("Rinomina"), icon: "rename", key: "F2", action: () => this.renamePrompt(pane, entry) },
      !share && !ro && { label: pane.recycle && !pane.path.includes("#recycle") ? t("Sposta nel Cestino") : t("Elimina"), icon: "trash", key: "Canc", danger: true, action: () => this.remove(pane) },
      !share && !ro && pane.recycle && { label: t("Elimina definitivamente"), icon: "trash", key: "Shift+Canc", danger: true, action: () => this.remove(pane, true) },
      "-",
      dir && { label: t("Calcola dimensione"), icon: "drive", action: () => this.computeSizes(pane, list) },
      !many && dir && !ro && !remote && { label: t("Analisi spazio"), icon: "pie", action: () => this.analyseSpace(entry.path) },
      !remote && { label: t("Copia percorso"), icon: "link", key: "Ctrl+Shift+C", action: () => this.copyPaths(list, "nas") },
      !remote && { label: t("Copia percorso di rete (\\\\NAS)"), icon: "link", action: () => this.copyPaths(list, "smb") },
      remote && { label: t("Copia indirizzo"), icon: "link", key: "Ctrl+Shift+C", action: () => this.copyPaths(list, "smb") },
      (!remote || this.connOf(pane.path)?.kind === "smb") && { label: t("Copia indirizzo smb://"), icon: "link", action: () => this.copyPaths(list, "url") },
      !many && dir && { label: t("Aggiungi ai preferiti"), icon: "star", action: () => this.toggleFavorite(entry.path) },
      !many && !ro && !remote && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(dir ? entry.path : parentOf(entry.path)) },
      { label: t("Proprietà"), icon: "info", key: "Ctrl+I", action: () => !prefs.info && this.toggleInfo() },
      !many && shareObj && !shareObj.home && shareObj.volume && !this.removableShare(entry.path) && { label: t("Permessi…"), icon: "shield", action: () => sharePermissions(shareObj) },
      !many && share && this.removableShare(entry.path) && "-",
      !many && share && this.removableShare(entry.path) && { label: t("Espelli"), icon: "eject", action: () => this.eject(entry.name) },
    ]);
  },

  newMenu(pane, anchor) {
    const r = anchor.getBoundingClientRect();
    const disabled = pane.path === "/" || !!pane.archive;
    openMenu(r.left, r.bottom + 4, [
      { label: t("Nuova cartella"), icon: "folderPlus", key: "Ctrl+Shift+N", disabled, action: () => this.newFolder(pane) },
      { label: t("Carica file…"), icon: "upload", key: "Ctrl+U", disabled, action: () => this.pickUpload("files", pane) },
      { label: t("Carica cartella…"), icon: "upload", disabled, action: () => this.pickUpload("folder", pane) },
      "-",
      { label: t("Nuova scheda"), icon: "plus", key: "Ctrl+T", action: () => this.newTab(this.newTabPath()) },
    ]);
  },

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
      pane.path !== "/" && !pane.archive && !isRemote(pane.path) && { label: t("Analisi spazio"), icon: "pie", action: () => this.analyseSpace(pane.path) },
      pane.path !== "/" && { label: fav ? t("Togli dai preferiti") : t("Aggiungi ai preferiti"), icon: "star", key: "Ctrl+D", action: () => this.toggleFavorite(pane.path) },
      pane.path !== "/" && !isRemote(pane.path) && { label: t("Apri in File Station"), icon: "external", action: () => this.fileStation(pane.path) },
      "-",
      { label: t("Scorciatoie da tastiera"), icon: "keyboard", key: "?", action: () => openSettings("keys") },
      { label: t("Impostazioni"), icon: "settings", key: "Ctrl+,", action: () => openSettings() },
    ]);
  },

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
  },
};
