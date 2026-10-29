// Quick Look: Space shows the file under the cursor without leaving the
// folder; the arrows move to the previous and next file.

import { api } from "./api.js";
import { t } from "./i18n.js";
import { esc, size, dateTime } from "./format.js";
import { svg, iconHTML, kindLabel, previewKind } from "./icons.js";
import { h, $ } from "./ui.js";

export function quickLook(pane, onDownload) {
  const files = pane.visible.filter((e) => e.kind !== "d" && !e.link_dir);
  if (!files.length) return;
  const start = pane.visible[pane.cursor];
  let index = Math.max(0, files.indexOf(start));
  const dlg = h(`<dialog class="quick"><div class="ql">
    <div class="ql-head"><div class="t"><b></b><small></small></div>
      <button class="icon-btn dl" title="${t("Scarica")}">${svg("download")}</button>
      <button class="icon-btn open" title="${t("Apri in una nuova scheda del browser")}">${svg("external")}</button>
      <button class="icon-btn close" title="${t("Chiudi")} (Esc)">${svg("close")}</button></div>
    <div class="ql-body"></div>
    <button class="ql-nav prev">${svg("back")}</button><button class="ql-nav next">${svg("forward")}</button>
  </div></dialog>`);
  document.body.append(dlg);
  const body = $(".ql-body", dlg);
  const show = async () => {
    const e = files[index];
    pane.selectPath(e.path);
    $(".ql-head b", dlg).textContent = e.name;
    $(".ql-head small", dlg).textContent = `${kindLabel(e)} · ${size(e.size)} · ${dateTime(e.mtime)} · ${index + 1}/${files.length}`;
    $(".prev", dlg).hidden = index === 0;
    $(".next", dlg).hidden = index === files.length - 1;
    const src = api.view(e.path);
    const kind = previewKind(e);
    body.innerHTML = "";
    if (kind === "image") {
      body.append(h(`<img src="${e.thumb && /\.(heic|heif)$/i.test(e.name) ? api.thumb(e.path, true) : src}" alt="">`));
      body.querySelector("img").onerror = () => {
        if (e.thumb) body.querySelector("img").src = api.thumb(e.path, true);
        else nothing(e);
      };
    } else if (kind === "video") {
      body.append(h(`<video src="${src}" controls autoplay></video>`));
      body.querySelector("video").onerror = () => nothing(e, t("Il browser non sa riprodurre questo formato."));
    } else if (kind === "audio") {
      body.append(h(`<div style="text-align:center">${iconHTML(e, "keep").replace('class="gi', 'style="font-size:96px;display:block;margin-bottom:20px" class="gi')}<audio src="${src}" controls autoplay></audio></div>`));
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
  $(".dl", dlg).onclick = () => onDownload([files[index]]);
  $(".open", dlg).onclick = () => open(api.view(files[index].path), "_blank");
  dlg.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1), e.preventDefault();
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1), e.preventDefault();
    else if (e.key === " " && e.target.tagName !== "VIDEO" && e.target.tagName !== "AUDIO") dlg.close(), e.preventDefault();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === body) dlg.close();
  });
  dlg.addEventListener("close", () => {
    body.innerHTML = "";
    dlg.remove();
    pane.focus();
  });
  dlg.showModal();
  show();
}
