// The permissions of a shared folder, as in DSM's Control Panel: who may
// read or write it, and the three advanced settings. Through DSM's own
// web API with the user's session (SynoFile is for administrators).

import { dsm } from "./api.js";
import { t } from "./i18n.js";
import { esc } from "./format.js";
import { svg } from "./icons.js";
import { fuzzy, highlight } from "./fuzzy.js";
import { dialog, toast, errorToast } from "./ui.js";

// DSM asks for each kind apart; the ones a NAS lacks (domain, LDAP) fail and are left out
const KINDS = ["local_user", "local_group", "domain_user", "domain_group", "ldap_user", "ldap_group"];
const LEVELS = [
  ["none", "Nessun accesso"],
  ["ro", "Lettura"],
  ["rw", "Lettura e scrittura"],
  ["deny", "Rifiuta"],
];
const ADVANCED = [
  ["disable_list", "Disabilita esplorazione directory"],
  ["disable_modify", "Disabilita modifica di file esistenti"],
  ["disable_download", "Disabilita download del file"],
];

const levelOf = (p) => (p.is_deny ? "deny" : p.is_custom ? "custom" : p.is_writable ? "rw" : p.is_readonly ? "ro" : "none");
const flags = (level) => ({ is_readonly: level === "ro", is_writable: level === "rw", is_deny: level === "deny", is_custom: false });
const isGroup = (kind) => kind.endsWith("_group");

async function load(share) {
  const name = JSON.stringify(share.name);
  const [info, ...lists] = await Promise.all([
    dsm("SYNO.Core.Share", "get", { name, additional: JSON.stringify(["disable_list", "disable_modify", "disable_download", "vol_path"]) }),
    ...KINDS.map((kind) =>
      dsm("SYNO.Core.Share.Permission", "list", { name, user_group_type: JSON.stringify(kind), offset: 0, limit: 5000 })
        .then((d) => (d.items || []).map((p) => ({ kind, name: p.name, level: levelOf(p) })))
        .catch(() => []),
    ),
  ]);
  return { info, all: lists.flat() };
}

