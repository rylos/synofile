// Undo (Ctrl+Z): the last renames, new folders, moves and copies, newest
// first. What a deletion threw away is in DSM's Recycle Bin instead.

import { api } from "./api.js";
import { t, tn, count } from "./i18n.js";
import { int, baseName, parentOf, joinPath } from "./format.js";
import { toast, errorToast, confirmBox } from "./ui.js";
import * as transfers from "./transfers.js";
import { renameMany } from "./rename.js";

const MAX = 30;
const stack = [];
let app = null;

export function initUndo(theApp) {
  app = theApp;
}

/** The label of what Ctrl+Z would undo, or null. */
export function undoLabel() {
  return stack.length ? stack[stack.length - 1].label : null;
}

function push(step) {
  stack.push(step);
  if (stack.length > MAX) stack.shift();
}

/** `pairs`: [old path, new name] of items just renamed, all in one step. */
export function recordRename(pairs, label) {
  if (!pairs.length) return;
  const done = pairs.map(([from, name]) => [joinPath(parentOf(from), name), baseName(from)]);
  push({
    label: label || t("Rinomina «{a}» in «{b}»", { a: baseName(pairs[0][0]), b: pairs[0][1] }),
    run: async () => {
      // all back at once: swaps and shifts of names undo as they were done
      const { errors } = await renameMany(done);
      app.refreshFolders([...new Set(done.map(([p]) => parentOf(p)))]);
      if (errors.length) throw new Error(errors.join("; "));
    },
  });
}

export function recordNewFolder(path) {
  push({
    label: t("Nuova cartella «{n}»", { n: baseName(path) }),
    run: async () => {
      const { entries } = await api.list(path);
      // only an empty one goes: whatever was put in it since is not thrown away
      if (entries.length) throw new Error(t("la cartella «{n}» non è più vuota", { n: baseName(path) }));
      await transfers.start({ op: "delete", sources: [path], permanent: true });
    },
  });
}

/** A move or a copy just started as job `id`. `fresh`: the names the copy did not find in the destination. */
export function recordTransfer(id, op, sources, dest, fresh) {
  if (id == null) return;
  const moved = sources.map((p) => [p, joinPath(dest, baseName(p))]);
  const n = count(sources.length, "elemento", "elementi", int);
  push({
    label: op === "move" ? t("Sposta {n} in «{d}»", { n, d: baseName(dest) || dest }) : t("Copia {n} in «{d}»", { n, d: baseName(dest) || dest }),
    run: async () => {
      const job = transfers.all().find((j) => j.id === id);
      if (job && !["done", "failed", "cancelled"].includes(job.state)) throw new Error(t("il trasferimento è ancora in corso"));
      if (op === "move") {
        // back where each came from, one move per folder of origin
        const byParent = new Map();
        const back = moved.filter(([from]) => fresh.has(baseName(from)));
        if (!back.length) throw new Error(t("lo spostamento è finito in elementi che c'erano già: non si annulla"));
        for (const [from, now] of back) {
          const parent = parentOf(from);
          if (!byParent.has(parent)) byParent.set(parent, []);
          byParent.get(parent).push(now);
        }
        for (const [parent, list] of byParent) await transfers.start({ op: "move", sources: list, dest: parent });
        return;
      }
      // a copy: its new items go to the Recycle Bin, never those that were there before
      const copies = moved.filter(([from]) => fresh.has(baseName(from))).map(([, now]) => now);
      if (!copies.length) throw new Error(t("la copia ha sostituito elementi che c'erano già: non si annulla"));
      // a shared folder without a recycle bin would lose them for good: said so
      const bin = (await api.list(dest)).recycle;
      const n = count(copies.length, "elemento", "elementi", int);
      const ok = await confirmBox({
        title: t("Annullare la copia?"),
        message: bin
          ? tn(copies.length, "{n} copiato in «{d}» finirà nel Cestino di DSM.", "{n} copiati in «{d}» finiranno nel Cestino di DSM.", { n, d: baseName(dest) || dest })
          : `<b style="color:var(--crit)">${tn(copies.length, "{n} verrà eliminato per sempre: non si può recuperare.", "{n} verranno eliminati per sempre: non si possono recuperare.", { n })}</b><br>${t("Il Cestino di questa cartella condivisa è disattivato.")}`,
        items: copies.map(baseName),
        ok: bin ? t("Sposta nel Cestino") : t("Elimina"),
        danger: !bin,
        icon: "trash",
      });
      if (!ok) throw null;
      await transfers.start({ op: "delete", sources: copies, permanent: !bin });
    },
  });
}

/** Undoes the last step. */
export async function undo() {
  const step = stack.pop();
  if (!step) return toast(t("Niente da annullare"));
  try {
    await step.run();
    toast(t("Annullato: {s}", { s: step.label }));
  } catch (err) {
    // null: the user said no; the step can be tried again
    if (err === null) stack.push(step);
    else errorToast(err);
  }
}
