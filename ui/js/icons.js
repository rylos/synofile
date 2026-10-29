// File icons and colours as eza draws them (tables generated from eza's
// sources by tools/gen-eza.py), and the interface's own line icons.

import EZA from "./eza.js";
import { ext } from "./format.js";
import { t } from "./i18n.js";

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico", "heic", "heif", "tif", "tiff"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "webm", "mkv", "mov", "avi", "wmv", "mpg", "mpeg", "ts", "m2ts", "flv", "3gp"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "wma", "alac", "aiff"]);
const TEXT_EXT = new Set([
  "txt", "log", "md", "conf", "ini", "cfg", "csv", "tsv", "json", "yml", "yaml", "toml", "xml", "sh", "zsh", "bash",
  "py", "rs", "js", "mjs", "ts", "css", "c", "h", "cpp", "hpp", "go", "java", "sql", "nfo", "srt", "html", "htm",
  "php", "rb", "lua", "pl", "vb", "bat", "ps1", "env", "properties", "service", "desktop", "gitignore", "lock", "diff", "patch",
]);

const ARCHIVE = /\.(zip|7z|rar|tar|tgz|tbz2?|txz|gz|bz2|xz|zst|iso|cab|arj|lzh|lha|cpio|rpm|deb|wim|jar|z)$/i;

export function isArchive(entry) {
  return entry.kind === "f" && ARCHIVE.test(entry.name);
}

/** "Foto.tar.gz" → "Foto", the way the NAS names the folder it extracts into. */
export function archiveStem(name) {
  const m = name.match(/^(.+?)\.(tar\.(gz|bz2|xz|zst|lz)|tgz|tbz2|txz)$/i);
  if (m) return m[1];
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function previewKind(entry) {
  if (entry.kind === "d") return "dir";
  const e = ext(entry.name);
  if (IMAGE_EXT.has(e)) return "image";
  if (VIDEO_EXT.has(e)) return "video";
  if (AUDIO_EXT.has(e)) return "audio";
  if (e === "pdf") return "pdf";
  if (TEXT_EXT.has(e) || !e || entry.size < 2 * 1024 * 1024 && /^(readme|license|makefile|dockerfile|changelog)/i.test(entry.name)) return "text";
  return "other";
}

/** eza's icon for an entry (icon_for_file). */
export function glyph(entry) {
  if (entry.kind === "d" || entry.link_dir) {
    return EZA.dirs[entry.name] || EZA.icons.folder;
  }
  if (EZA.names[entry.name]) return EZA.names[entry.name];
  const e = ext(entry.name);
  if (e) return EZA.exts[e] || EZA.icons.file;
  return EZA.icons.file_unknow || EZA.icons.file;
}

/** eza's colour class for a name (FileType::get_file_type + the kinds). */
export function colorClass(entry) {
  if (entry.kind === "d") return "ez-dir";
  if (entry.kind === "l") return "ez-link";
  if (entry.kind === "o") return "ez-special";
  if (entry.mode & 0o111) return "ez-exec";
  const name = entry.name;
  if (name.toLowerCase().startsWith("readme")) return "ez-build";
  const t = EZA.nameTypes[name] || EZA.extTypes[ext(name)];
  if (t) return "ez-" + t;
  if (name.endsWith("~") || (name.startsWith("#") && name.endsWith("#"))) return "ez-temp";
  return "";
}

/** The icon's colour: eza paints it like the name, without bold. */
export function iconHTML(entry, extra = "") {
  return `<i class="gi ${colorClass(entry)} ${extra}">${glyph(entry)}</i>`;
}

export const FOLDER_GLYPH = EZA.icons.folder;
export const HOME_GLYPH = EZA.dirs.home;
export function shareGlyph(name) {
  return EZA.dirs[name] || EZA.icons.folder;
}

const KINDS = {
  image: "Immagine", video: "Video", music: "Audio", lossless: "Audio lossless", crypto: "Chiave o firma",
  document: "Documento", compressed: "Archivio", temp: "File temporaneo", compiled: "File compilato",
  build: "File di progetto", source: "Codice sorgente",
};

export function kindLabel(entry) {
  if (entry.kind === "d") return t("Cartella");
  if (entry.kind === "l") return t(entry.link_dir ? "Collegamento a cartella" : "Collegamento simbolico");
  if (entry.kind === "o") return t("File speciale");
  const e = ext(entry.name);
  const type = EZA.nameTypes[entry.name] || EZA.extTypes[e];
  const base = t((type && KINDS[type]) || (entry.mode & 0o111 ? "Eseguibile" : "File"));
  return e ? `${base} ${e.toUpperCase()}` : base;
}

// ---- line icons (24×24, stroke) ----
const P = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  forward: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 19C5.5 19 2 12 2 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M2 2l20 20"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/>',
  paste: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  rename: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  minimize: '<path d="M5 19h14"/>',
  transfers: '<path d="M7 4v16M7 20l-4-4M7 20l4-4M17 20V4M17 4l-4 4M17 4l4 4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sort: '<path d="M3 6h12M3 12h8M3 18h4M17 8V20M17 20l-3-3M17 20l3-3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  home: '<path d="M3 11l9-8 9 8M5 9.5V21h14V9.5"/>',
  drive: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 14h.01M10 14h.01"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8M10 13h4"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 1 0 0 20c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a6 6 0 0 0 6-6c0-4.9-4.5-8.6-10-8.6z"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  archive: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
};

export function svg(name, cls = "i") {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ""}</svg>`;
}
