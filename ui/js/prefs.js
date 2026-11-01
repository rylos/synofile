// Preferences: kept on the NAS per DSM user (so they follow from one
// computer to another), with a local copy for a fast first paint.

import { api } from "./api.js";
import { setBinary } from "./format.js";
import { setFolderIcons } from "./icons.js";

export const DEFAULTS = {
  theme: "dark", // dark, light, system
  icons: true,
  colors: true, // eza colours on names and icons
  llColumns: true, // eza colours on permissions, sizes and dates
  size: "normal", // small, normal, large
  density: "normal", // compact, normal
  foldersFirst: true,
  showHidden: false,
  binarySizes: true,
  relativeDates: false,
  columns: { mode: true, size: true, mtime: true, kind: false },
  singleClick: false,
  vimKeys: false,
  confirmDelete: true,
  sidebar: true,
  info: false,
  view: "list",
  sort: { key: "name", dir: 1 },
  conflict: "ask",
  verify: false,
  limit: 0,
  openDialog: true,
  notify: true,
  favorites: [],
  folderIcons: { paths: {}, names: {} }, // icons given by hand: by path, or to every folder of a name
  tabs: null,
  perFolder: false, // view and sort remembered for each folder
  folderViews: {}, // path → { view, sort }
  hiddenLast: false,
  todayHighlight: false,
  startIn: "last", // last, shares, folder
  newTabIn: "current", // current, shares, folder
  startFolder: "",
  dsmTray: true, // the icon in DSM's taskbar while transfers run
  showFavorites: true, // the Favourites section of the sidebar
  volumeNames: true, // the names given in Storage Manager, else "Volume 1"
  volumeOrder: [], // the sidebar's groups in the order chosen by dragging
};

const LOCAL = "synofile.prefs";
export const prefs = structuredClone(DEFAULTS);
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
}

function merge(saved) {
  for (const [k, v] of Object.entries(saved || {})) {
    if (k in DEFAULTS) prefs[k] = v && typeof v === "object" && !Array.isArray(v) && DEFAULTS[k] ? { ...DEFAULTS[k], ...v } : v;
  }
}

export function loadLocal() {
  try {
    merge(JSON.parse(localStorage.getItem(LOCAL) || "{}"));
  } catch {}
  apply();
}

export async function loadRemote() {
  try {
    const remote = await api.prefs();
    if (remote && Object.keys(remote).length) merge(remote);
  } catch {}
  apply();
}

let timer = 0;
export function save(patch) {
  if (patch) Object.assign(prefs, patch);
  apply();
  try {
    localStorage.setItem(LOCAL, JSON.stringify(prefs));
  } catch {}
  clearTimeout(timer);
  timer = setTimeout(() => api.savePrefs(prefs).catch(() => {}), 700);
  listeners.forEach((fn) => fn(prefs));
}

/** The look of the page follows the preferences at once. */
export function apply() {
  setFolderIcons(prefs.folderIcons);
  const root = document.documentElement;
  const theme = prefs.theme === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : prefs.theme;
  root.dataset.theme = theme;
  root.dataset.size = prefs.size;
  root.dataset.density = prefs.density;
  const app = document.getElementById("app");
  if (app) {
    app.classList.toggle("no-icons", !prefs.icons);
    app.classList.toggle("no-colors", !prefs.colors);
    app.classList.toggle("no-ll", !prefs.llColumns);
    app.classList.toggle("no-sidebar", !prefs.sidebar);
  }
  setBinary(prefs.binarySizes);
}

matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => prefs.theme === "system" && apply());
