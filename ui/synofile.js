/* DSM desktop window: a native app window holding the interface. */
SYNO.namespace("SYNO.SDS.SynoFile");

/*
 * DSM keeps this loader for the whole desktop session, across package
 * upgrades: the page it opens must not depend on it. index.html is asked
 * for fresh every time (it is small, and carries the build of everything
 * else), and the frame takes the theme's background at once, so nothing
 * flashes white while it loads.
 */
SYNO.SDS.SynoFile.Instance = Vue.extend({
    template:
        '<v-app-instance class-name="SYNO.SDS.SynoFile.Instance" @openparamchanged="openParam">' +
        '<v-app-window ref="appWindow" syno-id="SYNO.SDS.SynoFile.Window"' +
        ' width="1240" height="780" :resizable="true">' +
        '<iframe ref="frame" :src="src" title="SynoFile" allow="clipboard-write"' +
        ' :style="frameStyle" @load="loaded = true"></iframe>' +
        "</v-app-window>" +
        "</v-app-instance>",
    data: function () {
        var theme = "dark";
        try {
            theme = JSON.parse(localStorage.getItem("synofile.prefs") || "{}").theme || "dark";
            if (theme === "system") {
                theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
            }
        } catch (e) {}
        return {
            loaded: false,
            // relative: under a Login Portal alias, DSM itself is at /alias/
            src: "webman/3rdparty/synofile/index.html?t=" + Date.now(),
            frameStyle: "display:block;width:100%;height:100%;border:0;background:" + (theme === "light" ? "#e6e7ed" : "#14171c"),
        };
    },
    /*
     * Another app opening a folder: SYNO.SDS.AppLaunch("SYNO.SDS.SynoFile.
     * Instance", { path: "/share/dir", select: "name" }), with the path as
     * SynoFile shows it (share first, no /volumeN). DSM hands the params
     * over for a new window and for the one already open alike: the first
     * loads the page at the folder, the other gets a new tab there.
     */
    methods: {
        openParam: function (inst, p) {
            if (!p || typeof p.path !== "string" || !p.path) return;
            var frame = this.$refs.frame;
            if (this.loaded && frame && frame.contentWindow) {
                frame.contentWindow.postMessage({ type: "synofile:open", path: p.path, select: p.select || "" }, location.origin);
                return;
            }
            this.src = "webman/3rdparty/synofile/index.html?path=" + encodeURIComponent(p.path) +
                (p.select ? "&select=" + encodeURIComponent(p.select) : "") + "&t=" + Date.now();
        },
    },
    // alone in the browser (a Login Portal alias or port): the tab says
    // SynoFile, with its icon, as DSM's own windows do
    mounted: function () {
        try {
            if (!window._S || !_S("standalone")) return;
            document.title = "SynoFile";
            [16, 32, 64].forEach(function (n) {
                SYNO.SDS.Utils.addFavIconLink("webman/3rdparty/synofile/images/icon_" + n + ".png", "image/png", n + "x" + n);
            });
        } catch (e) {}
    },
});
