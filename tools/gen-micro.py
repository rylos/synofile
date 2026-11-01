#!/usr/bin/env python3
"""Builds ui/js/syntax/ from micro's syntax files: the same colours
`micro` shows in a terminal, for the text editor.

    tools/gen-micro.py path/to/micro

Each runtime/syntax/<type>.yaml becomes ui/js/syntax/<type>.js (rules
with their includes resolved, regexes turned from Go's RE2 into
JavaScript's), loaded only when a file of that type opens; index.js
holds what picks the type (file name, first line) and the CSS of the two
colour schemes in tools/micro/ (github-dark-tc, github-light-tc).
Micro's syntax files: MIT, Zachary Yedidia et al.
"""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ui/js/syntax"

POSIX = {
    "space": r"\s", "alnum": "a-zA-Z0-9", "alpha": "a-zA-Z", "digit": "0-9", "xdigit": "0-9A-Fa-f",
    "upper": "A-Z", "lower": "a-z", "word": r"\w", "blank": r" \t", "cntrl": r"\x00-\x1f\x7f",
    "graph": r"!-~", "print": r" -~", "punct": r"!-/:-@\[-`{-~",
}


def leading_bracket(src):
    """A ] first in a class is a plain ] in RE2, "any character" in JavaScript."""
    out, i, in_class = [], 0, False
    while i < len(src):
        c = src[i]
        if c == "\\":
            out.append(src[i:i + 2])
            i += 2
            continue
        if not in_class and c == "[":
            in_class = True
            out.append(c)
            i += 1
            if src.startswith("^", i):
                out.append("^")
                i += 1
            if src.startswith("]", i):
                out.append("\\]")
                i += 1
            continue
        j = src.find(":]", i) if in_class and src.startswith("[:", i) else -1
        if j > 0:
            out.append(src[i:j + 2])
            i = j + 2
            continue
        if in_class and c == "]":
            in_class = False
        out.append(c)
        i += 1
    return "".join(out)


def js_regex(src):
    """Go's RE2 to JavaScript: [source, flags]."""
    flags = ""
    if "(?i)" in src:
        src = src.replace("(?i)", "")
        flags += "i"
    if "(?i:" in src:
        src = src.replace("(?i:", "(?:")
        flags += "" if "i" in flags else "i"
    src = src.replace("(?-i)", "")
    src = leading_bracket(src)
    src = re.sub(r"\[\[:(\w+):\]\]", lambda m: "[" + POSIX[m[1]] + "]", src)
    src = re.sub(r"\[:(\w+):\]", lambda m: POSIX[m[1]], src)
    src = src.replace("(?P<", "(?<").replace(r"\z", "$").replace(r"\A", "^")
    if r"\p{" in src or r"\P{" in src:
        flags += "u"
    return [src, flags]


def scheme(path):
    """color-link group "style" lines: {group: css}."""
    out = {}
    for m in re.finditer(r'^color-link\s+(\S+)\s+"([^"]*)"', path.read_text(), re.M):
        parts = m[2].split(",")
        css = []
        words = parts[0].split()
        for w in words:
            if w.startswith("#"):
                css.append(f"color:{w}")
            elif w == "bold":
                css.append("font-weight:700")
            elif w == "italic":
                css.append("font-style:italic")
            elif w == "underline":
                css.append("text-decoration:underline")
        if len(parts) > 1 and parts[1].strip().startswith("#"):
            css.append(f"background:{parts[1].strip()}")
        out[m[1]] = ";".join(css)
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    syntax_dir = Path(sys.argv[1]) / "runtime/syntax"
    schemes = {"dark": scheme(ROOT / "tools/micro/github-dark-tc.micro"), "light": scheme(ROOT / "tools/micro/github-light-tc.micro")}
    defined = set(schemes["dark"]) | set(schemes["light"])

    def css_class(group):
        # micro's fallback: constant.string.char → constant.string → constant
        g = group
        while g and g not in defined:
            g = g.rpartition(".")[0]
        return ("mc-" + g.replace(".", "-")) if g else ""

    files = {}
    for f in sorted(syntax_dir.glob("*.yaml")):
        data = yaml.safe_load(f.read_text())
        if isinstance(data, dict) and data.get("filetype"):
            files[data["filetype"]] = data

    bad = []

    def compile_rules(rules, ft, depth=0):
        out = {"p": [], "r": []}
        for rule in rules or []:
            for group, val in rule.items():
                if group == "include":
                    if depth < 4 and val in files:
                        inc = compile_rules(files[val].get("rules"), val, depth + 1)
                        out["p"] += inc["p"]
                        out["r"] += inc["r"]
                    continue
                if isinstance(val, str):
                    out["p"].append([css_class(group), *js_regex(val)])
                elif isinstance(val, dict) and "start" in val and "end" in val:
                    region = {"c": css_class(group), "s": js_regex(val["start"]), "e": js_regex(val["end"])}
                    if "limit-group" in val:
                        region["l"] = css_class(val["limit-group"])
                    if "skip" in val:
                        region["k"] = js_regex(val["skip"])
                    region["rules"] = compile_rules(val.get("rules"), ft, depth)
                    out["r"].append(region)
        return out

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    detect = []
    head = "// Generated by tools/gen-micro.py from micro's runtime/syntax (MIT). Do not edit by hand.\n"
    for ft, data in files.items():
        name = re.sub(r"[^A-Za-z0-9_-]", "_", ft)
        body = compile_rules(data.get("rules"), ft)
        (OUT / f"{name}.js").write_text(head + "export default " + json.dumps(body, ensure_ascii=False, separators=(",", ":")) + ";\n")
        d = data.get("detect") or {}
        detect.append([ft, name, *(js_regex(d[k]) if d.get(k) else None for k in ("filename", "header", "signature"))])

    css = []
    for theme, colors in schemes.items():
        sel = ':root:not([data-theme="light"]) .editor' if theme == "dark" else ':root[data-theme="light"] .editor'
        for group, style in colors.items():
            if style:
                css.append(f"{sel} .mc-{group.replace('.', '-')}{{{style}}}")
    (OUT / "index.js").write_text(head + "export const DETECT = " + json.dumps(detect, ensure_ascii=False, separators=(",", ":")) + ";\n"
                                  + "export const CSS = " + json.dumps("\n".join(css), ensure_ascii=False) + ";\n")
    shutil.copy(syntax_dir / "LICENSE", OUT / "LICENSE")

    # every regex must compile in JavaScript
    check = subprocess.run(["node", "-e", """
const fs = require("fs"), path = require("path"), dir = process.argv[1];
let n = 0, bad = [];
const test = (r, where) => { n++; try { new RegExp(r[0], r[1]); } catch (e) { bad.push(where + ": " + r[0]); } };
const walk = (rules, where) => { for (const p of rules.p) test([p[1], p[2]], where); for (const r of rules.r) { test(r.s, where); test(r.e, where); if (r.k) test(r.k, where); walk(r.rules, where); } };
for (const f of fs.readdirSync(dir)) if (f.endsWith(".js") && f !== "index.js") { const src = fs.readFileSync(path.join(dir, f), "utf8"); walk(JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1)), f); }
console.log(n + " regexes"); for (const b of bad) console.log("BAD " + b);
""", str(OUT)], capture_output=True, text=True)
    print(check.stdout.strip(), check.stderr.strip())
    print(f"{OUT}: {len(files)} file types")


if __name__ == "__main__":
    main()
