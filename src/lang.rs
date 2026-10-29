//! The language of the messages the NAS sends back: DSM's, which the
//! interface passes along (`lang` on every request, and in a job's spec).
//!
//! Messages are written in the code in Italian and English:
//! `t!("italiano {}", "English {}", args...)`. Any other language comes
//! from src/lang/<code>.json, keyed by the Italian text, built into the
//! binary by build.rs. A message a table lacks falls back to English.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::OnceLock;

include!(concat!(env!("OUT_DIR"), "/lang_tables.rs"));

thread_local! {
    static LANG: Cell<&'static str> = const { Cell::new("it") };
}

/// DSM's language codes to ISO ones.
const DSM: &[(&str, &str)] = &[
    ("enu", "en"), ("ita", "it"), ("ger", "de"), ("fre", "fr"), ("spn", "es"), ("cht", "zh-TW"), ("chs", "zh-CN"),
    ("jpn", "ja"), ("krn", "ko"), ("nld", "nl"), ("ptb", "pt-BR"), ("ptg", "pt"), ("rus", "ru"), ("sve", "sv"),
    ("dan", "da"), ("nor", "nb"), ("plk", "pl"), ("trk", "tr"), ("csy", "cs"), ("hun", "hu"), ("tha", "th"),
];

fn tables() -> &'static HashMap<&'static str, HashMap<String, String>> {
    static PARSED: OnceLock<HashMap<&'static str, HashMap<String, String>>> = OnceLock::new();
    PARSED.get_or_init(|| {
        TABLES
            .iter()
            .filter_map(|(code, text)| Some((*code, serde_json::from_str::<HashMap<String, String>>(text).ok()?)))
            .collect()
    })
}

/// The language to answer in: "it", "en", or one with a table.
pub fn resolve(raw: &str) -> &'static str {
    let low = raw.trim().replace('_', "-");
    let iso = DSM.iter().find(|(d, _)| d.eq_ignore_ascii_case(&low)).map(|(_, i)| i.to_string()).unwrap_or(low);
    let base = iso.split('-').next().unwrap_or_default().to_ascii_lowercase();
    for candidate in [iso.as_str(), base.as_str()] {
        if candidate.eq_ignore_ascii_case("it") {
            return "it";
        }
        if candidate.eq_ignore_ascii_case("en") {
            return "en";
        }
        if let Some((code, _)) = tables().get_key_value(candidate) {
            return code;
        }
    }
    "en"
}

pub fn set(lang: &str) {
    let code = resolve(lang);
    LANG.with(|l| l.set(code));
}

pub fn code() -> &'static str {
    LANG.with(Cell::get)
}

/// The template in the current language.
pub fn pick(it: &'static str, en: &'static str) -> &'static str {
    match code() {
        "it" => it,
        "en" => en,
        other => tables().get(other).and_then(|t| t.get(it)).map(String::as_str).unwrap_or(en),
    }
}

/// Fills the `{}` of a template in order.
pub fn fill(template: &str, args: &[String]) -> String {
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    let mut args = args.iter();
    while let Some(at) = rest.find("{}") {
        out.push_str(&rest[..at]);
        out.push_str(args.next().map(String::as_str).unwrap_or(""));
        rest = &rest[at + 2..];
    }
    out.push_str(rest);
    out
}

/// `t!("italiano {}", "English {}", args...)`: a String in the current language.
#[macro_export]
macro_rules! t {
    ($it:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        $crate::lang::fill($crate::lang::pick($it, $en), &[$(::std::string::ToString::to_string(&$arg)),*])
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_dsm_codes() {
        assert_eq!(resolve("ita"), "it");
        assert_eq!(resolve("it-IT"), "it");
        assert_eq!(resolve("enu"), "en");
        // no table for these: English
        assert_eq!(resolve("krn"), if tables().contains_key("ko") { "ko" } else { "en" });
        assert_eq!(resolve(""), "en");
    }

    #[test]
    fn fills_and_falls_back() {
        set("it");
        assert_eq!(t!("{} saltati, {} errori", "{} skipped, {} errors", 3, 1), "3 saltati, 1 errori");
        set("enu");
        assert_eq!(t!("{} saltati", "{} skipped", 2), "2 skipped");
        set("xx");
        assert_eq!(t!("nuovo", "new"), "new");
        assert_eq!(fill("a {} b {}", &["1".into()]), "a 1 b ");
    }

    #[test]
    fn tables_are_valid() {
        // every table parses, and keeps the {} of its originals
        assert_eq!(tables().len(), TABLES.len(), "a src/lang/*.json is not valid JSON");
        for (code, table) in tables() {
            for (it, tr) in table {
                assert_eq!(it.matches("{}").count(), tr.matches("{}").count(), "{code}: {it:?} → {tr:?}");
            }
        }
    }
}