/** The permissions dialog of a shared folder. */
export async function sharePermissions(share) {
  let data;
  try {
    data = await load(share);
  } catch (e) {
    return errorToast(new Error(t("Permessi non letti: {e}", { e: e.message })));
  }
  const { info, all } = data;
  all.forEach((p) => (p.was = p.level));
  // listed: whoever has something; the others are found with the search
  const shown = new Set(all.filter((p) => p.level !== "none"));
  const key = (p) => p.kind + "\n" + p.name;
  const anyCustom = all.some((p) => p.was === "custom");

  // a fixed height and two tabs: nothing below moves while searching or choosing
  const dlg = dialog(`
    <form method="dialog">
      <div class="dlg-head"><div class="dlg-icon">${svg("shield")}</div><h2>${esc(t("Permessi di «{x}»", { x: share.name }))}</h2></div>
      <div class="perm-tabs" role="tablist">
        <button type="button" role="tab" data-tab="who" class="on">${esc(t("Utenti e gruppi"))}</button>
        <button type="button" role="tab" data-tab="adv">${esc(t("Impostazioni avanzate"))}</button>
      </div>
      <div class="dlg-body perm-body">
        <div class="perm-pane" data-pane="who">
          <div class="perm-add">
            <span class="perm-search">${svg("search")}<input type="text" placeholder="${esc(t("Aggiungi utente o gruppo: cerca per nome…"))}" spellcheck="false" autocomplete="off" role="combobox" aria-expanded="false"></span>
            <div class="perm-found" role="listbox" hidden></div>
          </div>
          <div class="perm-list"></div>
          ${anyCustom ? `<div class="hint">${esc(t("«Personalizzato»: permessi ACL fatti in File Station, che qui restano come sono."))}</div>` : ""}
        </div>
        <div class="perm-pane" data-pane="adv" hidden>
          <p>${esc(t("Valgono per File Station, FTP e WebDAV, oltre ai permessi qui sopra."))}</p>
          ${ADVANCED.map(([k, l]) => `<label class="check"><input type="checkbox" data-adv="${k}" ${info[k] ? "checked" : ""}> ${esc(t(l))}</label>`).join("")}
        </div>
      </div>
      <div class="dlg-foot"><span class="left hint perm-count"></span><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${t("Salva")}</button></div>
    </form>`, { wide: true, cls: "perm-dlg" });

  const list = dlg.querySelector(".perm-list");
  const search = dlg.querySelector(".perm-add input");
  const found = dlg.querySelector(".perm-found");
  const count = dlg.querySelector(".perm-count");
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const sorted = (ps) => ps.sort((a, b) => isGroup(b.kind) - isGroup(a.kind) || byName(a, b));
  const who = (p, name = esc(p.name)) =>
    `<span class="perm-who" title="${esc((isGroup(p.kind) ? t("Gruppo") : t("Utente")) + ": " + p.name)}">${svg(isGroup(p.kind) ? "users" : "user")}<span>${name}</span></span>`;
  const advNow = () => Object.fromEntries(ADVANCED.map(([k]) => [k, dlg.querySelector(`[data-adv="${k}"]`).checked]));
  const changes = () => all.filter((p) => p.level !== p.was && p.level !== "custom").length + ADVANCED.filter(([k]) => advNow()[k] !== !!info[k]).length;
  const recount = () => {
    const n = changes();
    count.textContent = n ? t("Modifiche da salvare: {n}", { n }) : "";
  };

  // tabs
  dlg.querySelectorAll(".perm-tabs button").forEach((b) => (b.onclick = () => {
    dlg.querySelectorAll(".perm-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    dlg.querySelectorAll(".perm-pane").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
    close();
  }));
  dlg.querySelectorAll("[data-adv]").forEach((c) => (c.onchange = recount));

  // the rows: a segmented choice each, no native drop-down
  function render() {
    const rows = sorted([...shown]);
    list.innerHTML = rows.length
      ? rows.map((p) => {
          const levels = (p.was === "custom" ? [["custom", "Personalizzato"]] : []).concat(LEVELS);
          return `
        <div class="perm-row" data-key="${esc(key(p))}">
          ${who(p)}
          <span class="seg perm-seg" role="radiogroup">${levels.map(([v, l]) => `<button type="button" role="radio" data-v="${v}" class="${v} ${p.level === v ? "on" : ""}" aria-checked="${p.level === v}">${esc(t(l))}</button>`).join("")}</span>
          <button type="button" class="icon-btn perm-del" title="${esc(t("Togli"))}">${svg("x")}</button>
        </div>`;
        }).join("")
      : `<div class="hint perm-empty">${esc(t("Nessun utente o gruppo ha permessi su questa cartella."))}</div>`;
    recount();
  }
  list.onclick = (e) => {
    const row = e.target.closest(".perm-row");
    if (!row) return;
    const p = all.find((x) => key(x) === row.dataset.key);
    const seg = e.target.closest(".perm-seg button");
    if (seg) {
      p.level = seg.dataset.v;
      row.querySelectorAll(".perm-seg button").forEach((b) => {
        b.classList.toggle("on", b === seg);
        b.setAttribute("aria-checked", b === seg);
      });
      recount();
    } else if (e.target.closest(".perm-del")) {
      // away from the list; on saving it gets no access (a custom ACL included)
      p.level = "none";
      shown.delete(p);
      render();
    }
  };

  // fzf-style search among those not listed: on a domain there are hundreds
  let hits = [];
  let cur = 0;
  function open() {
    const q = search.value.trim();
    const rest = all.filter((p) => !shown.has(p));
    hits = (q
      ? rest.map((p) => ({ p, m: fuzzy(q, p.name) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score || byName(a.p, b.p))
      : sorted(rest).map((p) => ({ p, m: null }))
    ).slice(0, 100);
    cur = 0;
    found.innerHTML = hits.length
      ? hits.map(({ p, m }, i) => `<div class="perm-hit ${i === cur ? "cur" : ""}" role="option" data-i="${i}">${who(p, m ? highlight(p.name, m.positions, esc) : esc(p.name))}</div>`).join("")
      : `<div class="hint">${esc(t("Nessun risultato"))}</div>`;
    found.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }
  function close() {
    found.hidden = true;
    search.setAttribute("aria-expanded", "false");
  }
  function move(to) {
    if (!hits.length) return;
    cur = (to + hits.length) % hits.length;
    found.querySelectorAll(".perm-hit").forEach((h, i) => h.classList.toggle("cur", i === cur));
    found.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  }
  function pick(i) {
    const p = hits[i]?.p;
    if (!p) return;
    if (p.level === "none") p.level = "ro";
    shown.add(p);
    search.value = "";
    close();
    render();
    list.querySelector(`.perm-row[data-key="${CSS.escape(key(p))}"]`)?.scrollIntoView({ block: "nearest" });
    search.focus();
  }
  search.oninput = open;
  search.onclick = () => found.hidden && open();
  search.onblur = close;
  found.onmousedown = (e) => e.preventDefault(); // the focus stays in the search
  found.onclick = (e) => {
    const hit = e.target.closest(".perm-hit");
    if (hit) pick(+hit.dataset.i);
  };
  found.onmousemove = (e) => {
    const hit = e.target.closest(".perm-hit");
    if (hit && +hit.dataset.i !== cur) move(+hit.dataset.i);
  };
  search.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (found.hidden) open();
      else move(cur + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault(); // not the dialog's Save
      if (!found.hidden) pick(cur);
    } else if (e.key === "Escape" && (!found.hidden || search.value)) {
      e.preventDefault(); // the list first, the dialog only after
      if (found.hidden) search.value = "";
      close();
    }
  };
  // Escape on a dialog fires "cancel" too: keep it while the list is open
  dlg.addEventListener("cancel", (e) => {
    if (document.activeElement === search && (!found.hidden || search.value)) e.preventDefault();
  });
  render();

  dlg.querySelector(".cancel").onclick = () => dlg.close();
  dlg.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const name = JSON.stringify(share.name);
    const changed = all.filter((p) => p.level !== p.was && p.level !== "custom");
    const adv = advNow();
    const advChanged = ADVANCED.some(([k]) => adv[k] !== !!info[k]);
    if (!changed.length && !advChanged) return dlg.close();
    const btn = dlg.querySelector(".btn.primary");
    btn.disabled = true;
    try {
      for (const kind of KINDS) {
        const ps = changed.filter((p) => p.kind === kind);
        if (ps.length)
          await dsm("SYNO.Core.Share.Permission", "set", {
            name,
            user_group_type: JSON.stringify(kind),
            permissions: JSON.stringify(ps.map((p) => ({ name: p.name, ...flags(p.level) }))),
          });
      }
      if (advChanged)
        await dsm("SYNO.Core.Share", "set", {
          name,
          shareinfo: JSON.stringify({ name: share.name, vol_path: info.vol_path || "/" + share.volume, advanceperm: adv }),
        });
      dlg.close();
      toast(t("Permessi di «{x}» salvati", { x: share.name }), { kind: "ok" });
    } catch (err) {
      btn.disabled = false;
      errorToast(new Error(t("Permessi non salvati: {e}", { e: err.message })));
    }
  };
}
