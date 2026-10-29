// Small pieces of interface shared by everything: toasts, the context
// menu, modal dialogs and the folder picker.

import { esc } from "./format.js";
import { svg, FOLDER_GLYPH, shareGlyph } from "./icons.js";
import { t } from "./i18n.js";
import { api } from "./api.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

// ---- toasts ----
export function toast(message, { kind = "info", action, onAction, timeout = 4200 } = {}) {
  const icon = kind === "error" ? "alert" : kind === "ok" ? "check" : "info";
  const el = h(`<div class="toast ${kind}">${svg(icon)}<span class="msg">${esc(message)}</span>${action ? `<button>${esc(action)}</button>` : ""}</div>`);
  $("#toasts").append(el);
  const close = () => el.remove();
  if (action) el.querySelector("button").onclick = () => {
    close();
    onAction?.();
  };
  setTimeout(close, timeout);
  return close;
}

export function errorToast(e) {
  toast(e?.message || String(e), { kind: "error", timeout: 6500 });
}

// ---- context menu ----
let menuClose = null;

/** items: {label, icon, key, action, danger, disabled} | "-" | {title} */
export function openMenu(x, y, items) {
  closeMenu();
  const menu = $("#menu");
  menu.innerHTML = "";
  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item === "-") {
      menu.append(document.createElement("hr"));
      continue;
    }
    if (item.title) {
      menu.append(h(`<div class="mlabel">${esc(item.title)}</div>`));
      continue;
    }
    const b = h(
      `<button class="${item.danger ? "danger" : ""}" ${item.disabled ? "disabled" : ""}>${item.icon ? svg(item.icon) : '<span style="width:16px"></span>'}<span>${esc(item.label)}</span>${item.key ? `<span class="k">${esc(item.key)}</span>` : ""}</button>`,
    );
    b.onclick = () => {
      closeMenu();
      item.action?.();
    };
    menu.append(b);
    buttons.push(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + "px";
  menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + "px";
  let hot = -1;
  const onKey = (e) => {
    if (e.key === "Escape") return closeMenu(), e.preventDefault();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      hot = (hot + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons.forEach((b, i) => b.classList.toggle("hot", i === hot));
    }
    if (e.key === "Enter" && hot >= 0) {
      e.preventDefault();
      buttons[hot].click();
    }
    e.stopPropagation();
  };
  const onDown = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  menuClose = () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    menu.hidden = true;
  };
}

export function closeMenu() {
  menuClose?.();
  menuClose = null;
}

// ---- dialogs ----
export function dialog(html, { wide = false, cls = "" } = {}) {
  const dlg = h(`<dialog class="dlg ${wide ? "wide" : ""} ${cls}">${html}</dialog>`);
  document.body.append(dlg);
  dlg.addEventListener("close", () => setTimeout(() => dlg.remove(), 50));
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();
  return dlg;
}

export function confirmBox({ title, message, items = [], ok = t("OK"), danger = false, icon = "alert", extra = "" }) {
  return new Promise((resolve) => {
    const list = items.length
      ? `<div class="item-list">${items.slice(0, 50).map((i) => `<div>${i}</div>`).join("")}${items.length > 50 ? `<div>… ${t("e altri {n}", { n: items.length - 50 })}</div>` : ""}</div>`
      : "";
    const dlg = dialog(`
      <div class="dlg-head"><div class="dlg-icon ${danger ? "danger" : ""}">${svg(icon)}</div><h2>${esc(title)}</h2></div>
      <div class="dlg-body"><p>${message}</p>${list}${extra}</div>
      <div class="dlg-foot"><button class="btn" value="no">${t("Annulla")}</button><button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(ok)}</button></div>`);
    let result = false;
    dlg.querySelectorAll(".dlg-foot button").forEach((b) => (b.onclick = () => {
      result = b.value === "ok";
      dlg.close();
    }));
    dlg.addEventListener("close", () => resolve(result ? dlg : null));
    dlg.querySelector(".dlg-foot .btn:last-child").focus();
  });
}

