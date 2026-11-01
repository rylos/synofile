// A plain text editor in micro's manner: the whole window, line numbers
// in a gutter of their own, the lines changed since opening marked
// beside them, a status line and a message line at the bottom, micro's
// keys (Ctrl+S, Ctrl+Q, Ctrl+F…). CodeMirror 6 does the editing.

import {
  EditorState, EditorView, StateField, StateEffect, Compartment, Decoration, ViewPlugin, RangeSetBuilder, ChangeSet, EditorSelection,
  keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars,
  highlightTrailingWhitespace, gutter, GutterMarker, defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth,
  indentWithTab, copyLineDown, deleteLine, moveLineUp, moveLineDown, selectAll, SearchCursor, bracketMatching,
} from "../vendor/codemirror/codemirror.js";
import { api } from "./api.js";
import { t } from "./i18n.js";
import { esc, baseName } from "./format.js";
import { h, errorToast } from "./ui.js";
import { svg } from "./icons.js";
import { detect, loadSyntax, injectColors, Highlighter } from "./highlight.js";

let open = null;

/** Opens `path` in the editor; resolves when it closes, true if it was saved. */
export async function editFile(path, { label = path } = {}) {
  if (open) return false;
  let data;
  try {
    data = await api.editOpen(path);
  } catch (e) {
    errorToast(e);
    return false;
  }
  return new Promise((resolve) => (open = new Editor(path, label, data, resolve)));
}

/** Text to the clipboard, also where the page is not https (DSM on the LAN). */
function writeClipboard(text) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text).catch(() => {});
  const back = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.append(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  back?.focus();
}

// ---------- the lines changed since the last save, as micro's diff gutter ----------

const savedNow = StateEffect.define();
const sinceOpen = StateField.define({
  create: (state) => ChangeSet.empty(state.doc.length),
  update: (changes, tr) => {
    if (tr.effects.some((e) => e.is(savedNow))) return ChangeSet.empty(tr.state.doc.length);
    return tr.docChanged ? changes.compose(tr.changes) : changes;
  },
});

class DiffMarker extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind;
  }
  eq(other) {
    return other.kind === this.kind;
  }
  toDOM() {
    return h(`<span class="ed-diff-${this.kind}"></span>`);
  }
}
const MARKERS = { added: new DiffMarker("added"), modified: new DiffMarker("modified"), deleted: new DiffMarker("deleted") };

const changedLines = new WeakMap();
function linesOf(state) {
  let map = changedLines.get(state);
  if (map) return map;
  map = new Map();
  state.field(sinceOpen).iterChangedRanges((fromA, toA, fromB, toB) => {
    const doc = state.doc;
    if (fromB === toB) {
      // only removed: the mark goes on the line where the text was
      const n = doc.lineAt(Math.min(fromB, doc.length)).number;
      if (!map.has(n)) map.set(n, "deleted");
      return;
    }
    const kind = fromA === toA ? "added" : "modified";
    // text ending with a line break does not touch the line after it
    const end = toB > fromB && doc.lineAt(toB).from === toB ? toB - 1 : toB;
    for (let n = doc.lineAt(fromB).number, last = doc.lineAt(end).number; n <= last; n++) map.set(n, kind);
  });
  changedLines.set(state, map);
  return map;
}

const diffGutter = gutter({
  class: "ed-diff",
  lineMarker: (view, line) => MARKERS[linesOf(view.state).get(view.state.doc.lineAt(line.from).number)] || null,
  lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(savedNow))),
});

// ---------- tabs drawn with micro's indent-char ----------

