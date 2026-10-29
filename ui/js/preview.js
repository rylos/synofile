// Quick Look: Space shows the file under the cursor without leaving the
// folder; the arrows move to the previous and next file.

import { api } from "./api.js";
import { t, count } from "./i18n.js";
import { esc, size, dateTime, int } from "./format.js";
import { svg, iconHTML, kindLabel, previewKind } from "./icons.js";
import { h, $ } from "./ui.js";
import { isHeic, heicURL } from "./heic.js";
import { imageViewer } from "./zoom.js";
import { isBrowsable } from "./archive.js";

export function quickLook(pane, onDownload) {
  const files = pane.visible.filter((e) => e.kind !== "d" && !e.link_dir);
  if (!files.length) return;
  const start = pane.visible[pane.cursor];
  let index = Math.max(0, files.indexOf(start));
  const dlg = h(`<dialog class="quick"><div class="ql">
    <div class="ql-head"><div class="t"><b></b><small></small></div>
      <div class="ql-zoom" hidden>
        <button class="icon-btn zout" title="${t("Riduci")} (−)">${svg("zoomOut")}</button>
        <button class="pct" title="100% (1)"></button>
        <button class="icon-btn zin" title="${t("Ingrandisci")} (+)">${svg("zoomIn")}</button>
        <button class="icon-btn zfit" title="${t("Adatta alla finestra")} (0)">${svg("fit")}</button>
      </div>
      <button class="icon-btn dl" title="${t("Scarica")}">${svg("download")}</button>
      <button class="icon-btn open" title="${t("Apri in una nuova scheda del browser")}">${svg("external")}</button>
      <button class="icon-btn close" title="${t("Chiudi")} (Esc)">${svg("close")}</button></div>
    <div class="ql-body"></div>
    <button class="ql-nav prev">${svg("back")}</button><button class="ql-nav next">${svg("forward")}</button>
  </div></dialog>`);
  document.body.append(dlg);
  const body = $(".ql-body", dlg);
  const zoomBar = $(".ql-zoom", dlg);
  let viewer = null;
  // Images go on a stage the viewer can zoom and pan.
  const stage = (url) => {
    const el = h(`<div class="ql-stage"><img alt=""${url ? ` src="${url}"` : ""}></div>`);
    body.append(el);
    const img = el.querySelector("img");
    viewer = imageViewer(el, img, (scale) => ($(".pct", zoomBar).textContent = `${Math.round(scale * 100)}%`));
    zoomBar.hidden = false;
    return img;
  };
  const show = async () => {
    const e = files[index];
    pane.selectPath(e.path);
    $(".ql-head b", dlg).textContent = e.name;
    $(".ql-head small", dlg).textContent = `${kindLabel(e)} · ${size(e.size)} · ${dateTime(e.mtime)} · ${index + 1}/${files.length}`;
    $(".prev", dlg).hidden = index === 0;
    $(".next", dlg).hidden = index === files.length - 1;
    const src = api.view(e.path);
    const kind = previewKind(e);
    viewer?.destroy();
    viewer = null;
    zoomBar.hidden = true;
    body.innerHTML = "";
    if (kind === "image" && isHeic(e.name)) {
      // Synology's thumbnail, if any, while the full photo decodes.
      const img = stage(e.thumb ? api.thumb(e.path, true) : "");
      if (!e.thumb) body.append(h(`<div class="ql-wait">${t("Caricamento…")}</div>`));
      try {
        const u = await heicURL(e, 4096);
        if (files[index] !== e) return;
        body.querySelector(".ql-wait")?.remove();
        img.src = u;
      } catch {
        if (files[index] === e && !e.thumb) nothing(e);
      }
    } else if (kind === "image") {
      const img = stage(src);
      img.onerror = () => {
        if (e.thumb && !img.src.includes("thumb")) img.src = api.thumb(e.path, true);
        else nothing(e);
      };
    } else if (kind === "video") {
      body.append(h(`<video src="${src}" controls autoplay></video>`));
      body.querySelector("video").onerror = () => nothing(e, t("Il browser non sa riprodurre questo formato."));
    } else if (kind === "audio") {
      body.append(h(`<div style="text-align:center">${iconHTML(e, "keep").replace('class="gi', 'style="font-size:96px;display:block;margin-bottom:20px" class="gi')}<audio src="${src}" controls autoplay></audio></div>`));
    } else if (isBrowsable(e) && !pane.archive) {
      // like flea: what is inside, at a glance; Enter opens it as a folder
      body.append(h(`<div class="ql-wait">${t("Caricamento…")}</div>`));
      try {
        const data = await api.list(e.path);
        if (files[index] !== e) return;
        const rows = data.entries
          .map((x) => ({ ...x, path: e.path + "/" + x.name }))
          .sort((a, b) => (b.kind === "d") - (a.kind === "d") || a.name.localeCompare(b.name));
        const shown = rows.slice(0, 400);
        const tot = data.total || {};
        body.innerHTML = "";
        body.append(h(`<div class="ql-archive">
          <div class="sum">${iconHTML(e, "keep")}<div><b>${esc(e.name)}</b>
            <span>${esc(count(tot.files || 0, "file", "file", int))} · ${esc(count(tot.dirs || 0, "cartella", "cartelle", int))} · ${esc(t("{s} estratti", { s: size(tot.bytes || 0) }))}</span></div>
            <button class="btn primary enter">${svg("forward")} ${t("Apri come cartella")}</button></div>
          <ul>${shown.map((x) => `<li>${iconHTML(x)}<span class="n">${esc(x.name)}</span><span class="s">${x.kind === "d" ? "" : esc(size(x.size))}</span></li>`).join("")}</ul>
          ${rows.length > shown.length ? `<div class="more">${esc(t("e altri {n}", { n: int(rows.length - shown.length) }))}</div>` : ""}
        </div>`));
        $(".enter", body).onclick = () => {
          dlg.close();
          pane.go(e.path);
        };
      } catch (err) {
        if (files[index] === e) nothing(e, err.message);
      }
    } else if (kind === "pdf") {
      body.append(h(`<iframe src="${src}"></iframe>`));
    } else if (kind === "text" || e.size < 256 * 1024) {
      try {
        const r = await api.text(e.path);
        if (files[index] !== e) return;
        if (r.binary) return nothing(e);
        const pre = h(`<pre></pre>`);
        pre.textContent = r.text + (r.truncated ? `\n\n… ${t("(mostrati i primi 512 KB di {s})", { s: size(r.size) })}` : "");
        body.innerHTML = "";
        body.append(pre);
      } catch (err) {
        nothing(e, err.message);
      }
    } else nothing(e);
  };
  const nothing = (e, why) => {
    viewer?.destroy();
    viewer = null;
    zoomBar.hidden = true;
    body.innerHTML = `<div class="nopreview">${iconHTML(e, "keep")}<div>${esc(why || t("Nessuna anteprima per questo tipo di file"))}</div></div>`;
  };
  const move = (d) => {
    const n = index + d;
    if (n >= 0 && n < files.length) {
      index = n;
      show();
    }
  };
  $(".prev", dlg).onclick = () => move(-1);
  $(".next", dlg).onclick = () => move(1);
  $(".close", dlg).onclick = () => dlg.close();
  $(".zin", dlg).onclick = () => viewer?.zoomIn();
  $(".zout", dlg).onclick = () => viewer?.zoomOut();
  $(".zfit", dlg).onclick = () => viewer?.fit();
  $(".pct", dlg).onclick = () => viewer?.actual();
  $(".dl", dlg).onclick = () => onDownload([files[index]]);
  $(".open", dlg).onclick = () => open(api.view(files[index].path), "_blank");
  dlg.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1), e.preventDefault();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1), e.preventDefault();
    else if (viewer && (e.key === "+" || e.key === "=")) viewer.zoomIn(), e.preventDefault();
    else if (viewer && (e.key === "-" || e.key === "_")) viewer.zoomOut(), e.preventDefault();
    else if (viewer && e.key === "0") viewer.fit(), e.preventDefault();
    else if (viewer && e.key === "1") viewer.actual(), e.preventDefault();
    else if (e.key === " " && e.target.tagName !== "VIDEO" && e.target.tagName !== "AUDIO") dlg.close(), e.preventDefault();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === body || (e.target.classList.contains("ql-stage") && !e.target.classList.contains("pannable"))) dlg.close();
  });
  dlg.addEventListener("close", () => {
    viewer?.destroy();
    body.innerHTML = "";
    dlg.remove();
    pane.focus();
  });
  dlg.showModal();
  show();
}