export function promptBox({ title, label, value = "", ok = t("OK"), select, icon = "rename", validate }) {
  return new Promise((resolve) => {
    const dlg = dialog(`
      <form method="dialog">
        <div class="dlg-head"><div class="dlg-icon">${svg(icon)}</div><h2>${esc(title)}</h2></div>
        <div class="dlg-body"><label class="field"><span>${esc(label)}</span><input type="text" value="${esc(value)}" spellcheck="false" autocomplete="off"></label><div class="hint err"></div></div>
        <div class="dlg-foot"><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${esc(ok)}</button></div>
      </form>`);
    const input = dlg.querySelector("input");
    const err = dlg.querySelector(".err");
    let result = null;
    input.focus();
    if (select) input.setSelectionRange(...select(value));
    else input.select();
    dlg.querySelector(".cancel").onclick = () => dlg.close();
    dlg.querySelector("form").onsubmit = (e) => {
      const v = input.value;
      const problem = validate?.(v);
      if (problem) {
        e.preventDefault();
        err.textContent = problem;
        err.style.color = "var(--crit)";
        return;
      }
      result = v;
    };
    dlg.addEventListener("close", () => resolve(result));
  });
}

/** Lets the user choose a folder on the NAS: resolves its path or null. */
export function pickFolder({ title, start, ok }) {
  return new Promise((resolve) => {
    const dlg = dialog(`
      <div class="dlg-head"><div class="dlg-icon">${svg("move")}</div><h2>${esc(title)}</h2></div>
      <div class="dlg-body">
        <div class="picker"><div class="picker-path"></div><div class="picker-list"></div></div>
        <div class="row-actions" style="margin-top:8px"><button class="btn small mk">${svg("folderPlus")} ${t("Nuova cartella")}</button></div>
      </div>
      <div class="dlg-foot"><button class="btn cancel">${t("Annulla")}</button><button class="btn primary ok">${esc(ok)}</button></div>`, { wide: true });
    let current = start && start !== "/" ? start : "/";
    let result = null;
    const pathEl = dlg.querySelector(".picker-path");
    const list = dlg.querySelector(".picker-list");
    const okBtn = dlg.querySelector(".ok");
    async function go(path) {
      current = path;
      okBtn.disabled = path === "/";
      dlg.querySelector(".mk").disabled = path === "/";
      pathEl.innerHTML = `${svg("drive")} ${esc(path === "/" ? t("Cartelle condivise") : path)}`;
      list.innerHTML = `<div class="hint" style="padding:8px">${t("Caricamento…")}</div>`;
      try {
        let rows = [];
        if (path === "/") {
          const { shares } = await api.shares();
          rows = shares.filter((s) => s.writable).map((s) => ({ name: s.name, path: "/" + s.name, glyph: shareGlyph(s.name) }));
        } else {
          const { entries } = await api.list(path);
          rows = entries
            .filter((e) => e.kind === "d" || e.link_dir)
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
            .map((e) => ({ name: e.name, path: path + "/" + e.name, glyph: FOLDER_GLYPH }));
          rows.unshift({ name: "..", path: path.split("/").slice(0, -1).join("/") || "/", glyph: "" });
        }
        list.innerHTML = "";
        for (const r of rows) {
          const b = h(`<button><i class="gi ez-dir">${r.glyph}</i><span>${esc(r.name)}</span></button>`);
          b.ondblclick = () => go(r.path);
          b.onclick = () => go(r.path);
          list.append(b);
        }
        if (!rows.length) list.innerHTML = `<div class="hint" style="padding:8px">${t("Nessuna sottocartella")}</div>`;
      } catch (e) {
        list.innerHTML = `<div class="hint" style="padding:8px;color:var(--crit)">${esc(e.message)}</div>`;
      }
    }
    dlg.querySelector(".mk").onclick = async () => {
      const name = await promptBox({ title: t("Nuova cartella"), label: t("Nome"), value: t("Nuova cartella"), icon: "folderPlus" });
      if (!name) return;
      try {
        await api.mkdir(current, name);
        go(current + "/" + name);
      } catch (e) {
        errorToast(e);
      }
    };
    dlg.querySelector(".cancel").onclick = () => dlg.close();
    okBtn.onclick = () => {
      result = current;
      dlg.close();
    };
    dlg.addEventListener("close", () => resolve(result));
    go(current);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h(`<textarea style="position:fixed;opacity:0"></textarea>`);
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(t("Copiato negli appunti"), { kind: "ok", timeout: 1800 });
}
