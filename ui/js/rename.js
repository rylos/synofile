// Renaming many items at once: a name made of pieces ([N] the old name,
// [C] a counter, [D] the date…), a search and replace, a case, with every
// new name shown before anything changes.

import { api } from "./api.js";
import { t, tn, count } from "./i18n.js";
import { esc, int, baseName, parentOf, joinPath, isDirLike } from "./format.js";
import { svg } from "./icons.js";
import { dialog, toast, errorToast } from "./ui.js";
import { isRemote } from "./conns.js";
import { moveFolderIcons } from "./iconpick.js";
import { recordRename } from "./undo.js";

let last = { name: "[N]", ext: "[E]", find: "", repl: "", regex: false, matchCase: false, kase: "keep", start: 1, step: 1, digits: 2 };

const pad = (n, d) => String(n).padStart(d, "0");

function splitName(e) {
  const i = e.name.lastIndexOf(".");
  if (isDirLike(e) || i <= 0) return [e.name, ""];
  return [e.name.slice(0, i), e.name.slice(i + 1)];
}

/** Fills a mask: [N] name, [E] extension, [C] counter, [D] date, [T] time, [P] folder; [N2-5] characters 2 to 5. */
function fill(mask, e, i, o) {
  const [stem, ext] = splitName(e);
  const d = new Date(e.mtime * 1000);
  return mask.replace(/\[(N|E|C|D|T|P)(\d+)?(?:-(\d+))?\]/gi, (all, k, a, b) => {
    k = k.toUpperCase();
    let v;
    if (k === "N") v = stem;
    else if (k === "E") v = ext;
    else if (k === "C") v = pad(o.start + i * o.step, o.digits);
    else if (k === "D") v = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
    else if (k === "T") v = `${pad(d.getHours(), 2)}.${pad(d.getMinutes(), 2)}.${pad(d.getSeconds(), 2)}`;
    else v = baseName(parentOf(e.path));
    if (a && (k === "N" || k === "E" || k === "P")) v = [...v].slice(+a - 1, b ? +b : +a).join("");
    return v;
  });
}

