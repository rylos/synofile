/* DSM taskbar: an icon beside DSM's own while SynoFile has transfers. */
SYNO.namespace("SYNO.SDS.SynoFile.Tray");

/*
 * DSM starts this hidden app with the desktop (autoLaunchType "tray"). It
 * asks the NAS for the transfers, every 2 s while some are active (running,
 * paused, queued or waiting for an answer), every 60 s otherwise (Synology
 * Drive's own asks every 5 s), and at once when SynoFile's page starts or
 * changes one, or when DSM's tab comes back to the front. The icon
 * shows only then, with a ring of the overall progress; a click opens a
 * panel with each transfer, and from there SynoFile on its dialog.
 *
 * Built on DSM's own tray classes (SYNO.SDS.Tray.ArrowTray, as Synology
 * Drive does). They are not documented for third-party packages: anything
 * unexpected and the icon simply stays away. Settings → Behaviour turns it
 * off.
 */
(function () {
    var API = "/webman/3rdparty/synofile/api.cgi/jobs";
    var ACTIVE = { running: 1, paused: 1, queued: 1, conflict: 1 };

    var STR = {
        it: { title: "Trasferimenti SynoFile", open: "Apri SynoFile", running: "in corso", paused: "in pausa", queued: "in coda", conflict: "da decidere", failed: "non riuscito", copy: "Copia", move: "Spostamento", "delete": "Eliminazione", compress: "Compressione", extract: "Estrazione", items: "elementi", none: "Nessun trasferimento attivo" },
        en: { title: "SynoFile transfers", open: "Open SynoFile", running: "running", paused: "paused", queued: "queued", conflict: "needs you", failed: "failed", copy: "Copy", move: "Move", "delete": "Delete", compress: "Compress", extract: "Extract", items: "items", none: "No active transfers" },
        de: { title: "SynoFile-Übertragungen", open: "SynoFile öffnen", running: "läuft", paused: "angehalten", queued: "in Warteschlange", conflict: "Entscheidung nötig", failed: "fehlgeschlagen", copy: "Kopieren", move: "Verschieben", "delete": "Löschen", compress: "Komprimieren", extract: "Extrahieren", items: "Elemente", none: "Keine aktiven Übertragungen" },
        fr: { title: "Transferts SynoFile", open: "Ouvrir SynoFile", running: "en cours", paused: "en pause", queued: "en attente", conflict: "à décider", failed: "échec", copy: "Copie", move: "Déplacement", "delete": "Suppression", compress: "Compression", extract: "Extraction", items: "éléments", none: "Aucun transfert actif" },
        es: { title: "Transferencias de SynoFile", open: "Abrir SynoFile", running: "en curso", paused: "en pausa", queued: "en cola", conflict: "por decidir", failed: "fallida", copy: "Copia", move: "Traslado", "delete": "Eliminación", compress: "Compresión", extract: "Extracción", items: "elementos", none: "Ninguna transferencia activa" },
        nl: { title: "SynoFile-overdrachten", open: "SynoFile openen", running: "bezig", paused: "gepauzeerd", queued: "in wachtrij", conflict: "keuze nodig", failed: "mislukt", copy: "Kopiëren", move: "Verplaatsen", "delete": "Verwijderen", compress: "Comprimeren", extract: "Uitpakken", items: "items", none: "Geen actieve overdrachten" },
        pt: { title: "Transferências do SynoFile", open: "Abrir o SynoFile", running: "em curso", paused: "em pausa", queued: "em fila", conflict: "por decidir", failed: "falhou", copy: "Cópia", move: "Mover", "delete": "Eliminação", compress: "Compressão", extract: "Extração", items: "itens", none: "Nenhuma transferência ativa" },
        "pt-BR": { title: "Transferências do SynoFile", open: "Abrir o SynoFile", running: "em andamento", paused: "pausada", queued: "na fila", conflict: "aguardando você", failed: "falhou", copy: "Cópia", move: "Mover", "delete": "Exclusão", compress: "Compactação", extract: "Extração", items: "itens", none: "Nenhuma transferência ativa" },
        pl: { title: "Transfery SynoFile", open: "Otwórz SynoFile", running: "w toku", paused: "wstrzymany", queued: "w kolejce", conflict: "wymaga decyzji", failed: "nieudany", copy: "Kopiowanie", move: "Przenoszenie", "delete": "Usuwanie", compress: "Kompresja", extract: "Wyodrębnianie", items: "elementy", none: "Brak aktywnych transferów" },
    };
    var DSM_LANG = { ita: "it", enu: "en", ger: "de", fre: "fr", spn: "es", nld: "nl", ptg: "pt", ptb: "pt-BR", plk: "pl" };

    function lang() {
        var code = "";
        try {
            code = SYNO.SDS.Session.lang || "";
        } catch (e) {}
        if (code === "def") code = (navigator.language || "en").slice(0, 2) === "it" ? "ita" : "enu";
        return DSM_LANG[code] || "en";
    }
    function tr(key) {
        var t = STR[lang()] || STR.en;
        return t[key] || STR.en[key] || key;
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function size(n) {
        var u = ["B", "KiB", "MiB", "GiB", "TiB"];
        var i = 0;
        while (n >= 1024 && i < u.length - 1) {
            n /= 1024;
            i++;
        }
        return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
    }
    function enabled() {
        try {
            return JSON.parse(localStorage.getItem("synofile.prefs") || "{}").dsmTray !== false;
        } catch (e) {
            return true;
        }
    }

    var ICON =
        "url(\"data:image/svg+xml;utf8," +
        encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 20l-4-4M7 20l4-4M17 20V4M17 4l-4 4M17 4l4 4"/></svg>') +
        "\")";

    function addStyle() {
        if (document.getElementById("synofile-tray-style")) return;
        var css =
            ".synofile-tray-icon{background-image:" + ICON + "!important;background-size:18px 18px!important;background-repeat:no-repeat!important;background-position:center!important}" +
            ".synofile-tray-panel .x-panel-body{background:transparent}" +
            ".synofile-tray{padding:12px 14px;font-size:13px;min-width:300px}" +
            ".synofile-tray h4{margin:0 0 10px;font-size:13px;font-weight:600}" +
            ".synofile-tray .job{display:block;padding:7px 0;border-top:1px solid rgba(128,128,128,.25);cursor:pointer}" +
            ".synofile-tray .job:hover .nm{text-decoration:underline}" +
            ".synofile-tray .row{display:flex;justify-content:space-between;gap:10px;align-items:baseline}" +
            ".synofile-tray .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}" +
            ".synofile-tray .st{font-size:11.5px;white-space:nowrap;opacity:.75}" +
            ".synofile-tray .st.conflict,.synofile-tray .st.paused{color:#e7a93a;opacity:1}" +
            ".synofile-tray .st.failed{color:#e5534b;opacity:1}" +
            ".synofile-tray .bar{height:5px;border-radius:3px;background:rgba(128,128,128,.25);margin:5px 0 3px;overflow:hidden}" +
            ".synofile-tray .bar div{height:100%;border-radius:3px;background:linear-gradient(90deg,#5b9cf8,#8b7cf6)}" +
            ".synofile-tray .bar.paused div{background:#e7a93a}" +
            ".synofile-tray .sub{font-size:11.5px;opacity:.7;display:flex;justify-content:space-between}" +
            ".synofile-tray .none{opacity:.7;padding:6px 0}" +
            ".synofile-tray .open{margin-top:10px;width:100%;padding:6px;border-radius:6px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;font:inherit}" +
            ".synofile-tray .open:hover{background:rgba(128,128,128,.15)}";
        var el = document.createElement("style");
        el.id = "synofile-tray-style";
        el.textContent = css;
        document.head.appendChild(el);
    }

    function openSynoFile(jobId) {
        // the page (open already, or about to load) picks this up
        try {
            if (jobId) localStorage.setItem("synofile.openXfer", JSON.stringify({ id: jobId, at: Date.now() }));
        } catch (e) {}
        try {
            SYNO.SDS.AppLaunch("SYNO.SDS.SynoFile.Instance");
        } catch (e) {}
    }

    SYNO.SDS.SynoFile.Tray.Instance = Ext.extend(SYNO.SDS.AppInstance, {
        initInstance: function () {
            if (!SYNO.SDS.Tray || !SYNO.SDS.Tray.ArrowTray) return;
            var tray = new SYNO.SDS.SynoFile.Tray.Item({ appInstance: this });
            this.addInstance(tray);
            tray.open();
        },
    });

    Ext.define("SYNO.SDS.SynoFile.Tray.Item", {
        extend: "SYNO.SDS.Tray.ArrowTray",

        initPanel: function () {
            addStyle();
            var me = this;
            me.jobs = [];
            me.seen = {};
            me.panelBody = null;
            var panel = new SYNO.SDS.Tray.Panel({
                cls: "synofile-tray-panel",
                width: 340,
                autoHeight: true,
                html: '<div class="synofile-tray"></div>',
                listeners: {
                    afterrender: function (p) {
                        me.panelBody = p.body.dom.querySelector(".synofile-tray");
                        me.panelBody.addEventListener("click", function (e) {
                            var job = e.target.closest ? e.target.closest("[data-job]") : null;
                            var open = e.target.closest ? e.target.closest(".open") : null;
                            if (!job && !open) return;
                            me.taskButton && me.taskButton.toggle(false);
                            panel.hide();
                            openSynoFile(job ? +job.getAttribute("data-job") : null);
                        });
                        me.render();
                    },
                    beforeshow: function () {
                        me.render();
                    },
                },
            });
            return panel;
        },

        onButtonReady: function (button) {
            var me = this;
            me.setIconClass("synofile-tray-icon");
            me.setTitle(tr("title"));
            // SynoFile's page says when it starts or changes a transfer
            me.onStorage = function (e) {
                if (e.key === "synofile.jobsChanged") me.poll();
            };
            window.addEventListener("storage", me.onStorage);
            me.onVisible = function () {
                if (!document.hidden) me.poll();
            };
            document.addEventListener("visibilitychange", me.onVisible);
            me.poll();
        },

        poll: function () {
            var me = this;
            clearTimeout(me.timer);
            if (me.isDestroyed) return;
            // the next round is set first: nothing that goes wrong below can
            // stop the polling
            var busy = (me.jobs || []).some(function (j) { return ACTIVE[j.state]; });
            me.timer = setTimeout(function () { me.poll(); }, busy || me.panelOpen() ? 2000 : 60000);
            if (!enabled()) {
                me.setTaskButtonVisible(false);
                return;
            }
            if (me.inflight) return;
            me.inflight = true;
            Ext.Ajax.request({
                url: API,
                method: "GET",
                // no speed samples: only the state
                params: { since: 9e15, lang: lang(), _t: Date.now() },
                callback: function (opts, ok, resp) {
                    me.inflight = false;
                    var data = null;
                    try {
                        data = ok ? JSON.parse(resp.responseText) : null;
                    } catch (e) {}
                    var wasBusy = busy;
                    try {
                        me.update((data && data.jobs) || []);
                    } catch (e) {
                        if (window.console) console.warn("SynoFile tray:", e);
                    }
                    // a transfer just started: poll fast from now on
                    var nowBusy = me.jobs.some(function (j) { return ACTIVE[j.state]; });
                    if (nowBusy && !wasBusy) {
                        clearTimeout(me.timer);
                        me.timer = setTimeout(function () { me.poll(); }, 2000);
                    }
                },
            });
        },

        panelOpen: function () {
            return !!(this.panel && this.panel.isVisible && this.panel.isVisible());
        },

        update: function (list) {
            var now = Date.now();
            var me = this;
            // the speed, from one answer to the next
            list.forEach(function (j) {
                var before = me.seen[j.id];
                var done = (j.progress && j.progress.bytes_done) || 0;
                if (before && j.state === "running" && now > before.at) {
                    var bps = ((done - before.done) * 1000) / (now - before.at);
                    j.bps = before.bps ? before.bps * 0.6 + bps * 0.4 : bps;
                }
                me.seen[j.id] = { done: done, at: now, bps: j.bps };
            });
            // active ones, and failures of the last 15 s
            me.jobs = list.filter(function (j) {
                return ACTIVE[j.state] || (j.state === "failed" && j.finished && now - j.finished < 15000);
            });
            me.setTaskButtonVisible(me.jobs.length > 0);
            try {
                me.drawRing();
            } catch (e) {
                if (window.console) console.warn("SynoFile tray ring:", e);
            }
            if (me.panelOpen()) me.render();
        },

        /**
         * The ring of the overall progress, drawn into the icon itself: the
         * icon's rule is written again each time, so nothing depends on how
         * DSM builds its taskbar buttons.
         */
        drawRing: function () {
            var total = 0;
            var done = 0;
            var color = "#5b9cf8";
            this.jobs.forEach(function (j) {
                var p = j.progress || {};
                total += p.bytes_total || 0;
                done += Math.min(p.bytes_done || 0, p.bytes_total || 0);
                if (j.state === "conflict" || j.state === "paused") color = "#e7a93a";
                if (j.state === "failed") color = "#e5534b";
            });
            var c = 2 * Math.PI * 22;
            var off = c * (1 - (total ? done / total : 0));
            var svg =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
                '<circle cx="24" cy="24" r="22" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="3"/>' +
                '<circle cx="24" cy="24" r="22" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + off.toFixed(2) + '" transform="rotate(-90 24 24)"/>' +
                '<g transform="translate(12 12)" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M7 20l-4-4M7 20l4-4M17 20V4M17 4l-4 4M17 4l4 4"/></g></svg>';
            var el = document.getElementById("synofile-tray-ring");
            if (!el) {
                el = document.createElement("style");
                el.id = "synofile-tray-ring";
                document.head.appendChild(el);
            }
            el.textContent = ".synofile-tray-icon{background-image:url(\"data:image/svg+xml;utf8," + encodeURIComponent(svg) + "\")!important;background-size:26px 26px!important}";
        },

        render: function () {
            if (!this.panelBody) return;
            var html = "<h4>" + esc(tr("title")) + "</h4>";
            if (!this.jobs.length) html += '<div class="none">' + esc(tr("none")) + "</div>";
            this.jobs.forEach(function (j) {
                var p = j.progress || {};
                var srcs = (j.info && j.info.sources) || [];
                var name = srcs.length === 1 ? srcs[0].split("/").pop() : srcs.length + " " + tr("items");
                var pct = p.bytes_total ? Math.floor((100 * Math.min(p.bytes_done, p.bytes_total)) / p.bytes_total) : 0;
                var state = j.state === "running" ? (j.bps ? size(j.bps) + "/s" : tr("running")) : tr(j.state);
                var right = p.bytes_total ? size(p.bytes_done || 0) + " / " + size(p.bytes_total) : "";
                html +=
                    '<div class="job" data-job="' + j.id + '"><div class="row"><span class="nm">' + esc(tr(j.op) + " · " + name) + '</span><span class="st ' + j.state + '">' + esc(state) + "</span></div>" +
                    '<div class="bar ' + (j.state === "paused" || j.state === "conflict" ? "paused" : "") + '"><div style="width:' + pct + '%"></div></div>' +
                    '<div class="sub"><span>' + pct + "%</span><span>" + esc(right) + "</span></div></div>";
            });
            html += '<button class="open">' + esc(tr("open")) + "</button>";
            this.panelBody.innerHTML = html;
        },

        onBeforeDestroy: function () {
            clearTimeout(this.timer);
            if (this.onStorage) window.removeEventListener("storage", this.onStorage);
            if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
            this.callParent(arguments);
        },
    });
})();
