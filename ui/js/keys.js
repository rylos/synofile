// The keyboard: tabs, panes, selection and actions. Methods of App (main.js).

import { prefs, save } from "./prefs.js";
import { isDirLike } from "./format.js";
import * as transfers from "./transfers.js";
import { openSettings } from "./settings.js";
import { isRemote } from "./conns.js";

export const keyMethods = {
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
      if (ctrl && !e.shiftKey && k.toLowerCase() === "t") return run(() => this.newTab(this.newTabPath()));
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
      if (ctrl && k === "3") return run(() => pane.setView("columns"));
      if (ctrl && k.toLowerCase() === "a") return run(() => pane.selectAll());
      if (ctrl && e.shiftKey && k.toLowerCase() === "c") return run(() => this.copyPaths(pane.targets(), isRemote(pane.path) ? "smb" : "nas"));
      if (ctrl && k.toLowerCase() === "c") return run(() => this.setClipboard("copy", pane));
      if (ctrl && k.toLowerCase() === "x") return run(() => this.setClipboard("cut", pane));
      if (ctrl && e.shiftKey && k.toLowerCase() === "v") return run(() => this.paste(pane, pane.path, true));
      if (ctrl && k.toLowerCase() === "v") return run(() => this.paste(pane));
      if (ctrl && k.toLowerCase() === "d") return run(() => this.toggleFavorite(pane.path));
      if (ctrl && k.toLowerCase() === "u") return run(() => this.pickUpload("files", pane));
      if (ctrl && k.toLowerCase() === "r") return run(() => pane.reload());
      if (ctrl && e.shiftKey && k.toLowerCase() === "n") return run(() => this.newFolder(pane));
      if (ctrl && k === "Enter") return run(() => {
        const cur = pane.visible[pane.cursor];
        if (cur && isDirLike(cur)) this.newTab(cur.path, false);
      });
      if (k === "F5" && e.shiftKey) return run(() => (this.isSplit() ? this.toOtherPane("copy", true) : this.copyTo(pane, "copy", true)));
      if (k === "F6" && e.shiftKey) return run(() => (this.isSplit() ? this.toOtherPane("move", true) : this.copyTo(pane, "move", true)));
      if (k === "F5" && this.isSplit()) return run(() => this.toOtherPane("copy"));
      if (k === "F5") return run(() => pane.reload());
      if (k === "F6") return run(() => (this.isSplit() ? this.toOtherPane("move") : this.copyTo(pane, "move")));
      if (k === "F2") return run(() => pane.rename());
      if (k === "F4") return run(() => {
        const cur = pane.visible[pane.cursor];
        if (cur && this.editable(pane, cur)) this.edit(pane, cur);
      });
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
      // columns: right goes into the folder under the cursor, left back up
      if (pane.view === "columns" && !e.shiftKey && !ctrl && !e.altKey) {
        if (k === "ArrowLeft") return run(() => pane.path !== "/" && pane.goUp());
        if (k === "ArrowRight") return run(async () => {
          const cur = pane.visible[pane.cursor];
          if (!cur || !isDirLike(cur)) return;
          await pane.go(cur.path);
          pane.moveCursor(0);
        });
      }
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
  },
};
