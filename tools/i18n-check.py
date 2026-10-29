#!/usr/bin/env python3
"""Checks the translations, or starts a new language.

    tools/i18n-check.py            every table against the strings in use
    tools/i18n-check.py --new de   write ui/js/lang/de.js and src/lang/de.json

The interface's strings are Italian in the code (t("..."), and a few
tables of labels); ui/js/lang/<code>.js maps them to a language, English
being ui/js/lang/en.js. The NAS's messages are t!("italiano", "English")
in src/; src/lang/<code>.json maps the Italian to any other language.
For each table it reports what is missing, what is no longer used, what
still equals the English, and placeholders that differ from the original.
It exits 1 when something is missing or broken.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui" / "js"
SRC = ROOT / "src"

STR = r'"((?:[^"\\]|\\.)*)"'

# DSM's codes, for the package files a new language also needs
ISO_TO_DSM = {
    "en": "enu", "it": "ita", "de": "ger", "fr": "fre", "es": "spn", "zh-TW": "cht", "zh-CN": "chs", "ja": "jpn",
    "ko": "krn", "nl": "nld", "pt-BR": "ptb", "pt": "ptg", "ru": "rus", "sv": "sve", "da": "dan", "nb": "nor",
    "pl": "plk", "tr": "trk", "cs": "csy", "hu": "hun", "th": "tha",
}


def unq(s):
    return json.loads('"' + s + '"')


def call_args(text, name):
    """The argument text of every call `name(...)`, nested parentheses and strings included."""
    for m in re.finditer(r"(?<![\w.$])" + name + r"\(", text):
        depth, i, quote = 1, m.end(), None
        while i < len(text) and depth:
            c = text[i]
            if quote:
                if c == "\\":
                    i += 1
                elif c == quote:
                    quote = None
            elif c in "\"'`":
                quote = c
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            i += 1
        yield text[m.end():i - 1]


def ui_strings():
    """Every Italian string the interface translates."""
    keys = set()
    for f in sorted(UI.glob("*.js")):
        if f.name == "eza.js":
            continue
        text = f.read_text()
        # t("...") anywhere, and t(cond ? "a" : "b"), however nested
        keys |= {unq(m) for m in re.findall(r"\bt\(\s*" + STR, text)}
        for args in call_args(text, "t"):
            for a, b in re.findall(r"\?\s*" + STR + r"\s*:\s*" + STR, args):
                keys |= {unq(a), unq(b)}
        # section triples: ["look", "palette", "Aspetto"]
        keys |= {unq(m) for m in re.findall(r"\[\s*\"[\w-]+\",\s*\"[\w-]+\",\s*\"([A-ZÀ-Ý](?:[^\"\\\\]|\\\\.)*)\"\s*\]", text)}
        # count(n, "one", "many") and plural(n, "one", "many")
        for m in re.finditer(r"\b(?:count|plural)\([^,()]+(?:\([^()]*\))?,\s*" + STR + r",\s*" + STR, text):
            one, many = unq(m[1]), unq(m[2])
            keys |= {one, many if many != one else many + "|pl"}
        # settings rows: row("label", "hint", ...)
        for m in re.finditer(r"\brow\(\s*" + STR + r",\s*" + STR, text):
            keys |= {unq(m[1]), unq(m[2])}
        # labels in tables: ["key", "Label"], [0, "Label"], label: "...", running/done/noun: "..."
        keys |= {unq(m) for m in re.findall(r"\[\s*(?:\"[\w-]+\"|\d+)\s*,\s*" + STR + r"\s*\]", text)}
        keys |= {unq(m) for m in re.findall(r"\b(?:label|running|done|noun):\s*" + STR, text)}
        # STATE and KINDS: lowercase keys with an Italian label
        for block in re.findall(r"const (?:STATE|KINDS) = \{(.*?)\};", text, re.S):
            keys |= {unq(m) for m in re.findall(r"\w+:\s*" + STR, block)}
        # shortcut table: key names, then descriptions
        for block in re.findall(r"export const KEYS = \[(.*?)\];", text, re.S):
            for k, d in re.findall(r"\[" + STR + r",\s*" + STR + r"\]", block):
                keys.add(unq(d))
                for part in re.split(r" / |\+", unq(k)):
                    keys.add(part)
    # what is not words: units, glyphs, codes
    return {k for k in keys if re.search(r"[A-Za-zÀ-ÿ]{2}", k) and not re.fullmatch(r"[\d ]+(MiB|MB|KB)/s", k)}


def rust_strings():
    """Italian → English of every t!() in src/."""
    out = {}
    for f in SRC.rglob("*.rs"):
        # examples in comments are not messages
        code = "\n".join(line for line in f.read_text().splitlines() if not line.lstrip().startswith("//"))
        for m in re.finditer(r"\bt!\(\s*" + STR + r",\s*" + STR, code):
            out[unq(m[1])] = unq(m[2])
    return out


def read_js_table(path):
    # run the module: plural values are objects, which no regex reads well
    import subprocess
    code = f"import(process.argv[1]).then(m => console.log(JSON.stringify(m.default)))"
    out = subprocess.run(["node", "--input-type=module", "-e", code, path.resolve().as_uri()], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def plain(k):
    return k.split("|")[0]


def forms(v):
    """A translation's texts: one string, or each plural form."""
    return list(v.values()) if isinstance(v, dict) else [v]


