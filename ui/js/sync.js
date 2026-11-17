// Synchronizing the folders of the two panes: the
// two trees compared on the NAS, every difference shown with what will be
// done about it, and only then the copies (and, for a mirror, the
// removals, into DSM's Recycle Bin).

import { api } from "./api.js";
import { t, tn, count } from "./i18n.js";
import { esc, int, size, dateTime, joinPath } from "./format.js";
import { svg } from "./icons.js";
import { dialog, errorToast, confirmBox, toast } from "./ui.js";
import * as transfers from "./transfers.js";

let lastMode = "update";

/**
 * Whether an action starts ticked: a mirror would also put an older file
 * over a newer one, or over one of another size with the same date; it
 * offers those, the user ticks them.
 */
export function ticked(d, mode) {
  return !!action(d, mode) && !(mode === "mirror" && (d.what === "newer_b" || d.what === "size"));
}

/** What a mode does with a difference: "a2b", "b2a", "del" (from b), or "" (left alone, a conflict). */
export function action(d, mode) {
  // a side that could not be read decides nothing: above all, no deletion
  if (d.what === "kind" || d.what === "unreadable") return "";
  if (mode === "update") return d.what === "a" || d.what === "newer_a" ? "a2b" : "";
  if (mode === "mirror") return d.what === "b" ? "del" : "a2b";
  // both ways: the newer wins; same date and another size is for the user to decide
  if (d.what === "a" || d.what === "newer_a") return "a2b";
  if (d.what === "b" || d.what === "newer_b") return "b2a";
  return "";
}

