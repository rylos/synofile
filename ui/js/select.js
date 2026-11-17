// Selecting by a pattern, and the differences between the two panes.

import { t, count } from "./i18n.js";
import { int, isDirLike, esc, parentOf } from "./format.js";
import { svg } from "./icons.js";
import { dialog, toast } from "./ui.js";

let last = { text: "", regex: false, files: false };

/**
 * A test for names: wildcards (`*`, `?`, `[abc]`), several separated by `;`,
 * or one regular expression; case is ignored. Null when the text is empty;
 * throws on a broken regular expression.
 */
export function matcher(text, regex) {
  text = text.trim();
  if (!text) return null;
  if (regex) {
    const re = new RegExp(text, "i");
    return (name) => re.test(name);
  }
  const parts = text.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
    let src = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*") src += ".*";
      else if (c === "?") src += ".";
      else if (c === "[") {
        const end = p.indexOf("]", i + 2);
        if (end < 0) src += "\\[";
        else {
          const body = p.slice(i + 1, end).replace(/\\/g, "\\\\");
          src += "[" + (body[0] === "!" ? "^" + body.slice(1) : body) + "]";
          i = end;
        }
      } else src += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
    }
    return new RegExp(`^${src}$`, "i");
  });
  return (name) => parts.some((re) => re.test(name));
}

/** "add" the matches to the selection, "remove" them, or "only" them. */
export function selectByPattern(pane, mode = "add") {
  const dlg = dialog(`
    <form method="dialog">
      <div class="dlg-head"><div class="dlg-icon">${svg("filter")}</div><h2>${esc(mode === "remove" ? t("Deseleziona per modello") : t("Seleziona per modello"))}</h2></div>
      <div class="dlg-body">
        <label class="field"><span>${esc(t("Modello"))}</span><input type="text" class="pat" value="${esc(last.text)}" placeholder="*.mkv; *.srt" spellcheck="false" autocomplete="off"></label>
        <div class="hint">${esc(t("* qualsiasi testo, ? un carattere, [abc] uno di questi; più modelli separati da ;"))}</div>
        <label class="check"><input type="checkbox" class="re" ${last.regex ? "checked" : ""}> ${esc(t("Espressione regolare"))}</label>
        <label class="check"><input type="checkbox" class="files" ${last.files ? "checked" : ""}> ${esc(t("Solo file, non cartelle"))}</label>
        <div class="seg sel-mode" role="radiogroup">
          <button type="button" data-m="add">${esc(t("Aggiungi"))}</button><button type="button" data-m="only">${esc(t("Solo questi"))}</button><button type="button" data-m="remove">${esc(t("Togli"))}</button>
        </div>
        <div class="hint found" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${t("Seleziona")}</button></div>
    </form>`, { cls: "select-dlg" });
  const pat = dlg.querySelector(".pat");
  const re = dlg.querySelector(".re");
  const files = dlg.querySelector(".files");
  const found = dlg.querySelector(".found");
  const ok = dlg.querySelector(".btn.primary");
  const setMode = (m) => {
    mode = m;
    dlg.querySelectorAll(".sel-mode button").forEach((b) => {
      b.classList.toggle("on", b.dataset.m === m);
      b.setAttribute("aria-checked", String(b.dataset.m === m));
      b.setAttribute("role", "radio");
    });
    ok.textContent = m === "remove" ? t("Deseleziona") : t("Seleziona");
  };
  dlg.querySelectorAll(".sel-mode button").forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
  setMode(mode);
  let test = null;
  const update = () => {
    found.style.color = "";
    try {
      test = matcher(pat.value, re.checked);
    } catch {
      test = null;
      found.textContent = t("Espressione regolare non valida");
      found.style.color = "var(--crit)";
      ok.disabled = true;
      return;
    }
    const n = test ? pane.visible.filter((e) => (!files.checked || !isDirLike(e)) && test(e.name)).length : 0;
    found.textContent = test ? count(n, "elemento corrisponde", "elementi corrispondono", int) : "";
    ok.disabled = !test;
  };
  pat.oninput = re.onchange = files.onchange = update;
  update();
  pat.focus();
  pat.select();
  dlg.querySelector(".cancel").onclick = () => dlg.close();
  dlg.querySelector("form").onsubmit = () => {
    if (!test) return;
    last = { text: pat.value, regex: re.checked, files: files.checked };
    const hit = pane.visible.filter((e) => (!files.checked || !isDirLike(e)) && test(e.name)).map((e) => e.path);
    if (mode === "only") pane.sel = new Set(hit);
    else if (mode === "add") hit.forEach((p) => pane.sel.add(p));
    else hit.forEach((p) => pane.sel.delete(p));
    pane.render();
    pane.app.selectionChanged(pane);
  };
}

/**
 * In both panes, selects what the other has not, or has different: a file
 * of another size or date (two seconds of slack, as SMB keeps), a folder
 * only when missing. Returns how many were selected on each side.
 */
export function selectDifferences(a, b) {
  // the items of the folder shown, not those of folders opened inside it
  const top = (pane) => pane.visible.filter((e) => parentOf(e.path) === pane.path);
  const index = (pane) => new Map(top(pane).map((e) => [e.name.toLowerCase(), e]));
  const ia = index(a);
  const ib = index(b);
  const differs = (e, other) => {
    if (!other) return true;
    if (isDirLike(e) !== isDirLike(other)) return true;
    if (isDirLike(e)) return false;
    return e.size !== other.size || Math.abs(e.mtime - other.mtime) > 2;
  };
  const pick = (pane, mine, theirs) => {
    pane.sel = new Set(top(pane).filter((e) => differs(e, theirs.get(e.name.toLowerCase()))).map((e) => e.path));
    pane.render();
    pane.app.selectionChanged(pane);
    return pane.sel.size;
  };
  const na = pick(a, ia, ib);
  const nb = pick(b, ib, ia);
  toast(na + nb ? t("Differenze: {a} a sinistra, {b} a destra", { a: int(na), b: int(nb) }) : t("Le due cartelle hanno gli stessi elementi"));
  return [na, nb];
}
