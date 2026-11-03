// The page and the NAS: banners (session, package setup, transfer service),
// a build newer than the page, the chrome index.html may lack, its strings.
// Methods of App (main.js).

import { api, loadToken, DSM_BASE } from "./api.js";
import { t } from "./i18n.js";
import { esc } from "./format.js";
import { svg } from "./icons.js";
import { $, h, toast } from "./ui.js";

export const healthMethods = {
  /**
   * DSM's desktop keeps the loader of the window it opened first, so after
   * an upgrade a page from the old build may run with new scripts: what
   * the scripts need, they make themselves.
   */
  ensureChrome() {
    if (!$("#theme-toggle")) {
      const b = h(`<button class="icon-btn theme-btn" id="theme-toggle"></button>`);
      $("#open-settings")?.before(b);
    }
  },

  /** Inside DSM's window: a button that opens SynoFile in a window of its own. */
  popOutButton() {
    if (window.self === window.top || $("#pop-out")) return;
    const b = h(`<button class="icon-btn theme-btn" id="pop-out"></button>`);
    b.innerHTML = svg("popout");
    b.title = t("Apri in una finestra separata");
    b.onclick = () => {
      const w = Math.min(screen.availWidth, 1400);
      const ht = Math.min(screen.availHeight, 900);
      const win = window.open(location.pathname, "synofile", `popup,width=${w},height=${ht}`);
      if (!win) toast(t("Il browser ha bloccato la finestra: consenti i popup per DSM"), { kind: "error" });
      else win.focus();
    };
    $("#theme-toggle")?.before(b);
  },

  /** The NAS runs another build than this page: load it, once. */
  staleBuild(asset) {
    const mine = new URL(import.meta.url).searchParams.get("v");
    if (!asset || !mine || asset === mine) return false;
    const url = new URL(location.href);
    if (url.searchParams.get("v") === asset) return false;
    url.searchParams.set("v", asset);
    location.replace(url.toString());
    return true;
  },

  checkHealth(me) {
    this.user = me.user || this.user;
    this.version = me.version;
    if (!me.setup) this.banner("setup", `${esc(t("Permessi del pacchetto da attivare, una volta dopo ogni installazione o aggiornamento:"))} <code>sudo /var/packages/synofile/target/bin/synofile setup</code> ${esc(t("poi riavvia SynoFile dal Centro pacchetti."))}`, true);
    else if (!me.daemon) this.banner("daemon", t("Il servizio dei trasferimenti non è attivo: avvia SynoFile dal Centro pacchetti."));
  },

  adminOnly() {
    this.banner("admin", t("SynoFile è riservato agli amministratori di DSM."));
  },

  /**
   * No DSM session (signed out, timed out, the page opened on its own
   * before signing in). Inside DSM's window DSM itself asks to sign in
   * again; on its own the page links to DSM and, back here with a
   * session, starts again.
   */
  needLogin() {
    if (this.embedded) return this.banner("login", t("Sessione DSM scaduta: accedi di nuovo a DSM e riapri SynoFile."));
    const link = `<a href="${esc(DSM_BASE)}" target="_blank" rel="noopener">${esc(t("Accedi a DSM"))}</a>`;
    this.banner("login", `<span>${esc(t("Nessuna sessione DSM: accedi a DSM, poi torna qui."))}</span> ${link}`, true);
    if (this.loginWatch) return;
    let checking = false;
    this.loginWatch = async () => {
      if (document.hidden || checking) return;
      checking = true;
      try {
        if (!(await loadToken())) return;
        // the token alone may be an old one: ask the NAS
        await api.whoami();
        location.reload();
      } catch {
      } finally {
        checking = false;
      }
    };
    addEventListener("focus", this.loginWatch);
    document.addEventListener("visibilitychange", this.loginWatch);
  },

  /** The session came back without a reload (signed in again in time). */
  sessionBack() {
    this.clearBanner("login");
    if (!this.loginWatch) return;
    removeEventListener("focus", this.loginWatch);
    document.removeEventListener("visibilitychange", this.loginWatch);
    this.loginWatch = null;
  },

  /** A message over the panes, one for each `key`: shown again, it replaces the one there. */
  banner(key, html, raw = false) {
    let box = $("#banners");
    if (!box) {
      box = h(`<div class="banners" id="banners"></div>`);
      $(".body").prepend(box);
    }
    const b = h(`<div class="banner" data-key="${esc(key)}">${svg("alert")}<div>${raw ? html : esc(html)}</div></div>`);
    const old = box.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (old) old.replaceWith(b);
    else box.append(b);
  },

  clearBanner(key) {
    $(`#banners [data-key="${CSS.escape(key)}"]`)?.remove();
  },

  /** The strings of index.html, in the interface's language. */
  translateChrome() {
    const set = (sel, fn) => {
      const el = $(sel);
      if (el) fn(el);
    };
    set("#tab-new", (el) => (el.title = `${t("Nuova scheda")} (Ctrl+T)`));
    set("#open-settings", (el) => (el.title = `${t("Impostazioni")} (Ctrl+,)`));
    set("#xfer-btn", (el) => (el.title = t("Trasferimenti")));
    set("#sidebar", (el) => el.setAttribute("aria-label", t("Posizioni")));
    set(".drawer-head > span", (el) => (el.textContent = t("Trasferimenti")));
    set("#xfer-clear", (el) => (el.textContent = t("Pulisci completati")));
    set("#xfer-drawer-close", (el) => (el.title = t("Chiudi")));
    set("#drop-overlay > div", (el) => {
      const target = $("#drop-target") || h(`<b id="drop-target"></b>`);
      el.textContent = t("Rilascia per caricare in") + " ";
      el.append(target);
    });
  },
};
