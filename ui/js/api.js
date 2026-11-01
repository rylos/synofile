import { LANG } from "./i18n.js";

// Talking to api.cgi: DSM's session cookie goes with every request, and
// the SynoToken DSM hands out guards against cross-site requests.

const BASE = "api.cgi/";
let token = "";

export async function loadToken() {
  try {
    const res = await fetch("/webman/login.cgi", { credentials: "same-origin" });
    const data = await res.json();
    token = data.SynoToken || "";
  } catch {
    token = "";
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
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

export async function call(route, { params, body, method, raw, signal } = {}) {
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
  if (!res.ok) throw new ApiError(status, (data && data.error) || `errore ${status}`);
  return data;
}

/**
 * A call to DSM's own web API, with the user's session: what DSM's own
 * pages do (ejecting a USB drive). Resolves `data`, or throws with DSM's
 * error code.
 */
export async function dsm(apiName, method, params = {}, version = 1) {
  const body = new URLSearchParams({ api: apiName, method, version });
  for (const [k, v] of Object.entries(params)) body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (token) headers["X-SYNO-TOKEN"] = token;
  const res = await fetch("/webapi/entry.cgi", { method: "POST", credentials: "same-origin", headers, body });
  const data = await res.json().catch(() => null);
  if (!data?.success) throw new ApiError(res.status, `DSM ${data?.error?.code ?? res.status}`);
  return data.data;
}

export const api = {
  whoami: () => call("whoami"),
  shares: () => call("shares"),
  list: (path) => call("list", { params: { path } }),
  stat: (path) => call("stat", { params: { path } }),
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
