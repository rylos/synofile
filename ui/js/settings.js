// The settings dialog: look, list, behaviour, transfers, keys.

import { prefs, save, DEFAULTS } from "./prefs.js";
import { t } from "./i18n.js";
import { svg } from "./icons.js";
import { dialog, $, h, pickFolder } from "./ui.js";
import { esc } from "./format.js";

const SECTIONS = [
  ["look", "palette", "Aspetto"],
  ["list", "list", "Elenco"],
  ["behaviour", "settings", "Comportamento"],
  ["transfers", "transfers", "Trasferimenti"],
  ["keys", "keyboard", "Scorciatoie"],
];

export const KEYS = [
  ["Ctrl+T", "Nuova scheda"], ["Ctrl+W", "Chiudi scheda"], ["Ctrl+Tab / Ctrl+PgGiù", "Scheda successiva"],
  ["Ctrl+Shift+Tab / Ctrl+PgSu", "Scheda precedente"], ["Alt+1…9", "Vai alla scheda"], ["Ctrl+Shift+T", "Riapri scheda chiusa"],
  ["F3", "Doppio pannello"], ["Tab", "Altro pannello (con il doppio pannello)"], ["F5 / F6", "Copia / sposta nell'altro pannello"],
  ["Invio", "Apri"], ["Backspace / Alt+↑", "Cartella superiore"], ["Alt+← / Alt+→", "Indietro / avanti"],
  ["Spazio", "Anteprima rapida"], ["Ctrl+I", "Pannello informazioni"], ["Ctrl+H", "Mostra o nascondi i file nascosti"],
  ["Ctrl+L", "Scrivi un percorso"], ["/", "Filtro fuzzy della cartella"], ["Ctrl+F", "Cerca nelle sottocartelle"],
  ["Ctrl+1 / Ctrl+2", "Elenco / griglia"], ["Ctrl+B", "Barra laterale"], ["Ctrl+R", "Aggiorna"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "Copia / taglia / incolla"], ["Ctrl+A", "Seleziona tutto"], ["Ctrl+Shift+I", "Inverti selezione"],
  ["Insert", "Seleziona e vai avanti"], ["F2", "Rinomina"], ["Ctrl+Shift+N", "Nuova cartella"],
  ["Canc", "Sposta nel cestino"], ["Shift+Canc", "Elimina definitivamente"], ["Ctrl+D", "Aggiungi ai preferiti"],
  ["Ctrl+Shift+C", "Copia percorso"], ["Ctrl+U", "Carica file"], ["Ctrl+J", "Trasferimenti"], ["Ctrl+,", "Impostazioni"],
  ["Lettere", "Salta al nome che inizia così"], ["j k h l, gg, G", "Tasti Vim (se attivi)"],
];

function row(label, hint, control) {
  return `<div class="set-row"><div class="lbl"><span>${t(label)}</span>${hint ? `<small>${t(hint)}</small>` : ""}</div>${control}</div>`;
}
const sw = (key) => `<label class="switch"><input type="checkbox" data-k="${key}" ${getK(key) ? "checked" : ""}><span></span></label>`;
const sel = (key, options) =>
  `<select class="input" data-k="${key}">${options.map(([v, l]) => `<option value="${v}" ${String(getK(key)) === String(v) ? "selected" : ""}>${t(l)}</option>`).join("")}</select>`;

function getK(key) {
  return key.split(".").reduce((o, k) => o?.[k], prefs);
}
function setK(key, value) {
  const parts = key.split(".");
  if (parts.length === 1) return save({ [key]: value });
  const top = { ...prefs[parts[0]], [parts[1]]: value };
  save({ [parts[0]]: top });
}

