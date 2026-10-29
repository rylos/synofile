// Archives opened like folders (zip, 7z, rar, tar and compressed tar): the
// NAS lists them and streams single files out; they are read-only, and
// copying out of one is an extraction of those items.

import { t } from "./i18n.js";
import { toast } from "./ui.js";

const BROWSABLE = /\.(zip|7z|rar|jar|iso|cab|tar|tgz|tbz2?|txz|tar\.(gz|bz2|xz|zst))$/i;

export const isBrowsable = (entry) => entry.kind === "f" && BROWSABLE.test(entry.name);

// The archives opened so far, by their path: what is under them is inside.
const roots = new Set();

export function rememberArchive(root) {
  roots.add(root);
}

/** The archive `path` is inside, with the path within it; null outside. */
export function archiveOf(path) {
  for (const root of roots) {
    if (path === root) return { root, inner: "" };
    if (path.startsWith(root + "/")) return { root, inner: path.slice(root.length + 1) };
  }
  return null;
}

export function readOnlyToast() {
  toast(t("Gli archivi si aprono in sola lettura: per cambiarli, estraili"), { kind: "error" });
}
