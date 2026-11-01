// micro's syntax highlighter (pkg/highlight/highlighter.go), line by
// line: regions (strings, comments…) that can span lines, and patterns
// painted over each other in order. The rules come from micro's own
// syntax files (ui/js/syntax, made by tools/gen-micro.py).

import { DETECT, CSS } from "./syntax/index.js";

const compiled = new Map();
const re = ([src, flags], g = "") => {
  const key = src + "/" + flags + g;
  let r = compiled.get(key);
  if (!r) compiled.set(key, (r = new RegExp(src, flags + g)));
  return r;
};

/** micro's file type of a path and its first lines: { ft, name }. */
export function detect(path, text) {
  const lines = text.slice(0, 64 * 1024).split("\n", 100);
  const byName = DETECT.filter((d) => d[2] && re(d[2]).test(path));
  let hit = byName.find((d) => d[4] && lines.some((l) => re(d[4]).test(l))) || byName[0];
  if (!hit) hit = DETECT.find((d) => d[3] && re(d[3]).test(lines[0] || ""));
  if (!hit) hit = DETECT.find((d) => d[0] === "unknown");
  return hit ? { ft: hit[0], name: hit[1] } : null;
}

let styled = false;
/** The two colour schemes, once per page. */
export function injectColors() {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.append(s);
}

/** The rules of a file type, compiled: { patterns, regions }. */
export async function loadSyntax(name) {
  const def = (await import(`./syntax/${name}.js`)).default;
  const build = (rules, parent) => {
    const out = { patterns: rules.p.map(([cls, src, flags]) => ({ cls, re: re([src, flags]), all: re([src, flags], "g") })), regions: [] };
    for (const r of rules.r) {
      const region = { cls: r.c, limit: r.l ?? r.c, start: re(r.s), end: re(r.e), skip: r.k ? re(r.k, "g") : null, parent };
      region.rules = build(r.rules, region);
      out.regions.push(region);
    }
    return out;
  };
  return build(def, null);
}

function findIndex(regex, skip, str) {
  const s = skip ? str.replace(skip, (m) => "\0".repeat(m.length)) : str;
  const m = regex.exec(s);
  return m ? [m.index, m.index + m[0].length] : null;
}

function findAll(regex, str) {
  const out = [];
  regex.lastIndex = 0;
  for (let m; (m = regex.exec(str)); ) {
    out.push([m.index, m.index + m[0].length]);
    if (!m[0].length) regex.lastIndex++;
  }
  return out;
}

export class Highlighter {
  constructor(def) {
    this.def = def;
    this.last = null;
  }

  /**
   * One line from the state the line before ended in. Returns the colour
   * changes (position → class, "" for none) and the state at its end; with
   * `statesOnly`, the state alone.
   */
  line(text, state, statesOnly = false) {
    const hl = statesOnly ? null : new Map();
    this.last = state;
    if (!state) this.empty(hl, 0, true, text, statesOnly);
    else this.region(hl, 0, true, text, state, statesOnly);
    return { hl, end: this.last };
  }

  region(hl, start, canMatchEnd, line, cur, statesOnly) {
    const len = line.length;
    if (start === 0 && !statesOnly && !hl.has(0)) hl.set(0, cur.cls);
    let firstRegion = null;
    let firstLoc = [len, 0];
    let searchNesting = true;
    const endLoc = findIndex(cur.end, cur.skip, line);
    if (endLoc) {
      if (start === endLoc[0]) searchNesting = false;
      else firstLoc = endLoc;
    }
    if (searchNesting) {
      for (const r of cur.rules.regions) {
        const loc = findIndex(r.start, r.skip, line);
        if (loc && loc[0] < firstLoc[0]) {
          firstLoc = loc;
          firstRegion = r;
        }
      }
    }
    if (firstRegion && firstLoc[0] !== len) {
      if (!statesOnly) hl.set(start + firstLoc[0], firstRegion.limit);
      this.empty(hl, start + firstLoc[1], canMatchEnd, line.slice(firstLoc[1]), statesOnly);
      this.region(hl, start + firstLoc[1], canMatchEnd, line.slice(firstLoc[1]), firstRegion, statesOnly);
      return;
    }
    if (!statesOnly) {
      const full = new Array(len).fill(cur.cls);
      if (searchNesting) {
        for (const p of cur.rules.patterns) {
          if (cur.cls !== cur.limit && p.cls !== cur.limit) continue;
          for (const m of findAll(p.all, line)) {
            if (!endLoc || m[0] < endLoc[0]) for (let i = m[0]; i < m[1]; i++) full[i] = p.cls;
          }
        }
      }
      for (let i = 0; i < len; i++) if (i === 0 || full[i] !== full[i - 1]) hl.set(start + i, full[i]);
    }
    if (endLoc) {
      if (!statesOnly) hl.set(start + endLoc[0], cur.limit);
      if (!cur.parent) {
        if (!statesOnly) hl.set(start + endLoc[1], "");
        this.empty(hl, start + endLoc[1], canMatchEnd, line.slice(endLoc[1]), statesOnly);
        return;
      }
      if (!statesOnly) hl.set(start + endLoc[1], cur.parent.cls);
      this.region(hl, start + endLoc[1], canMatchEnd, line.slice(endLoc[1]), cur.parent, statesOnly);
      return;
    }
    if (canMatchEnd) this.last = cur;
  }

  empty(hl, start, canMatchEnd, line, statesOnly) {
    const len = line.length;
    if (!len) {
      if (canMatchEnd) this.last = null;
      return;
    }
    let firstRegion = null;
    let firstLoc = [len, 0];
    for (const r of this.def.regions) {
      const loc = findIndex(r.start, r.skip, line);
      if (loc && loc[0] < firstLoc[0]) {
        firstLoc = loc;
        firstRegion = r;
      }
    }
    if (firstRegion && firstLoc[0] !== len) {
      if (!statesOnly) hl.set(start + firstLoc[0], firstRegion.limit);
      this.empty(hl, start, false, line.slice(0, firstLoc[0]), statesOnly);
      this.region(hl, start + firstLoc[1], canMatchEnd, line.slice(firstLoc[1]), firstRegion, statesOnly);
      return;
    }
    if (statesOnly) {
      if (canMatchEnd) this.last = null;
      return;
    }
    const full = new Array(len).fill("");
    for (const p of this.def.patterns) for (const m of findAll(p.all, line)) for (let i = m[0]; i < m[1]; i++) full[i] = p.cls;
    for (let i = 0; i < len; i++) if (i === 0 || full[i] !== full[i - 1]) hl.set(start + i, full[i]);
    if (canMatchEnd) this.last = null;
  }
}