const tabMark = Decoration.mark({ class: "ed-tab" });
const indentTabs = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view) {
      const b = new RangeSetBuilder();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          const m = /^\t+/.exec(line.text);
          if (m) for (let i = 0; i < m[0].length; i++) b.add(line.from + i, line.from + i + 1, tabMark);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------- micro's syntax colours ----------

const marks = new Map();
const mark = (cls) => marks.get(cls) || marks.set(cls, Decoration.mark({ class: cls })).get(cls);

/** Colours the visible lines; the state each line ends in is kept from the top down. */
function syntaxColors(def) {
  const hl = new Highlighter(def);
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.states = [];
        this.decorations = this.build(view);
      }
      update(u) {
        if (u.docChanged) {
          let first = Infinity;
          u.changes.iterChangedRanges((fromA, toA, fromB) => (first = Math.min(first, u.state.doc.lineAt(fromB).number)));
          this.states.length = Math.min(this.states.length, Math.max(0, first - 1));
        }
        if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
      }
      /** The state at the end of line n - 1. */
      before(doc, n) {
        while (this.states.length < n - 1) {
          const k = this.states.length + 1;
          this.states.push(hl.line(doc.line(k).text, k > 1 ? this.states[k - 2] : null, true).end);
        }
        return n > 1 ? this.states[n - 2] : null;
      }
      build(view) {
        const b = new RangeSetBuilder();
        const doc = view.state.doc;
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = doc.lineAt(pos);
            const { hl: changes, end } = hl.line(line.text, this.before(doc, line.number));
            if (this.states.length === line.number - 1) this.states.push(end);
            const points = [...changes.entries()].sort((a, c) => a[0] - c[0]);
            for (let i = 0; i < points.length; i++) {
              const [at, cls] = points[i];
              const until = Math.min(i + 1 < points.length ? points[i + 1][0] : line.length, line.length);
              if (cls && until > at) b.add(line.from + at, line.from + until, mark(cls));
            }
            pos = line.to + 1;
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ---------- the editor ----------

class Editor {
  constructor(path, label, data, resolve) {
    this.path = path;
    this.label = label;
    this.name = baseName(path);
    this.stamp = data.stamp;
    this.readOnly = !data.writable;
    this.resolve = resolve;
    this.saved = false;
    this.query = "";
    // CRLF files stay CRLF: CodeMirror works on \n, the line break comes back on save
    this.crlf = /\r\n/.test(data.text);
    const text = this.crlf ? data.text.replace(/\r\n/g, "\n") : data.text;

    // the toolbar, for the mouse: each button says its key
    const btn = (act, icon, label, key = "") => `<button type="button" class="ed-btn" data-act="${act}" title="${esc(label)}${key ? ` (${key})` : ""}">${svg(icon)}</button>`;
    const sep = `<span class="ed-sep"></span>`;
    this.el = h(`<div class="editor" role="dialog" aria-label="${esc(this.name)}">
      <div class="ed-bar">
        <button type="button" class="ed-btn wide" data-act="save" title="${t("Salva")} (Ctrl+S)">${svg("save")}<span>${t("Salva")}</span></button>
        ${sep}${btn("undo", "undo", t("Annulla"), "Ctrl+Z")}${btn("redo", "redo", t("Ripeti"), "Ctrl+Y")}
        ${sep}${btn("cut", "cut", t("Taglia"), "Ctrl+X")}${btn("copy", "copy", t("Copia"), "Ctrl+C")}
        ${sep}${btn("find", "search", t("Cerca"), "Ctrl+F")}${btn("prev", "up", t("Risultato precedente"), "Maiusc+F3")}${btn("next", "down", t("Risultato successivo"), "F3")}${btn("line", "hash", t("Vai alla riga"), "Ctrl+L")}
        ${sep}${btn("wrap", "wrap", t("A capo automatico"))}
        <span class="ed-title">${esc(this.name)}</span>
        ${btn("help", "keyboard", t("Tasti"), "Ctrl+G")}${btn("close", "close", t("Chiudi"), "Ctrl+Q")}
      </div>
      <div class="ed-view"></div>
      <div class="ed-status"><span class="l"></span><span class="r"></span></div>
      <div class="ed-info"></div>
    </div>`);
    document.body.append(this.el);
    this.status = this.el.querySelector(".ed-status");
    this.info = this.el.querySelector(".ed-info");

    const run = (fn) => () => (fn(), true);
    const keys = [
      { key: "Mod-s", run: run(() => this.save()), preventDefault: true },
      { key: "Mod-q", run: run(() => this.close()), preventDefault: true },
      { key: "Escape", run: run(() => this.close()) },
      { key: "Mod-f", run: run(() => this.findPrompt()), preventDefault: true },
      { key: "F3", run: run(() => this.findNext(1)), shift: run(() => this.findNext(-1)), preventDefault: true },
      { key: "Mod-n", run: run(() => this.findNext(1)), preventDefault: true },
      { key: "Mod-p", run: run(() => this.findNext(-1)), preventDefault: true },
      { key: "Mod-l", run: run(() => this.linePrompt()), preventDefault: true },
      { key: "Mod-g", run: run(() => this.help()), preventDefault: true },
      { key: "Mod-z", run: undo, preventDefault: true },
      { key: "Mod-y", run: redo, preventDefault: true },
      { key: "Mod-a", run: selectAll, preventDefault: true },
      { key: "Mod-d", run: copyLineDown, preventDefault: true },
      { key: "Mod-k", run: (v) => (this.lineToClipboard(v), deleteLine(v)), preventDefault: true },
      { key: "Mod-c", run: (v) => this.lineToClipboard(v) },
      { key: "Mod-x", run: (v) => this.lineToClipboard(v) && deleteLine(v) },
      { key: "Alt-ArrowUp", run: moveLineUp, preventDefault: true },
      { key: "Alt-ArrowDown", run: moveLineDown, preventDefault: true },
      indentWithTab,
    ];
    this.wrapping = new Compartment();
    this.colors = new Compartment();
    this.type = detect(path, text);
    this.wrap = false;
    this.view = new EditorView({
      parent: this.el.querySelector(".ed-view"),
      state: EditorState.create({
        doc: text,
        extensions: [
          keymap.of(keys),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          history(),
          diffGutter,
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          highlightSpecialChars(),
          highlightTrailingWhitespace(),
          bracketMatching(),
          indentTabs,
          sinceOpen,
          EditorState.tabSize.of(4),
          this.wrapping.of([]),
          this.colors.of([]),
          EditorState.readOnly.of(this.readOnly),
          EditorView.updateListener.of((u) => {
            if (!(u.docChanged || u.selectionSet)) return;
            this.paintStatus();
            // a message goes at the next key or click, as in micro
            if (!this.info.querySelector("input") && !this.asking && !u.transactions.some((tr) => tr.isUserEvent("select.search"))) this.message("");
          }),
        ],
      }),
    });
    this.clean = this.view.state.doc;
    // room for 999 from the start, measured in the gutter's own font:
    // CodeMirror sizes the column by the last line in view, so it would
    // widen while scrolling past line 99
    // (a rule of its own, not a style on the column: CodeMirror rebuilds
    // the gutters when the syntax colours arrive)
    const rule = document.createElement("style");
    this.el.append(rule);
    const fit = () => {
      const col = this.el.querySelector(".cm-lineNumbers");
      if (!col) return;
      const probe = h(`<div class="cm-gutterElement" style="position:absolute;visibility:hidden;height:auto">999</div>`);
      col.append(probe);
      rule.textContent = `.editor .cm-gutter.cm-lineNumbers { min-width: ${Math.ceil(probe.getBoundingClientRect().width)}px; }`;
      probe.remove();
    };
    fit();
    document.fonts?.ready.then(fit);
    this.el.addEventListener("keydown", (e) => e.stopPropagation());
    const acts = {
      save: () => this.save(),
      undo: () => undo(this.view),
      redo: () => redo(this.view),
      cut: () => this.clip("cut"),
      copy: () => this.clip("copy"),
      find: () => this.findPrompt(),
      prev: () => this.findNext(-1),
      next: () => this.findNext(1),
      line: () => this.linePrompt(),
      wrap: () => this.toggleWrap(),
      help: () => this.help(),
      close: () => this.close(),
    };
    this.el.querySelector(".ed-bar").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      acts[b.dataset.act]();
      if (!["find", "line", "close", "save"].includes(b.dataset.act)) this.view.focus();
    });
    // the buttons keep the editor's focus and selection
    this.el.querySelector(".ed-bar").addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
    this.onUnload = (e) => this.modified() && e.preventDefault();
    addEventListener("beforeunload", this.onUnload);
    this.paintStatus();
    if (this.type) {
      injectColors();
      loadSyntax(this.type.name)
        .then((def) => this.view.dispatch({ effects: this.colors.reconfigure(syntaxColors(def)) }))
        .catch(() => {});
    }
    this.message(this.readOnly ? t("Sola lettura: non hai il permesso di scrivere questo file") : t("Ctrl+G: i tasti dell'editor"));
    this.view.focus();
  }

  modified() {
    return !this.view.state.doc.eq(this.clean);
  }

  paintStatus() {
    const s = this.view.state;
    const head = s.selection.main.head;
    const line = s.doc.lineAt(head);
    const col = [...line.text.slice(0, head - line.from)].length + 1;
    this.status.querySelector(".l").textContent = ` ${this.label} ${this.modified() ? "+" : ""}${this.readOnly ? ` [${t("sola lettura")}]` : ""}`;
    const bar = this.el.querySelector(".ed-bar");
    const sel = s.selection.ranges.some((r) => !r.empty);
    bar.querySelector('[data-act="save"]').disabled = this.readOnly || !this.modified();
    bar.querySelector('[data-act="undo"]').disabled = this.readOnly || !undoDepth(s);
    bar.querySelector('[data-act="redo"]').disabled = this.readOnly || !redoDepth(s);
    bar.querySelector('[data-act="cut"]').disabled = this.readOnly;
    bar.querySelector('[data-act="copy"]').title = (sel ? t("Copia") : t("Copia la riga")) + " (Ctrl+C)";
    bar.querySelector('[data-act="prev"]').disabled = bar.querySelector('[data-act="next"]').disabled = !this.query;
    bar.querySelector('[data-act="wrap"]').classList.toggle("on", this.wrap);
    this.status.querySelector(".r").textContent = `${line.number}:${col}  │  ${this.type?.ft || "unknown"}  │  utf-8${this.crlf ? " (dos)" : ""} `;
  }

  /** micro's message line: a note, or nothing. */
  message(text, error = false) {
    this.info.className = "ed-info" + (error ? " err" : "");
    this.info.textContent = text || "";
  }

  /** A question on the message line; resolves the key or the text typed. */
  prompt(label, { value = "", keys = null, onInput = null } = {}) {
    this.asking = true;
    return new Promise((done) => {
      this.info.className = "ed-info";
      this.info.innerHTML = `<span class="p">${esc(label)}</span>${keys ? "" : `<input type="text" spellcheck="false" autocomplete="off">`}`;
      const input = this.info.querySelector("input");
      const finish = (v) => {
        this.asking = false;
        this.info.removeEventListener("keydown", onKey, true);
        this.message("");
        this.view.focus();
        done(v);
      };
      const onKey = (e) => {
        e.stopPropagation();
        if (e.key === "Escape") return e.preventDefault(), finish(null);
        if (keys) {
          const k = e.key.toLowerCase();
          if (keys.includes(k)) e.preventDefault(), finish(k);
          return;
        }
        if (e.key === "Enter") e.preventDefault(), finish({ text: input.value, back: e.shiftKey });
      };
      this.info.addEventListener("keydown", onKey, true);
      if (input) {
        input.value = value;
        input.select();
        if (onInput) input.oninput = () => onInput(input.value);
        input.focus();
      } else {
        this.info.tabIndex = -1;
        this.info.focus();
      }
    });
  }

  lineToClipboard(view) {
    const sel = view.state.selection;
    if (sel.ranges.some((r) => !r.empty)) return false;
    writeClipboard(view.state.doc.lineAt(sel.main.head).text + "\n");
    return true;
  }

  /** Cut or copy for the toolbar: the selection, or the line as micro does. */
  clip(how) {
    const v = this.view;
    if (this.lineToClipboard(v)) {
      if (how === "cut" && !this.readOnly) deleteLine(v);
      return;
    }
    const text = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    writeClipboard(text);
    if (how === "cut" && !this.readOnly) v.dispatch(v.state.replaceSelection(""));
  }

  toggleWrap() {
    this.wrap = !this.wrap;
    this.view.dispatch({ effects: this.wrapping.reconfigure(this.wrap ? EditorView.lineWrapping : []) });
    this.paintStatus();
  }

  async findPrompt() {
    const start = this.view.state.selection.main.from;
    const r = await this.prompt(t("Cerca: "), { value: this.query, onInput: (q) => this.find(q, start, 1) });
    if (r) {
      this.query = r.text;
      this.paintStatus();
      this.findNext(r.back ? -1 : 1);
    }
  }

  /** Selects the next (or previous) match of `query` from `from`, wrapping round. */
  find(query, from, dir) {
    if (!query) return false;
    const doc = this.view.state.doc;
    const norm = (s) => s.toLowerCase();
    const all = (a, b) => {
      const out = [];
      for (const c = new SearchCursor(doc, query, a, b, norm); !c.next().done; ) out.push(c.value);
      return out;
    };
    let m;
    if (dir > 0) m = all(from, doc.length)[0] || all(0, from)[0];
    else m = all(0, from).pop() || all(from, doc.length).pop();
    if (!m) {
      this.message(t("«{q}» non trovato", { q: query }), true);
      return false;
    }
    this.view.dispatch({ selection: EditorSelection.single(m.from, m.to), effects: EditorView.scrollIntoView(m.from, { y: "center" }), userEvent: "select.search" });
    return true;
  }

  findNext(dir) {
    if (!this.query) return this.findPrompt();
    const sel = this.view.state.selection.main;
    this.find(this.query, dir > 0 ? sel.to : sel.from, dir);
  }

  async linePrompt() {
    const r = await this.prompt(t("Vai alla riga: "));
    const n = parseInt(r?.text, 10);
    if (!n) return;
    const doc = this.view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, n)));
    this.view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
  }

  /** The keys, in a small panel under the toolbar: Esc, a click outside or Ctrl+G again closes it. */
  help() {
    if (this.helpEl) return this.closeHelp();
    this.message("");
    const rows = [
      ["Ctrl+S", t("Salva")], ["Ctrl+Q, Esc", t("Chiudi")], ["Ctrl+F", t("Cerca")], ["F3, Maiusc+F3", t("Risultato successivo / precedente")],
      ["Ctrl+L", t("Vai alla riga")], ["Ctrl+Z", t("Annulla")], ["Ctrl+Y", t("Ripeti")], ["Ctrl+C, Ctrl+X", t("Copia, taglia (senza selezione: la riga)")],
      ["Ctrl+V", t("Incolla")], ["Ctrl+D", t("Duplica la riga")], ["Ctrl+K", t("Taglia la riga")], ["Alt+↑, Alt+↓", t("Sposta la riga")],
      ["Tab, Maiusc+Tab", t("Rientra, togli rientro")], ["Ctrl+A", t("Seleziona tutto")],
    ];
    this.helpEl = h(`<div class="ed-help"><div class="ed-help-title">${t("Tasti")}</div><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>`);
    this.el.append(this.helpEl);
    this.offHelp = (e) => {
      if (e.type === "keydown" ? e.key === "Escape" || (e.key === "g" && e.ctrlKey) : !this.helpEl.contains(e.target) && !e.target.closest('[data-act="help"]')) {
        if (e.type === "keydown") e.preventDefault(), e.stopPropagation();
        this.closeHelp();
      }
    };
    addEventListener("keydown", this.offHelp, true);
    addEventListener("mousedown", this.offHelp, true);
  }

  closeHelp() {
    removeEventListener("keydown", this.offHelp, true);
    removeEventListener("mousedown", this.offHelp, true);
    this.helpEl?.remove();
    this.helpEl = null;
    this.view.focus();
  }

  async save(force = false) {
    if (this.readOnly) return this.message(t("Sola lettura: non hai il permesso di scrivere questo file"), true);
    const doc = this.view.state.doc;
    let text = doc.toString();
    if (this.crlf) text = text.replace(/\n/g, "\r\n");
    this.message(t("Salvataggio…"));
    try {
      const r = await api.editSave(this.path, text, this.stamp, force);
      this.stamp = r.stamp;
      this.clean = doc;
      this.saved = true;
      this.view.dispatch({ effects: savedNow.of(null) });
      this.paintStatus();
      this.message(t("Salvato {path}", { path: this.label }));
      return true;
    } catch (e) {
      if (e.status === 409 && !force) {
        const k = await this.prompt(t("{e}. Sovrascriverlo? (s, n)", { e: e.message }), { keys: ["s", "y", "n"] });
        if (k === "s" || k === "y") return this.save(true);
        this.message(t("Non salvato"), true);
        return false;
      }
      this.message(e.message, true);
      return false;
    }
  }

  async close() {
    if (this.modified() && !this.readOnly) {
      const k = await this.prompt(t("Salvare le modifiche a «{n}» prima di chiudere? (s, n, esc)", { n: this.name }), { keys: ["s", "y", "n"] });
      if (!k) return;
      if ((k === "s" || k === "y") && !(await this.save())) return;
    }
    removeEventListener("beforeunload", this.onUnload);
    if (this.helpEl) this.closeHelp();
    this.view.destroy();
    this.el.remove();
    open = null;
    this.resolve(this.saved);
  }
}
