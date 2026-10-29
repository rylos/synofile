// Numbers, sizes, dates and durations, in the interface's language.
import { LOCALE, t, count } from "./i18n.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// made on first use, once the language is known (i18n.loadTable)
let made = null;
function intl() {
  if (made?.locale === LOCALE) return made;
  const month = new Intl.DateTimeFormat(LOCALE, { month: "short" });
  made = {
    locale: LOCALE,
    nf1: new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
    nf0: new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }),
    collator: new Intl.Collator(LOCALE, { numeric: true, sensitivity: "base" }),
    months: Array.from({ length: 12 }, (_, i) => month.format(new Date(2026, i, 15)).replace(/\.$/, "")),
  };
  return made;
}
export const int = (n) => intl().nf0.format(n || 0);

let binary = true;
export function setBinary(b) {
  binary = b;
}

const UNITS_BIN = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
const UNITS_DEC = ["B", "KB", "MB", "GB", "TB", "PB"];

/** [number text, unit, magnitude index] */
export function sizeParts(bytes) {
  const base = binary ? 1024 : 1000;
  const units = binary ? UNITS_BIN : UNITS_DEC;
  let v = bytes || 0;
  let u = 0;
  while (v >= base && u < units.length - 1) {
    v /= base;
    u++;
  }
  const { nf0, nf1 } = intl();
  const text = u === 0 ? nf0.format(v) : v >= 100 ? nf0.format(v) : nf1.format(v);
  return [text, units[u], u];
}

export function size(bytes) {
  const [n, u] = sizeParts(bytes);
  return `${n} ${u}`;
}

export function speed(bps) {
  return `${size(bps)}/s`;
}


const month = (i) => intl().months[i];
const pad = (n) => String(n).padStart(2, "0");

/** eza's date column: "29 ott 21:45" this year, "29 ott  2025" before. */
export function ezaDate(sec) {
  if (!sec) return "-";
  const d = new Date(sec * 1000);
  const now = new Date();
  const recent = Math.abs(now - d) < 180 * 86400 * 1000;
  const day = String(d.getDate()).padStart(2, " ");
  return recent ? `${day} ${month(d.getMonth())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${day} ${month(d.getMonth())}  ${d.getFullYear()}`;
}

export function dateTime(sec) {
  if (!sec) return "-";
  const d = new Date(sec * 1000);
  return `${d.getDate()} ${month(d.getMonth())} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function relative(sec) {
  if (!sec) return "-";
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return t("adesso");
  if (diff < 3600) return t("{n} min fa", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n} h fa", { n: Math.floor(diff / 3600) });
  if (diff < 86400 * 7) return t("{n} g fa", { n: Math.floor(diff / 86400) });
  return ezaDate(sec).trim();
}

export function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 1 h 02 min, 3 min 05 s, 42 s */
export function duration(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h) return `${h} h ${pad(m)} min`;
  if (m) return `${m} min ${pad(s)} s`;
  return `${s} s`;
}

export function shortDuration(ms) {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s = s % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The mode column the way `ls -l` and eza print it. */
export function modeString(kind, mode) {
  const t = kind === "d" ? "d" : kind === "l" ? "l" : kind === "o" ? "s" : ".";
  const bits = [
    [0o400, "r"], [0o200, "w"], [0o100, "x"],
    [0o040, "r"], [0o020, "w"], [0o010, "x"],
    [0o004, "r"], [0o002, "w"], [0o001, "x"],
  ];
  let out = t;
  bits.forEach(([bit, ch], i) => {
    let c = mode & bit ? ch : "-";
    if (ch === "x") {
      const special = i === 2 ? 0o4000 : i === 5 ? 0o2000 : 0o1000;
      if (mode & special) c = mode & bit ? (i === 8 ? "t" : "s") : i === 8 ? "T" : "S";
    }
    out += c;
  });
  return out;
}

export function plural(n, one, many) {
  return count(n, one, many, int);
}

export function joinPath(dir, name) {
  return dir.replace(/\/+$/, "") + "/" + name;
}

export function parentOf(path) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return "/" + parts.join("/");
}

export function baseName(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

export function ext(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Natural order: "file2" before "file10", accents and case folded. */
export const collator = { compare: (a, b) => intl().collator.compare(a, b) };
