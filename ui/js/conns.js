// Remote connections: SMB and SFTP servers in the sidebar, under names of
// the user's choice. A connection's folders are the paths "/:<id>/…".

import { api } from "./api.js";
import { t } from "./i18n.js";
import { esc } from "./format.js";
import { svg } from "./icons.js";
import { dialog, copyText, toast } from "./ui.js";

export const isRemote = (path) => typeof path === "string" && path.startsWith("/:");

/** The connection id of a remote path, or "". */
export const connId = (path) => (isRemote(path) ? path.slice(2).split("/")[0] : "");

/**
 * A server address as people write it: \\srv03\share\folder, //srv03/share,
 * smb://user@srv03/share, sftp://user@host:2222/path, or a bare host.
 */
export function parseAddress(text) {
  let v = (text || "").trim();
  if (!v) return null;
  let kind = null;
  const scheme = v.match(/^(smb|cifs|sftp|ssh):\/\//i);
  if (scheme) {
    kind = /^s(ftp|sh)$/i.test(scheme[1]) ? "sftp" : "smb";
    v = v.slice(scheme[0].length);
  } else if (/^(\\\\|\/\/)/.test(v)) {
    kind = "smb";
  }
  v = v.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = v.indexOf("/");
  let auth = slash < 0 ? v : v.slice(0, slash);
  const path = slash < 0 ? "" : v.slice(slash + 1).replace(/\/+$/, "");
  let user = "";
  let domain = "";
  const at = auth.lastIndexOf("@");
  if (at >= 0) {
    user = decodeURIComponent(auth.slice(0, at));
    auth = auth.slice(at + 1);
    // smb://DOMAIN;user@host
    const semi = user.indexOf(";");
    if (semi >= 0) [domain, user] = [user.slice(0, semi), user.slice(semi + 1)];
  }
  let host = auth;
  let port = 0;
  const m = auth.match(/^(.*):(\d+)$/);
  if (m) [host, port] = [m[1], +m[2]];
  if (!host) return null;
  return { kind, host, port, user, domain, path };
}

/** How a remote path is written for the server's own clients. */
export function serverAddress(conn, path, style) {
  const rest = path.split("/").filter(Boolean).slice(1);
  const port = conn.port ? `:${conn.port}` : "";
  if (conn.kind === "sftp") return `sftp://${conn.user ? encodeURIComponent(conn.user) + "@" : ""}${conn.host}${port}/${rest.map(encodeURIComponent).join("/")}`;
  if (style === "url") return `smb://${conn.host}${port}/${rest.map(encodeURIComponent).join("/")}`;
  return `\\\\${conn.host}${rest.length ? "\\" + rest.join("\\") : ""}`;
}

/** Where a connection opens. */
export function startPath(conn) {
  return "/:" + conn.id + (conn.path ? "/" + conn.path.split("/").filter(Boolean).join("/") : "");
}

const fieldsHTML = (c) => `
  <div class="conn-kind seg">
    <button type="button" data-kind="smb" class="${c.kind !== "sftp" ? "on" : ""}">SMB</button>
    <button type="button" data-kind="sftp" class="${c.kind === "sftp" ? "on" : ""}">SFTP</button>
  </div>
  <label class="field"><span>${t("Indirizzo del server")}</span><input type="text" name="host" value="${esc(c.host || "")}" placeholder="${t("es. srv03, \\\\srv03\\cartella o sftp://utente@server")}" spellcheck="false" autocomplete="off"></label>
  <div class="conn-row">
    <label class="field"><span>${t("Nome nella barra laterale")}</span><input type="text" name="name" value="${esc(c.name || "")}" spellcheck="false" autocomplete="off"></label>
    <label class="field conn-port"><span>${t("Porta")}</span><input type="number" name="port" min="0" max="65535" value="${c.port || ""}" placeholder="${c.kind === "sftp" ? 22 : 445}"></label>
  </div>
  <label class="field smb-only"><span>${t("Dominio")}</span><input type="text" name="domain" value="${esc(c.domain || "")}" placeholder="${t("facoltativo, es. AZIENDA")}" spellcheck="false" autocomplete="off"></label>
  <label class="field"><span>${t("Utente")}</span><input type="text" name="user" value="${esc(c.user || "")}" spellcheck="false" autocomplete="off"></label>
  <div class="field sftp-only"><span>${t("Accesso")}</span>
    <div class="seg conn-auth">
      <button type="button" data-auth="password" class="${c.auth !== "key" ? "on" : ""}">${t("Password")}</button>
      <button type="button" data-auth="key" class="${c.auth === "key" ? "on" : ""}">${t("Chiave di SynoFile")}</button>
    </div>
  </div>
  <label class="field pw"><span>${t("Password")}</span><input type="password" name="password" value="" placeholder="${c.has_password ? t("salvata: lasciala vuota per tenerla") : ""}" autocomplete="new-password"></label>
  <div class="field key-box"><span>${t("Chiave pubblica da aggiungere a ~/.ssh/authorized_keys sul server")}</span>
    <div class="conn-key"><code class="kv"></code><button type="button" class="btn small kcopy">${t("Copia")}</button><button type="button" class="btn small kmake">${t("Crea la chiave")}</button></div>
  </div>
  <label class="field"><span>${t("Cartella di partenza")}</span><input type="text" name="path" value="${esc(c.path && c.kind === "sftp" ? "/" + c.path : c.path || "")}" placeholder="${c.kind === "sftp" ? t("vuoto: la home dell'utente") : t("vuoto: l'elenco delle cartelle condivise")}" spellcheck="false" autocomplete="off"></label>
  ${c.host_key ? `<div class="hint conn-hostkey">${t("Chiave del server: {k}", { k: esc(c.host_key) })} <label><input type="checkbox" name="forget_key"> ${t("dimentica (è cambiata)")}</label></div>` : ""}
  <div class="hint conn-result"></div>`;

/**
 * Adds or edits a connection. `conn`: the saved one, or a draft from an
 * address typed in the path bar. Resolves to the saved connection, or null.
 */
export function editConnection(conn = {}, key = null) {
  return new Promise((resolve) => {
    const isNew = !conn.id;
    let kind = conn.kind || "smb";
    let auth = conn.auth || "password";
    let publicKey = key;
    const dlg = dialog(
      `<form method="dialog" class="conn-form">
        <div class="dlg-head"><div class="dlg-icon">${svg("server")}</div><h2>${isNew ? t("Nuova connessione") : t("Modifica connessione")}</h2></div>
        <div class="dlg-body">${fieldsHTML({ ...conn, kind, auth })}</div>
        <div class="dlg-foot"><button type="button" class="btn test">${t("Prova")}</button><span style="flex:1"></span><button type="button" class="btn cancel">${t("Annulla")}</button><button class="btn primary">${t("Salva")}</button></div>
      </form>`,
      { cls: "conn-dlg" },
    );
    const f = (n) => dlg.querySelector(`[name="${n}"]`);
    const result = dlg.querySelector(".conn-result");
    let saved = null;
    let nameTouched = !isNew;
    f("name").addEventListener("input", () => (nameTouched = true));

    const refresh = () => {
      dlg.querySelectorAll(".conn-kind button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
      dlg.querySelectorAll(".conn-auth button").forEach((b) => b.classList.toggle("on", b.dataset.auth === auth));
      dlg.querySelectorAll(".smb-only").forEach((x) => (x.hidden = kind !== "smb"));
      dlg.querySelectorAll(".sftp-only").forEach((x) => (x.hidden = kind !== "sftp"));
      const byKey = kind === "sftp" && auth === "key";
      dlg.querySelector(".pw").hidden = byKey;
      dlg.querySelector(".key-box").hidden = !byKey;
      dlg.querySelector(".kv").textContent = publicKey || t("Nessuna chiave ancora: creala, poi copiala sul server.");
      dlg.querySelector(".kcopy").hidden = !publicKey;
      dlg.querySelector(".kmake").hidden = !!publicKey;
      f("port").placeholder = kind === "sftp" ? "22" : "445";
      f("path").placeholder = kind === "sftp" ? t("vuoto: la home dell'utente") : t("vuoto: l'elenco delle cartelle condivise");
    };
    refresh();

    dlg.querySelectorAll(".conn-kind button").forEach((b) => (b.onclick = () => ((kind = b.dataset.kind), refresh())));
    dlg.querySelectorAll(".conn-auth button").forEach((b) => (b.onclick = () => ((auth = b.dataset.auth), refresh())));
    dlg.querySelector(".kcopy").onclick = () => copyText(publicKey);
    dlg.querySelector(".kmake").onclick = async () => {
      try {
        publicKey = (await api.makeKey()).key;
        refresh();
      } catch (e) {
        result.textContent = e.message;
      }
    };

    // an address pasted whole fills the other fields
    const host = f("host");
    const spread = () => {
      const a = parseAddress(host.value);
      if (!a) return;
      if (a.kind) kind = a.kind;
      host.value = a.host;
      if (a.port) f("port").value = a.port;
      if (a.user) f("user").value = a.user;
      if (a.domain) f("domain").value = a.domain;
      if (a.path) f("path").value = a.path;
      if (!nameTouched || !f("name").value) f("name").value = a.path && kind === "smb" ? a.path.split("/").pop() : a.host;
      refresh();
    };
    host.addEventListener("change", spread);
    host.addEventListener("paste", () => setTimeout(spread));
    if (isNew && conn.host) spread();
    (isNew ? host : f("name")).focus();

    const payload = () => ({
      id: conn.id || "",
      name: f("name").value.trim() || host.value.trim(),
      kind,
      host: host.value.trim(),
      port: +f("port").value || 0,
      domain: kind === "smb" ? f("domain").value.trim() : "",
      user: f("user").value.trim(),
      auth: kind === "sftp" ? auth : "password",
      path: f("path").value.trim(),
      password: f("password").value,
      forget_key: !!f("forget_key")?.checked,
    });
    const busy = (on) => dlg.querySelectorAll(".dlg-foot .btn").forEach((b) => (b.disabled = on));

    dlg.querySelector(".test").onclick = async () => {
      result.style.color = "";
      result.textContent = t("Connessione…");
      busy(true);
      try {
        const r = await api.testConn(payload());
        result.style.color = "var(--ok)";
        result.textContent = t("Connesso in {ms} ms: {n} elementi in {p}", { ms: r.ms, n: r.items, p: "/" + r.path });
      } catch (e) {
        result.style.color = "var(--crit)";
        result.textContent = e.message;
      } finally {
        busy(false);
      }
    };
    dlg.querySelector(".cancel").onclick = () => dlg.close();
    dlg.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      busy(true);
      try {
        saved = (await api.saveConn(payload())).conn;
        dlg.close();
      } catch (err) {
        result.style.color = "var(--crit)";
        result.textContent = err.message;
      } finally {
        busy(false);
      }
    };
    dlg.addEventListener("close", () => resolve(saved));
  });
}

/** A connection under a new name only. */
export async function renameConnection(conn, name) {
  const { conn: saved } = await api.saveConn({ ...conn, name, password: "" });
  toast(t("Connessione rinominata"), { kind: "ok", timeout: 1500 });
  return saved;
}