export function syncFolders(app, paneA, paneB) {
  let a = paneA.path;
  let b = paneB.path;
  let bRecycle = paneB.recycle;
  const dlg = dialog(`
    <div class="dlg-head"><div class="dlg-icon">${svg("refresh")}</div><h2>${t("Sincronizza le cartelle")}</h2></div>
    <div class="dlg-body sync">
      <div class="sync-ends"><span class="s-a"></span><button type="button" class="icon-btn s-swap" title="${t("Scambia")}" aria-label="${t("Scambia")}">${svg("swap")}</button><span class="s-b"></span></div>
      <div class="sync-opts">
        <div class="seg s-mode" role="radiogroup">
          <button type="button" data-m="update" title="${t("Copia a destra quello che a sinistra è nuovo o più recente")}">${t("Aggiorna →")}</button>
          <button type="button" data-m="mirror" title="${t("Rende la destra uguale alla sinistra: quello che a destra c'è in più va nel Cestino")}">${t("Specchio →")}</button>
          <button type="button" data-m="both" title="${t("Copia in tutte e due le direzioni: vince il più recente")}">${t("Entrambe ↔")}</button>
        </div>
        <button class="btn primary s-go">${t("Confronta")}</button>
      </div>
      <div class="sync-prog hint" role="status" hidden></div>
      <div class="sync-res" hidden><div class="sync-sum"></div><div class="sync-list"></div></div>
    </div>
    <div class="dlg-foot"><span class="sync-sel hint"></span><span style="flex:1"></span><button class="btn s-close">${t("Chiudi")}</button><button class="btn primary s-run" disabled>${t("Sincronizza")}</button></div>`, { wide: true, cls: "sync-dlg" });
  const q = (s) => dlg.querySelector(s);
  let mode = lastMode;
  let diffs = [];
  let plan = [];
  let controller = null;
  dlg.addEventListener("close", () => controller?.abort());
  q(".s-close").onclick = () => dlg.close();
  const ends = () => {
    q(".s-a").textContent = app.displayPath(a);
    q(".s-b").textContent = app.displayPath(b);
  };
  ends();
  const setMode = (m) => {
    mode = m;
    dlg.querySelectorAll(".s-mode button").forEach((x) => {
      x.classList.toggle("on", x.dataset.m === m);
      x.setAttribute("role", "radio");
      x.setAttribute("aria-checked", String(x.dataset.m === m));
    });
    if (diffs.length) build();
  };
  dlg.querySelectorAll(".s-mode button").forEach((x) => (x.onclick = () => setMode(x.dataset.m)));
  setMode(mode);
  q(".s-swap").onclick = () => {
    [a, b] = [b, a];
    bRecycle = (a === paneA.path ? paneB : paneA).recycle;
    ends();
    diffs = [];
    q(".sync-res").hidden = true;
    q(".s-run").disabled = true;
    q(".sync-sel").textContent = "";
  };

  const ARROW = { a2b: svg("arrowRight"), b2a: svg("arrowLeft"), del: svg("trash"), "": "·" };
  const WHAT = {
    a: t("solo a sinistra"), b: t("solo a destra"), newer_a: t("più recente a sinistra"), newer_b: t("più recente a destra"),
    size: t("stessa data, dimensione diversa"), kind: t("file da una parte, cartella dall'altra"),
    unreadable: t("non leggibile: non si decide niente"),
  };
  const side = (s, dir) => (s ? `${dir ? t("cartella") : size(s.size)} · ${dateTime(s.mtime)}` : "—");
  const updateFoot = () => {
    const on = plan.filter((p) => p.on);
    const n = (k) => on.filter((p) => p.act === k).length;
    const parts = [];
    if (n("a2b")) parts.push(t("{n} da copiare a destra", { n: int(n("a2b")) }));
    if (n("b2a")) parts.push(t("{n} da copiare a sinistra", { n: int(n("b2a")) }));
    if (n("del")) parts.push(t("{n} da togliere a destra", { n: int(n("del")) }));
    q(".sync-sel").textContent = parts.join(" · ");
    q(".s-run").disabled = !on.length;
  };
  const build = () => {
    plan = diffs.map((d) => ({ d, act: action(d, mode), on: ticked(d, mode) }));
    const shown = plan.slice(0, 2000);
    q(".sync-list").innerHTML = shown.map((p, i) => `<label class="sync-item act-${p.act || "none"}" title="${esc(WHAT[p.d.what])}">
        <input type="checkbox" data-i="${i}"${p.on ? " checked" : ""}${p.act ? "" : " disabled"}>
        <span class="sync-arrow" title="${esc(p.act === "a2b" ? t("copia a destra") : p.act === "b2a" ? t("copia a sinistra") : p.act === "del" ? t("nel Cestino") : WHAT[p.d.what])}">${ARROW[p.act]}</span>
        <span class="sync-path" title="${esc(p.d.path)}">${esc(p.d.path)}${p.d.dir ? "/" : ""}</span>
        <span class="sync-side">${esc(side(p.d.a, p.d.dir))}</span><span class="sync-side">${esc(side(p.d.b, p.d.dir))}</span></label>`).join("")
      + (plan.length > shown.length ? `<div class="hint">${esc(t("e altri {n}", { n: int(plan.length - shown.length) }))}</div>` : "");
    updateFoot();
  };
  q(".sync-list").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-i]");
    if (!box) return;
    plan[+box.dataset.i].on = box.checked;
    updateFoot();
  });

  q(".s-go").onclick = async () => {
    lastMode = mode;
    controller?.abort();
    const mine = (controller = new AbortController());
    q(".sync-res").hidden = true;
    q(".s-run").disabled = true;
    const prog = q(".sync-prog");
    prog.hidden = false;
    prog.textContent = t("Confronto in corso…");
    q(".s-go").disabled = true;
    let result = null;
    try {
      await api.compare(a, b, (line) => {
        if (line.folders && !line.diffs) prog.textContent = t("Confronto in corso: {n} cartelle", { n: int(line.folders) });
        if (line.diffs) result = line;
        if (line.error) throw new Error(line.error);
      }, mine.signal);
      if (!result) throw new Error(t("risposta incompleta"));
    } catch (err) {
      if (!mine.signal.aborted) errorToast(err);
      result = null;
    } finally {
      if (controller === mine) {
        prog.hidden = true;
        q(".s-go").disabled = false;
      }
    }
    if (!result || !dlg.open) return;
    diffs = result.diffs;
    q(".sync-res").hidden = false;
    q(".sync-sum").textContent = diffs.length
      ? count(diffs.length, "differenza", "differenze", int) + (result.more ? " · " + t("solo le prime") : "") + (result.skipped ? " · " + t("{n} nomi non UTF-8 esclusi", { n: int(result.skipped) }) : "")
      : t("Le due cartelle sono uguali");
    build();
  };

  q(".s-run").onclick = async () => {
    const on = plan.filter((p) => p.on);
    const pick = (k) => on.filter((p) => p.act === k).map((p) => p.d.path);
    // each side as compared: the NAS skips what changed since
    const seen = (s) => (s ? { size: s.size, mtime: s.mtime } : null);
    const expect = (k, flip) => on.filter((p) => p.act === k).map((p) => ({ src: seen(flip ? p.d.b : p.d.a), dst: seen(flip ? p.d.a : p.d.b) }));
    const toB = pick("a2b");
    const toA = pick("b2a");
    const del = pick("del");
    if (del.length) {
      const ok = await confirmBox({
        title: bRecycle ? t("Spostare nel Cestino?") : t("Eliminare definitivamente?"),
        message: bRecycle
          ? tn(del.length, "{n} che a sinistra non c'è finirà nel Cestino di DSM della cartella di destra.", "{n} che a sinistra non ci sono finiranno nel Cestino di DSM della cartella di destra.", { n: count(del.length, "elemento", "elementi", int) })
          : `<b style="color:var(--crit)">${tn(del.length, "{n} verrà eliminato per sempre: non si può recuperare.", "{n} verranno eliminati per sempre: non si possono recuperare.", { n: count(del.length, "elemento", "elementi", int) })}</b><br>${t("Il Cestino di questa cartella condivisa è disattivato.")}`,
        items: del.map(esc),
        ok: bRecycle ? t("Sposta nel Cestino") : t("Elimina"),
        danger: !bRecycle,
        icon: "trash",
      });
      if (!ok) return;
    }
    dlg.close();
    if (toB.length) await transfers.start({ op: "sync", sources: [a], dest: b, members: toB, expect: expect("a2b", false), conflict: "overwrite" });
    if (toA.length) await transfers.start({ op: "sync", sources: [b], dest: a, members: toA, expect: expect("b2a", true), conflict: "overwrite" });
    if (del.length) await transfers.start({ op: "delete", sources: del.map((p) => joinPath(b, p)), permanent: !bRecycle });
    if (!toB.length && !toA.length && !del.length) toast(t("Niente da fare"));
  };
}
