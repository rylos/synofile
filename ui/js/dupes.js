// The duplicate finder: files alike under a folder, in groups; the copies
// picked go to DSM's Recycle Bin, and one of each group always stays.

import { api } from "./api.js";
import { t, tn, count } from "./i18n.js";
import { esc, int, size, dateTime, joinPath, parentOf, baseName } from "./format.js";
import { svg } from "./icons.js";
import { dialog, toast, errorToast, confirmBox } from "./ui.js";
import * as transfers from "./transfers.js";

const SHOWN = 1000;
let last = { by: "content", min: "1048576" };

export function findDuplicates(app, root) {
  const dlg = dialog(`
    <div class="dlg-head"><div class="dlg-icon">${svg("copy")}</div><h2>${esc(t("Duplicati in «{x}»", { x: baseName(root) || root }))}</h2></div>
    <div class="dlg-body dup">
      <div class="dup-opts">
        <label class="field inline"><span>${t("Confronta")}</span><select class="input d-by">
          <option value="content">${t("il contenuto (sicuro)")}</option><option value="name">${t("nome e dimensione (veloce)")}</option></select></label>
        <label class="field inline"><span>${t("Dimensione minima")}</span><select class="input d-min">
          <option value="1">${t("tutti")}</option><option value="1048576">1 MB</option><option value="10485760">10 MB</option><option value="104857600">100 MB</option><option value="1073741824">1 GB</option></select></label>
        <button class="btn primary d-go">${t("Cerca")}</button>
      </div>
      <div class="dup-prog" hidden><div class="dup-phase" role="status"></div><div class="pbar thin"><div class="fill"></div></div></div>
      <div class="dup-res" hidden>
        <div class="dup-sum"></div><div class="dup-bar"><span class="dup-pick-l">${t("Seleziona")}:</span>
          <button class="btn small" data-pick="old">${t("tutti tranne il più vecchio")}</button>
          <button class="btn small" data-pick="new">${t("tutti tranne il più recente")}</button>
          <button class="btn small" data-pick="short">${t("tutti tranne il percorso più corto")}</button>
          <button class="btn small" data-pick="none">${t("nessuno")}</button></div>
        <div class="dup-list"></div>
      </div>
    </div>
    <div class="dlg-foot"><span class="dup-sel hint"></span><span style="flex:1"></span><button class="btn d-close">${t("Chiudi")}</button><button class="btn danger d-del" disabled>${t("Sposta nel Cestino")}</button></div>`, { wide: true, cls: "dupes-dlg" });
  const q = (s) => dlg.querySelector(s);
  q(".d-by").value = last.by;
  q(".d-min").value = last.min;
  let controller = null;
  let groups = [];
  // by name and size nothing was read: such files are shown, never deleted from here
  let byName = false;
  const picked = new Set();
  dlg.addEventListener("close", () => controller?.abort());
  q(".d-close").onclick = () => dlg.close();

  const full = (rel) => joinPath(root, rel);
  const selBytes = () => groups.reduce((a, g) => a + g.size * g.items.filter((i) => picked.has(i.path)).length, 0);
  const updateFoot = () => {
    q(".dup-sel").textContent = byName ? t("Confrontati solo nome e dimensione: per eliminare, cerca per contenuto") : picked.size ? `${count(picked.size, "selezionato", "selezionati", int)} · ${size(selBytes())}` : "";
    q(".d-del").disabled = byName || !picked.size;
  };
  const render = () => {
    const shown = groups.slice(0, SHOWN);
    q(".dup-list").innerHTML = shown.map((g, gi) => `<div class="dup-group"><div class="dup-gh">${esc(t("{n} copie da {s}", { n: g.items.length, s: size(g.size) }))}</div>
      ${g.items.map((it) => `<label class="dup-item" data-g="${gi}" title="${esc(full(it.path))}"><input type="checkbox" data-p="${esc(it.path)}"${picked.has(it.path) ? " checked" : ""}${byName ? " disabled" : ""}><span class="dup-path">${esc(app.displayPath(full(it.path)))}</span><span class="dup-date">${esc(dateTime(it.mtime))}</span><button type="button" class="icon-btn dup-show" title="${t("Mostra nella cartella")}" aria-label="${t("Mostra nella cartella")}">${svg("forward")}</button></label>`).join("")}</div>`).join("")
      + (groups.length > SHOWN ? `<div class="hint">${esc(t("e altri {n}", { n: int(groups.length - SHOWN) }))}</div>` : "");
    updateFoot();
  };
  q(".dup-list").addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox]");
    if (!box) return;
    const g = groups[+box.closest(".dup-item").dataset.g];
    if (box.checked && g.items.every((i) => i.path === box.dataset.p || picked.has(i.path))) {
      // one of each group stays
      box.checked = false;
      return toast(t("Una copia di ogni gruppo resta"));
    }
    if (box.checked) picked.add(box.dataset.p);
    else picked.delete(box.dataset.p);
    updateFoot();
  });
  q(".dup-list").addEventListener("click", (e) => {
    const b = e.target.closest(".dup-show");
    if (!b) return;
    e.preventDefault();
    const p = full(b.closest(".dup-item").querySelector("input").dataset.p);
    dlg.close();
    app.pane.go(parentOf(p), { select: p });
  });
  dlg.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => {
    picked.clear();
    if (b.dataset.pick !== "none") {
      // only the groups on screen: nothing unseen is picked
      for (const g of groups.slice(0, SHOWN)) {
        const keep = [...g.items].sort((a, c) => (b.dataset.pick === "old" ? a.mtime - c.mtime : b.dataset.pick === "new" ? c.mtime - a.mtime : a.path.length - c.path.length || a.path.localeCompare(c.path)))[0];
        for (const it of g.items) if (it !== keep) picked.add(it.path);
      }
    }
    render();
  }));
  q(".d-del").onclick = async () => {
    const list = [...picked];
    // a shared folder without a recycle bin would lose them for good: said so
    let bin = false;
    try {
      bin = !!(await api.list(root)).recycle;
    } catch (err) {
      return errorToast(err);
    }
    const n = count(list.length, "elemento", "elementi", int);
    const ok = await confirmBox({
      title: bin ? t("Spostare nel Cestino?") : t("Eliminare definitivamente?"),
      message: bin
        ? tn(list.length, "{n} finirà nel Cestino di DSM della cartella condivisa, da dove si può recuperare.", "{n} finiranno nel Cestino di DSM della cartella condivisa, da dove si possono recuperare.", { n })
        : `<b style="color:var(--crit)">${tn(list.length, "{n} verrà eliminato per sempre: non si può recuperare.", "{n} verranno eliminati per sempre: non si possono recuperare.", { n })}</b><br>${t("Il Cestino di questa cartella condivisa è disattivato.")}`,
      items: list.map((p) => esc(p)),
      ok: bin ? t("Sposta nel Cestino") : t("Elimina"),
      danger: !bin,
      icon: "trash",
    });
    if (!ok) return;
    dlg.close();
    transfers.start({ op: "delete", sources: list.map(full), permanent: !bin });
  };

  q(".d-go").onclick = async () => {
    last = { by: q(".d-by").value, min: q(".d-min").value };
    controller?.abort();
    controller = new AbortController();
    const mine = controller;
    groups = [];
    picked.clear();
    q(".dup-res").hidden = true;
    q(".dup-prog").hidden = false;
    q(".d-go").disabled = true;
    const bar = q(".dup-prog .pbar");
    const phase = q(".dup-phase");
    bar.classList.add("indeterminate");
    phase.textContent = t("Lettura delle cartelle…");
    let result = null;
    try {
      await api.duplicates(root, last.by, last.min, (line) => {
        if (line.phase === "scan") phase.textContent = t("Lettura delle cartelle: {n} file", { n: int(line.files) });
        if (line.phase === "hash") {
          bar.classList.remove("indeterminate");
          bar.style.setProperty("--p", `${line.total ? (line.done / line.total) * 100 : 0}%`);
          phase.textContent = t("Confronto del contenuto: {a} di {b}", { a: size(line.done), b: size(line.total) });
        }
        if (line.groups) result = line;
        if (line.error) throw new Error(line.error);
      }, mine.signal);
      if (!result) throw new Error(t("risposta incompleta"));
    } catch (err) {
      if (!mine.signal.aborted) errorToast(err);
      result = null;
    } finally {
      if (controller === mine) {
        q(".dup-prog").hidden = true;
        q(".d-go").disabled = false;
      }
    }
    if (!result || !dlg.open) return;
    groups = result.groups;
    byName = last.by === "name";
    const wasted = groups.reduce((a, g) => a + g.size * (g.items.length - 1), 0);
    q(".dup-res").hidden = false;
    q(".dup-sum").textContent = groups.length
      ? t("{g} tra {n} file · {s} recuperabili", { g: count(groups.length, "gruppo", "gruppi", int), n: int(result.scanned), s: size(wasted) }) + (result.more ? " · " + t("solo i gruppi più grandi") : "")
      : t("Nessun duplicato tra {n} file", { n: int(result.scanned) });
    dlg.querySelectorAll("[data-pick]").forEach((b) => (b.disabled = !groups.length || byName));
    render();
  };
}
