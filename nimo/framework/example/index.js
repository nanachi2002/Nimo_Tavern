// The browser half of the example: a normal SillyTavern UI extension. Nothing NimoTavern-specific here, it calls
// its backend at /api/plugins/<id>/ exactly like it would on regular SillyTavern.
const { getRequestHeaders } = SillyTavern.getContext();
const API = '/api/plugins/nimo-example';

const html = `<div class="nimo-example-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>NimoFramework example</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <p id="nimo_example_hello">Asking the plugin…</p>
            <div id="nimo_example_count" class="menu_button">Count: <span>?</span></div>
        </div>
    </div>
</div>`;

/** Is our backend running? Works the same on SillyTavern (server plugin) and NimoTavern (NimoFramework). */
async function backendIsUp() {
    try {
        const r = await fetch(`${API}/probe`, { method: 'POST', headers: getRequestHeaders() });
        return r.status === 204;
    } catch {
        return false;
    }
}

jQuery(async () => {
    $('#extensions_settings2').append(html);

    if (!await backendIsUp()) {
        // window.NimoTavern only exists on NimoTavern: use it to give the right advice.
        $('#nimo_example_hello').text(window.NimoTavern
            ? 'The backend did not start. Open /api/plugins/status to see why.'
            : 'The backend is not running. On SillyTavern, copy server.cjs to the plugins folder and set enableServerPlugins to true.');
        $('#nimo_example_count').hide();
        return;
    }

    const hello = await (await fetch(`${API}/hello`, { headers: getRequestHeaders() })).json();
    $('#nimo_example_hello').text(`The plugin says hello to ${hello.hello} (${hello.framework ? `NimoFramework ${hello.framework}` : 'SillyTavern server plugin'}).`);

    $('#nimo_example_count').on('click', async () => {
        const r = await fetch(`${API}/count`, { method: 'POST', headers: getRequestHeaders() });
        $('#nimo_example_count span').text((await r.json()).count);
    });
});