function body(section) {
  switch (section) {
    case "look":
      return (
        row("Tema", "", sel("theme", [["dark", "Scuro"], ["light", "Chiaro"], ["system", "Come il sistema"]])) +
        row("Icone dei file", "Le icone di eza (Nerd Font), per tipo e per nome", sw("icons")) +
        row("Colori dei nomi", "I colori di eza: cartelle blu, immagini viola, archivi rossi…", sw("colors")) +
        row("Colonne in stile ll", "Permessi, dimensioni e date colorati come in eza -l", sw("llColumns")) +
        row("Dimensione del testo", "", sel("size", [["small", "Piccola"], ["normal", "Normale"], ["large", "Grande"]])) +
        row("Densità delle righe", "", sel("density", [["compact", "Compatta"], ["normal", "Normale"]]))
      );
    case "list":
      return (
        row("Cartelle prima", "Come eza --group-directories-first", sw("foldersFirst")) +
        row("Mostra i file nascosti", "Quelli che iniziano con un punto (Ctrl+H)", sw("showHidden")) +
        row("File nascosti in fondo", "Quando sono visibili, dopo gli altri", sw("hiddenLast")) +
        row("Ricorda vista e ordinamento per cartella", "Altrimenti valgono gli ultimi usati, per tutte", sw("perFolder")) +
        row("Evidenzia le date di oggi", "Nella colonna Modificato", sw("todayHighlight")) +
        row("Dimensioni binarie", "KiB, MiB, GiB (1024) invece di KB, MB, GB (1000)", sw("binarySizes")) +
        row("Date relative", "«3 h fa» invece di «29 ott 21:45»", sw("relativeDates")) +
        row("Colonna Permessi", "", sw("columns.mode")) +
        row("Colonna Dimensione", "", sw("columns.size")) +
        row("Colonna Modificato", "", sw("columns.mtime")) +
        row("Colonna Tipo", "", sw("columns.kind"))
      );
    case "behaviour":
      return (
        row("Apri con un clic", "Altrimenti con il doppio clic", sw("singleClick")) +
        row("Tasti Vim", "j/k per scorrere, h per salire, l per aprire, gg e G", sw("vimKeys")) +
        row("Conferma prima di eliminare", "", sw("confirmDelete")) +
        row("All'avvio apri", "", sel("startIn", [["last", "Le ultime schede"], ["shares", "Cartelle condivise"], ["folder", "La cartella scelta"]])) +
        row("Nuove schede in", "Ctrl+T e il + della barra delle schede", sel("newTabIn", [["current", "Cartella corrente"], ["shares", "Cartelle condivise"], ["folder", "La cartella scelta"]])) +
        row("Cartella scelta", "", `<button class="btn small pick-start">${prefs.startFolder ? `<span style="font-family:var(--mono)">${esc(prefs.startFolder)}</span>` : t("Scegli…")}</button>`)
      );
    case "transfers":
      return (
        row("Se un elemento esiste già", "La scelta di partenza per copie, spostamenti e caricamenti", sel("conflict", [["ask", "Chiedi"], ["rename", "Mantieni entrambi"], ["skip", "Salta"], ["overwrite", "Sovrascrivi"], ["newer", "Sovrascrivi se più recente"]])) +
        row("Verifica dopo la copia", "Rilegge ogni file copiato e lo confronta (xxHash3): più lento, a prova di errore", sw("verify")) +
        row("Limite di velocità", "Si cambia anche durante il trasferimento", sel("limit", [[0, "Nessuno"], [10, "10 MiB/s"], [25, "25 MiB/s"], [50, "50 MiB/s"], [100, "100 MiB/s"], [200, "200 MiB/s"]])) +
        row("Apri il dialogo all'avvio", "Altrimenti il trasferimento parte in background", sw("openDialog")) +
        row("Notifica del browser alla fine", "Quando la pagina non è in primo piano", sw("notify"))
      );
    case "keys":
      return `<table class="keys">${KEYS.map(([k, d]) => `<tr><td>${k.split(" / ").map((x) => x.split("+").map((p) => `<kbd>${t(p)}</kbd>`).join("+")).join(" / ")}</td><td>${t(d)}</td></tr>`).join("")}</table>`;
  }
  return "";
}

const GITHUB_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

/** Version and author, quiet, at the foot of the settings' sections. */
function credits() {
  const version = window.synofile?.version;
  return `<div class="credits">${/^\d/.test(version || "") ? `<div>v${version}</div>` : ""}
    <div class="author">Marco Ziliani<a href="https://github.com/rylos" target="_blank" rel="noopener" title="GitHub">${GITHUB_MARK}</a></div></div>`;
}

export function openSettings(start = "look") {
  const dlg = dialog(`
    <div class="dlg-head"><div class="dlg-icon">${svg("settings")}</div><h2>${t("Impostazioni")}</h2><button class="icon-btn x">${svg("close")}</button></div>
    <div class="settings"><nav>${SECTIONS.map(([k, i, l]) => `<button data-s="${k}">${svg(i)} ${t(l)}</button>`).join("")}${credits()}</nav><section></section></div>
    <div class="dlg-foot"><div class="left"><button class="btn ghost reset">${t("Ripristina predefiniti")}</button></div><button class="btn primary ok">${t("Fatto")}</button></div>`, { wide: true });
  const section = $("section", dlg);
  const show = (s) => {
    dlg.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.s === s));
    section.innerHTML = body(s);
    section.querySelectorAll("[data-k]").forEach((input) => {
      input.onchange = () => {
        const v = input.type === "checkbox" ? input.checked : input.dataset.k === "limit" ? +input.value : input.value;
        setK(input.dataset.k, v);
        if (input.dataset.k === "notify" && v && "Notification" in window) Notification.requestPermission();
      };
    });
    const pick = $(".pick-start", section);
    if (pick) {
      pick.onclick = async () => {
        const path = await pickFolder({ title: t("Cartella scelta"), start: prefs.startFolder || "/", ok: t("Usa questa cartella") });
        if (!path) return;
        save({ startFolder: path });
        show(s);
      };
    }
  };
  dlg.querySelectorAll("nav button").forEach((b) => (b.onclick = () => show(b.dataset.s)));
  $(".x", dlg).onclick = () => dlg.close();
  $(".ok", dlg).onclick = () => dlg.close();
  $(".reset", dlg).onclick = () => {
    const keep = { favorites: prefs.favorites, tabs: prefs.tabs };
    save({ ...structuredClone(DEFAULTS), ...keep });
    show(dlg.querySelector("nav .on")?.dataset.s || "look");
  };
  show(start);
}
