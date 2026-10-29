// The interface speaks DSM's language. Strings are written in Italian in
// the code; ui/js/lang/<code>.js maps them to another language. A string a
// table lacks falls back to English, then to the Italian original.
//
// Adding a language: tools/i18n-check.py --new <code> writes the two
// tables (this interface and the NAS's messages) with every string to
// translate; nothing else needs to change.

/** DSM's language codes (SYNO.SDS.Session.lang) to ISO ones. */
const DSM = {
  enu: "en", ita: "it", ger: "de", fre: "fr", spn: "es", cht: "zh-TW", chs: "zh-CN", jpn: "ja", krn: "ko",
  nld: "nl", ptb: "pt-BR", ptg: "pt", rus: "ru", sve: "sv", dan: "da", nor: "nb", plk: "pl", trk: "tr",
  csy: "cs", hun: "hu", tha: "th",
};

function dsmLang() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q) return q;
  } catch {}
  try {
    const sds = window.parent !== window && window.parent.SYNO && window.parent.SYNO.SDS;
    const lang = sds && sds.Session && sds.Session.lang;
    // "def" is DSM's "same as the browser"
    if (lang && lang !== "def") return lang;
  } catch {
    // another origin: no access to DSM
  }
  return navigator.language || "en";
}

function normalize(raw) {
  const low = String(raw || "").trim();
  if (DSM[low.toLowerCase()]) return DSM[low.toLowerCase()];
  const [base, region] = low.replace("_", "-").split("-");
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase();
}

/** The language asked for; LANG becomes the one actually served after loadTable(). */
export let LANG = normalize(dsmLang());
/** For Intl: dates, numbers, sorting. */
export let LOCALE = LANG;

let TABLE = {};
let EN = {};

/** Loads the table of LANG (or of its base language), and English to fall back on. */
export async function loadTable() {
  const tryLoad = async (code) => {
    try {
      return (await import(`./lang/${code}.js`)).default;
    } catch {
      return null;
    }
  };
  if (LANG !== "it") {
    EN = (await tryLoad("en")) || {};
    const candidates = [LANG, LANG.split("-")[0]];
    let found = null;
    for (const c of candidates) {
      if (c === "en") {
        found = "en";
        TABLE = EN;
        break;
      }
      const table = await tryLoad(c);
      if (table) {
        found = c;
        TABLE = table;
        break;
      }
    }
    if (!found) {
      TABLE = EN;
      found = "en";
    }
    LANG = found;
  }
  LOCALE = { it: "it-IT", en: "en-GB" }[LANG] || LANG;
  document.documentElement.lang = LANG;
}

// A key may carry a context after "|" ("Copia|op", "file|pl"): Italian
// shows what comes before it; the tables translate each context apart.
const plain = (key) => key.split("|")[0];

function lookup(key) {
  if (LANG === "it") return plain(key);
  // an empty translation counts as missing
  return TABLE[key] || EN[key] || plain(key);
}

export function t(text, vars) {
  let out = lookup(text);
  // a plural table asked as a plain string: its general form
  if (typeof out === "object") out = out.other || out.many || Object.values(out)[0];
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out;
}

let rules = null;

/**
 * "1 file" / "3 file", "1 cartella" / "3 cartelle". The plural may be a
 * table of the language's forms ({one, few, many, other}, as
 * Intl.PluralRules names them): Polish says 2 pliki but 5 plików. When
 * Italian uses one word for both, the plural key is `word|pl`.
 */
export function count(n, one, many, fmt = (x) => x) {
  if (!rules || rules.resolvedOptions().locale !== new Intl.PluralRules(LOCALE).resolvedOptions().locale) rules = new Intl.PluralRules(LOCALE);
  const form = rules.select(n);
  if (form === "one" || (LANG === "it" && n === 1)) return `${fmt(n)} ${t(one)}`;
  const key = one === many ? `${many}|pl` : many;
  const value = lookup(key);
  const word = typeof value === "object" ? value[form] || value.other || value.many : value;
  return `${fmt(n)} ${word}`;
}
