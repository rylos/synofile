/* DSM desktop window: a native app window holding the interface. */
SYNO.namespace("SYNO.SDS.SynoFile");

SYNO.SDS.SynoFile.Instance = Vue.extend({
    template:
        '<v-app-instance class-name="SYNO.SDS.SynoFile.Instance">' +
        '<v-app-window ref="appWindow" syno-id="SYNO.SDS.SynoFile.Window"' +
        ' width="1240" height="780" :resizable="true">' +
        '<iframe src="/webman/3rdparty/synofile/index.html" title="SynoFile" allow="clipboard-write"' +
        ' style="display:block;width:100%;height:100%;border:0"></iframe>' +
        "</v-app-window>" +
        "</v-app-instance>",
});