def placeholders(s, rust=False):
    return sorted(re.findall(r"\{\}" if rust else r"\{\w+\}", s))


def check():
    bad = 0
    used = ui_strings()
    en = read_js_table(UI / "lang" / "en.js")
    rust = rust_strings()
    for path in sorted((UI / "lang").glob("*.js")):
        table = read_js_table(path)
        code = path.stem
        missing = sorted(used - set(table))
        stale = sorted(k for k in set(table) - used if re.search(r"[A-Za-zÀ-ÿ]{2}", k))
        same = sorted(k for k in table if code != "en" and table[k] == en.get(k) and re.search(r"[a-z]{3}", k) and table[k] != plain(k))
        broken = sorted(k for k, v in table.items() if any(f and placeholders(k.split("|")[0]) != placeholders(f) for f in forms(v)))
        print(f"ui/js/lang/{path.name}: {len(table)} strings, {len(missing)} missing, {len(stale)} unused, {len(same)} still English, {len(broken)} with wrong placeholders")
        for k in missing:
            print(f"  missing:  {k!r}")
        for k in broken:
            print(f"  placeholders: {k!r} → {table[k]!r}")
        for k in stale:
            print(f"  unused:   {k!r}")
        if code != "en":
            for k in same:
                print(f"  english:  {k!r}")
        bad += len(missing) + len(broken)
    for path in sorted((SRC / "lang").glob("*.json")):
        table = json.loads(path.read_text())
        missing = sorted(set(rust) - set(table))
        stale = sorted(set(table) - set(rust))
        same = sorted(k for k, v in table.items() if v == rust.get(k))
        broken = sorted(k for k, v in table.items() if v and placeholders(k, True) != placeholders(v, True))
        print(f"src/lang/{path.name}: {len(table)} messages, {len(missing)} missing, {len(stale)} unused, {len(same)} still English, {len(broken)} with wrong placeholders")
        for k in missing:
            print(f"  missing:  {k!r}")
        for k in broken:
            print(f"  placeholders: {k!r} → {table[k]!r}")
        for k in stale:
            print(f"  unused:   {k!r}")
        for k in same:
            print(f"  english:  {k!r}")
        bad += len(missing) + len(broken)
    return 1 if bad else 0


def new(code):
    en = read_js_table(UI / "lang" / "en.js")
    used = sorted(ui_strings())
    js = UI / "lang" / f"{code}.js"
    rs = SRC / "lang" / f"{code}.json"
    for p in (js, rs):
        if p.exists():
            sys.exit(f"{p} exists already")
    # the English as a start: the check lists what is still English
    lines = [f"// {code}: every Italian string of the interface (see ui/js/i18n.js). Started from the English.", "export default {"]
    lines += [f"  {json.dumps(k, ensure_ascii=False)}: {json.dumps(en.get(k, k), ensure_ascii=False)}," for k in used]
    lines.append("};")
    js.write_text("\n".join(lines) + "\n")
    rust = rust_strings()
    rs.write_text(json.dumps(dict(sorted(rust.items())), ensure_ascii=False, indent=1) + "\n")
    dsm = ISO_TO_DSM.get(code, code)
    texts = ROOT / "ui" / "texts" / dsm
    texts.mkdir(parents=True, exist_ok=True)
    if not (texts / "strings").exists():
        (texts / "strings").write_text((ROOT / "ui" / "texts" / "enu" / "strings").read_text())
    print(f"written {js.relative_to(ROOT)}, {rs.relative_to(ROOT)} and ui/texts/{dsm}/strings")
    print(f"translate them, then add description_{dsm}=\"...\" to spk/INFO.in and run tools/i18n-check.py")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--new":
        new(sys.argv[2])
    elif len(sys.argv) == 1:
        sys.exit(check())
    else:
        sys.exit(__doc__)
