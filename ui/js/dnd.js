// Drag and drop: items of the page moved or copied onto folders, files
// from the computer uploaded. Methods of App (main.js).

import { t } from "./i18n.js";
import { baseName } from "./format.js";
import { archiveOf, readOnlyToast } from "./archive.js";
import { $, openMenu } from "./ui.js";
import { upload, fromDataTransfer } from "./uploads.js";

const shareOf = (path) => path.split("/").filter(Boolean)[0] || "";

export const dndMethods = {
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
        if (archiveOf(d)) return readOnlyToast();
        const items = await fromDataTransfer(ev.dataTransfer);
        upload(d, items, () => this.refreshFolders([d]));
      }
    });
  },

  /** Like Windows: within one shared folder a drop moves, across shares it copies; Ctrl copies, Shift moves, Alt asks. */
  dropOp(ev, dest, paths) {
    if (ev.altKey) return "ask";
    if (ev.ctrlKey) return "copy";
    if (ev.shiftKey) return "move";
    const from = paths ? shareOf(paths[0]) : null;
    return from && from !== shareOf(dest) ? "copy" : "move";
  },

  dropMenu(ev, paths, dest) {
    openMenu(ev.clientX, ev.clientY, [
      { title: baseName(dest) },
      { label: t("Copia qui"), icon: "copy", action: () => this.transfer("copy", paths, dest) },
      { label: t("Sposta qui"), icon: "move", action: () => this.transfer("move", paths, dest) },
      "-",
      { label: t("Annulla"), icon: "close" },
    ]);
  },

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
  },
};