function changeCase(s, kase) {
  if (kase === "lower") return s.toLowerCase();
  if (kase === "upper") return s.toUpperCase();
  if (kase === "title") return s.toLowerCase().replace(/(^|[\s._\-([])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
  return s;
}

/** Each item's new name with the options `o`; throws on a broken regular expression. */
export function newNames(list, o) {
  let re = null;
  if (o.find) re = o.regex ? new RegExp(o.find, o.matchCase ? "g" : "gi") : new RegExp(o.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.matchCase ? "g" : "gi");
  return list.map((e, i) => {
    let stem = fill(o.name, e, i, o);
    let ext = isDirLike(e) ? "" : fill(o.ext, e, i, o);
    let name = ext ? `${stem}.${ext}` : stem;
    if (re) name = name.replace(re, o.repl);
    // initials for the name, not for the extension (Report.Pdf)
    const dot = name.lastIndexOf(".");
    if (o.kase === "title" && !isDirLike(e) && dot > 0) return (changeCase(name.slice(0, dot), "title") + name.slice(dot)).trim();
    return changeCase(name, o.kase).trim();
  });
}

/**
 * Renames [old path, new name] pairs: on the NAS one request per folder,
 * swaps included; on a remote server one by one. Resolves the pairs done
 * and the errors.
 */
export async function renameMany(pairs) {
  const done = [];
  const errors = [];
  const byDir = new Map();
  for (const [path, name] of pairs) {
    const dir = parentOf(path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push([path, name]);
  }
  for (const [dir, list] of byDir) {
    if (isRemote(dir)) {
      for (const [path, name] of list) {
        try {
          await api.rename(path, name);
          done.push([path, name]);
        } catch (err) {
          errors.push(`${baseName(path)}: ${err.message}`);
        }
      }
      continue;
    }
    try {
      const { results } = await api.renames(dir, list.map(([p, n]) => [baseName(p), n]));
      for (const r of results) {
        if (r.error) errors.push(`${r.from}: ${r.error}`);
        else done.push([joinPath(dir, r.from), r.to]);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }
  for (const [path, name] of done) moveFolderIcons(path, joinPath(parentOf(path), name));
  return { done, errors };
}

export function batchRename(app, pane, list) {
  const dlg = dialog(`
    <form method="dialog">
      <div class="dlg-head"><div class="dlg-icon">${svg("rename")}</div><h2>${esc(t("Rinomina {n}", { n: count(list.length, "elemento", "elementi", int) }))}</h2></div>
      <div class="dlg-body ren">
        <div class="ren-grid">
          <label class="field"><span>${t("Nome")}</span><input type="text" class="r-name" spellcheck="false" autocomplete="off"></label>
          <label class="field"><span>${t("Estensione")}</span><input type="text" class="r-ext" spellcheck="false" autocomplete="off"></label>
        </div>
        <div class="ren-tokens">${[["[N]", t("nome")], ["[N1-3]", t("caratteri 1–3 del nome")], ["[E]", t("estensione")], ["[C]", t("contatore")], ["[D]", t("data")], ["[T]", t("ora")], ["[P]", t("cartella")]].map(([k, l]) => `<button type="button" class="chip-btn" data-k="${k}" title="${esc(l)}">${k}</button>`).join("")}</div>
        <div class="ren-grid">
          <label class="field"><span>${t("Cerca")}</span><input type="text" class="r-find" spellcheck="false" autocomplete="off"></label>
          <label class="field"><span>${t("Sostituisci con")}</span><input type="text" class="r-repl" spellcheck="false" autocomplete="off"></label>
        </div>
        <div class="ren-row">
          <label class="check"><input type="checkbox" class="r-regex"> ${t("Espressione regolare")}</label>
          <label class="check"><input type="checkbox" class="r-mcase"> ${t("Distingui maiuscole")}</label>
        </div>
        <div class="ren-row">
          <label class="field inline"><span>${t("Maiuscole")}</span><select class="input r-case">
            <option value="keep">${t("come sono")}</option><option value="lower">${t("minuscole")}</option><option value="upper">${t("MAIUSCOLE")}</option><option value="title">${t("Iniziali Maiuscole")}</option></select></label>
          <label class="field inline"><span>${t("Contatore da")}</span><input type="number" class="input r-start" min="0"></label>
          <label class="field inline"><span>${t("passo")}</span><input type="number" class="input r-step" min="1"></label>
          <label class="field inline"><span>${t("cifre")}</span><input type="number" class="input r-digits" min="1" max="9"></label>
        </div>
        <div class="ren-head"><span>${t("Prima")}</span><span></span><span>${t("Dopo")}</span></div>
        <div class="ren-list"></div>
        <div class="hint ren-sum" role="status"></div>
      </div>
      <div class="dlg-foot"><button type="button" class="btn r-reset">${t("Ripristina")}</button><span style="flex:1"></span><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${t("Rinomina")}</button></div>
    </form>`, { wide: true, cls: "rename-dlg" });
  const q = (s) => dlg.querySelector(s);
  const fields = {
    name: q(".r-name"), ext: q(".r-ext"), find: q(".r-find"), repl: q(".r-repl"), regex: q(".r-regex"), matchCase: q(".r-mcase"),
    kase: q(".r-case"), start: q(".r-start"), step: q(".r-step"), digits: q(".r-digits"),
  };
  const put = (o) => {
    for (const [k, el] of Object.entries(fields)) {
      if (el.type === "checkbox") el.checked = !!o[k];
      else el.value = o[k];
    }
  };
  const read = () => {
    const o = {};
    for (const [k, el] of Object.entries(fields)) o[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, +el.value || 0) : el.value;
    o.step = o.step || 1;
    o.digits = Math.min(9, Math.max(1, o.digits || 1));
    return o;
  };
  put(last);
  let focused = fields.name;
  for (const el of [fields.name, fields.ext, fields.find, fields.repl]) el.addEventListener("focus", () => (focused = el));
  dlg.querySelectorAll(".ren-tokens button").forEach((b) => (b.onclick = () => {
    const el = focused === fields.find || focused === fields.repl ? fields.name : focused;
    const [a, z] = [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length];
    el.value = el.value.slice(0, a) + b.dataset.k + el.value.slice(z);
    el.focus();
    el.setSelectionRange(a + b.dataset.k.length, a + b.dataset.k.length);
    update();
  }));
  const listEl = q(".ren-list");
  const sum = q(".ren-sum");
  const ok = q(".btn.primary");
  let plan = [];
  const update = () => {
    let names;
    sum.style.color = "";
    try {
      names = newNames(list, read());
    } catch {
      sum.textContent = t("Espressione regolare non valida");
      sum.style.color = "var(--crit)";
      ok.disabled = true;
      return;
    }
    // what each new name would clash with: another new name, or a name staying in the folder
    const olds = new Set(list.map((e) => e.path));
    const staying = new Set(pane.visible.filter((e) => !olds.has(e.path)).map((e) => `${parentOf(e.path)}/${e.name}`));
    const tally = new Map();
    names.forEach((n, i) => {
      const k = `${parentOf(list[i].path)}/${n}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    });
    const remote = list.some((e) => isRemote(e.path));
    const oldNames = new Set(list.map((e) => `${parentOf(e.path)}/${e.name}`));
    plan = list.map((e, i) => {
      const n = names[i];
      const k = `${parentOf(e.path)}/${n}`;
      let problem = "";
      if (!n || n === "." || n === ".." || n.includes("/")) problem = t("Nome non valido");
      else if (new TextEncoder().encode(n).length > 255) problem = t("Nome troppo lungo");
      else if (tally.get(k) > 1) problem = t("Nome doppio");
      else if (staying.has(k)) problem = t("Esiste già");
      else if (remote && n !== e.name && oldNames.has(k)) problem = t("Su un server remoto i nomi non si scambiano");
      return { e, name: n, problem, same: n === e.name };
    });
    const shown = plan.slice(0, 500);
    listEl.innerHTML = shown.map((p) => `<div class="ren-item ${p.problem ? "bad" : p.same ? "same" : ""}" title="${esc(p.problem)}"><span>${esc(p.e.name)}</span><span>→</span><span>${esc(p.name)}${p.problem ? ` <em>${esc(p.problem)}</em>` : ""}</span></div>`).join("")
      + (plan.length > shown.length ? `<div class="ren-item same"><span>… ${esc(t("e altri {n}", { n: int(plan.length - shown.length) }))}</span></div>` : "");
    const bad = plan.filter((p) => p.problem).length;
    const changing = plan.filter((p) => !p.same && !p.problem).length;
    sum.textContent = bad ? t("{n} da sistemare prima di rinominare", { n: int(bad) }) : changing ? count(changing, "nome cambia", "nomi cambiano", int) : t("Nessun nome cambia");
    if (bad) sum.style.color = "var(--crit)";
    ok.disabled = !!bad || !changing;
  };
  dlg.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", update));
  q(".r-reset").onclick = () => {
    put({ name: "[N]", ext: "[E]", find: "", repl: "", regex: false, matchCase: false, kase: "keep", start: 1, step: 1, digits: 2 });
    update();
  };
  q(".cancel").onclick = () => dlg.close();
  update();
  fields.name.focus();
  fields.name.select();
  q("form").onsubmit = async (ev) => {
    ev.preventDefault();
    if (ok.disabled) return;
    last = read();
    ok.disabled = true;
    const pairs = plan.filter((p) => !p.same).map((p) => [p.e.path, p.name]);
    const { done, errors } = await renameMany(pairs);
    dlg.close();
    if (done.length) recordRename(done, t("Rinomina {n}", { n: count(done.length, "elemento", "elementi", int) }));
    app.refreshFolders([...new Set(pairs.map(([p]) => parentOf(p)))]);
    if (pane.search) pane.reload();
    if (errors.length) errorToast(new Error(tn(errors.length, "{n} non rinominato: {e}", "{n} non rinominati: {e}", { n: int(errors.length), e: errors.slice(0, 3).join("; ") + (errors.length > 3 ? "…" : "") })));
    else toast(count(done.length, "elemento rinominato", "elementi rinominati", int));
  };
}
