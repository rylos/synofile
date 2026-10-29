//! Compiles every src/lang/<code>.json (the NAS's messages in another
//! language) into the binary, so adding a language is adding a file.

use std::fmt::Write;

fn main() {
    println!("cargo:rerun-if-changed=src/lang");
    let mut entries: Vec<String> = std::fs::read_dir("src/lang")
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.ends_with(".json"))
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    let mut out = String::from("pub static TABLES: &[(&str, &str)] = &[\n");
    for name in entries {
        let code = name.trim_end_matches(".json");
        // resolved when the crate compiles, so a moved checkout still builds
        writeln!(out, "    ({code:?}, include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/src/lang/{name}\"))),").unwrap();
    }
    out.push_str("];\n");
    std::fs::write(format!("{}/lang_tables.rs", std::env::var("OUT_DIR").unwrap()), out).unwrap();
}
