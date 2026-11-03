import { LANG, t } from "./i18n.js";

// Talking to api.cgi: DSM's session cookie goes with every request, and
// the SynoToken DSM hands out guards against cross-site requests.
//
// The session can end while the page stays open (DSM signed out, timed
// out, restarted): a request refused with 401 asks DSM for the token again
// once, and if there is still no session the page hears "synofile:unauth"
// (and "synofile:auth" when it comes back).

const BASE = "api.cgi/";
/** Where DSM is: "/" or, under a Login Portal alias, "/alias/". */
export const DSM_BASE = location.pathname.match(/^(.*?)webman\/3rdparty\//)?.[1] ?? location.pathname.replace(/[^/]*$/, "");
const DSM = DSM_BASE;
let token = "";
let refreshing = null;
let unauthSent = false;

// DSM's error codes for a session that is gone: 119 no such session id,
// 106 timed out, 107 ended by another login; 105 "no permission" also
// comes when the token is stale
const DSM_SESSION_ERRORS = new Set([105, 106, 107, 119]);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The token of DSM's desktop around this page (or of the one that opened it), if reachable. */
function desktopToken() {
  for (const w of [window.top !== window && window.top, window.opener?.top]) {
    try {
      const value = w && w.SYNO && w.SYNO.SDS && w.SYNO.SDS.Session && w.SYNO.SDS.Session.SynoToken;
      if (value) return String(value);
    } catch {
      // another origin: no access to DSM
    }
  }
  return "";
}

/** Asks DSM's login.cgi; true when the session is valid (with or without a token). */
async function fromLogin() {
  try {
    const res = await fetch(DSM + "webman/login.cgi", { credentials: "same-origin", cache: "no-store" });
    const data = await res.json();
    if (data?.SynoToken) {
      token = data.SynoToken;
      return true;
    }
    // DSM with the cross-site protection off: a session, and no token
    if (data?.success === true) {
      token = "";
      return true;
    }
  } catch {}
  return false;
}

function sessionBack() {
  if (!unauthSent) return;
  unauthSent = false;
  dispatchEvent(new CustomEvent("synofile:auth"));
}

/** Gets the token; true when there is a DSM session to work with. */
export async function loadToken() {
  const own = desktopToken();
  if (own) {
    token = own;
    sessionBack();
    return true;
  }
  let ok = await fromLogin();
  if (!ok) {
    // DSM may answer too early right after signing in
    await wait(400);
    ok = await fromLogin();
  }
  if (ok) sessionBack();
  return ok;
}

/** Asks for a fresh token, one request at a time: true when the session is there. */
export function refreshToken() {
  refreshing ??= (async () => {
    try {
      if (await fromLogin()) return true;
      const own = desktopToken();
      if (own && own !== token) {
        token = own;
        return true;
      }
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export function synoToken() {
  return token;
}

/** The session is gone: tells the page, once until it comes back. */
export function notifyUnauth() {
  if (unauthSent) return;
  unauthSent = true;
  dispatchEvent(new CustomEvent("synofile:unauth"));
}

export class ApiError extends Error {
  constructor(status, message, auth = "") {
    super(message);
    this.status = status;
    // api.cgi's reason for a 401: "nocookie" or "rejected"
    this.auth = auth;
  }
}

export function url(route, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, v);
  if (token) q.set("SynoToken", token);
  q.set("lang", LANG);
  const s = q.toString();
  return BASE + route + (s ? "?" + s : "");
}

export async function call(route, opts = {}) {
  const { params, body, method, raw, signal } = opts;
  for (let attempt = 0; ; attempt++) {
    const options = { method: method || (body !== undefined ? "POST" : "GET"), credentials: "same-origin", headers: {}, signal };
    if (token) options.headers["X-SYNO-TOKEN"] = token;
    if (body !== undefined) {
      if (raw) {
        options.body = body;
        options.headers["Content-Type"] = "application/octet-stream";
      } else {
        options.body = JSON.stringify(body);
        options.headers["Content-Type"] = "application/json";
      }
    }
    const res = await fetch(url(route, params), options);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    // errors DSM's nginx would hide come as 422 with the real status aside
    const status = +res.headers.get("X-Synofile-Status") || res.status;
    if (status === 401) {
      if (attempt === 0 && (await refreshToken())) continue;
      notifyUnauth();
    } else if (res.ok) sessionBack();
    if (!res.ok) throw new ApiError(status, (data && data.error) || t("errore {n}", { n: status }), res.headers.get("X-Synofile-Auth") || "");
    return data;
  }
}

/**
 * A call to DSM's own web API, with the user's session: what DSM's own
 * pages do (ejecting a USB drive). Resolves `data`, or throws with DSM's
 * error code.
 */
export async function dsm(apiName, method, params = {}, version = 1) {
  for (let attempt = 0; ; attempt++) {
    const body = new URLSearchParams({ api: apiName, method, version });
    for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    if (token) headers["X-SYNO-TOKEN"] = token;
    const res = await fetch(DSM + "webapi/entry.cgi", { method: "POST", credentials: "same-origin", headers, body });
    const data = await res.json().catch(() => null);
    if (data?.success) return data.data;
    const code = data?.error?.code;
    if (res.status === 401 || DSM_SESSION_ERRORS.has(code)) {
      if (attempt === 0) {
        if (await refreshToken()) continue;
        notifyUnauth();
      } else if (code !== 105) notifyUnauth();
      // a 105 that stays with a fresh token is a real "not allowed"
    }
    const err = new ApiError(res.status, `DSM ${code ?? res.status}`);
    err.code = code;
    throw err;
  }
}

export const api = {
  init: () => call("init"),
  whoami: () => call("whoami"),
  shares: () => call("shares"),
  list: (path) => call("list", { params: { path } }),
  stat: (path, signal) => call("stat", { params: { path }, signal }),
  media: (path, signal) => call("media", { params: { path }, signal }),
  usage: (paths) => call("usage", { body: { paths } }),
  space: (path) => call("space", { params: { path } }),
  mkdir: (path, name, parents) => call("mkdir", { params: { path, name, parents: parents ? 1 : undefined }, body: {} }),
  rename: (path, name) => call("rename", { params: { path, name }, body: {} }),
  search: (path, q, signal) => call("search", { params: { path, q }, signal }),
  text: (path) => call("text", { params: { path } }),
  editOpen: (path) => call("edit", { params: { path } }),
  editSave: (path, text, stamp, force) => call("edit/save", { params: { path, stamp, force: force ? 1 : undefined }, body: text, raw: true }),
  exists: (path, names) => call("exists", { params: { path }, body: names }),
  prefs: () => call("prefs"),
  savePrefs: (p) => call("prefs", { body: p }),
  jobs: (since) => call("jobs", { params: { since } }),
  newJob: (job) => call("jobs/new", { body: job }),
  control: (id, action, extra = {}) => call("jobs/control", { body: { id, action, ...extra } }),
  view: (path) => url("view", { path }),
  thumb: (path, big) => url("thumb", { path, size: big ? "big" : undefined }),
  download: (paths) => url("download", { paths: JSON.stringify(paths) }),
  conns: () => call("conns"),
  saveConn: (c) => call("conns/save", { body: c }),
  testConn: (c) => call("conns/test", { body: c }),
  deleteConn: (id) => call("conns/delete", { body: { id } }),
  orderConns: (ids) => call("conns/order", { body: ids }),
  makeKey: () => call("conns/key", { body: {} }),
};
