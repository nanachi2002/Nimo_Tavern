// NimoLFM: the free roleplay model made for NimoTavern.
// Adds a card to the API connection panel and a locked connection profile. Everything runs in the browser;
// the only request it makes is to NimoTavern's own /api/nimo/lfm gateway (never to a third party).
(() => {
    const KEY = 'nimolfm';
    const API = '/api/nimo/lfm';
    const MODEL = 'lfm3-rp';
    const CTX = 86000;
    // Locked sampler profile (tuned on the model itself: these values gave the best format/length compliance).
    const PROFILE = { temp_openai: 0.8, top_p_openai: 1, min_p_openai: 0.06, repetition_penalty_openai: 1.06,
        freq_pen_openai: 0, pres_pen_openai: 0, openai_max_tokens: 450, openai_max_context: CTX };
    // A 1.7B model does badly with prompts written for big models (jailbreaks, "thinking" rules, huge instructions): it can
    // even repeat them back as its reply. So while NimoLFM is on we use SillyTavern's plain built-in preset and ignore the
    // system prompt / post-history instructions that character cards bring along. The user's own choices are restored on switch-back.
    const SAFE_PRESET = 'Default';
    const FLAGS = { prefer_character_prompt: false, prefer_character_jailbreak: false };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const LOCKED_IDS = ['chat_completion_source', 'custom_api_url_text', 'custom_model_id', 'api_key_custom', 'settings_preset_openai',
        'prefer_character_prompt', 'prefer_character_jailbreak',
        'temp_openai', 'temp_counter_openai', 'top_p_openai', 'top_p_counter_openai', 'min_p_openai', 'min_p_counter_openai',
        'repetition_penalty_openai', 'rep_pen_counter_openai', 'freq_pen_openai', 'freq_pen_counter_openai', 'pres_pen_openai',
        'pres_pen_counter_openai', 'openai_max_context', 'openai_max_context_counter', 'custom_prompt_post_processing'];

    const ctx = () => SillyTavern.getContext();
    const cfg = () => { const s = ctx().extensionSettings; s[KEY] ??= { enabled: false, saved: null }; return s[KEY]; };
    const save = () => ctx().saveSettingsDebounced();
    const $el = (id) => document.getElementById(id);
    const url = () => location.origin + API + '/v1';

    function setVal(id, v) {
        const e = $el(id); if (!e) return;
        if (e.type === 'checkbox') { if (e.checked !== !!v) { e.checked = !!v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } return; }
        if (String(e.value) === String(v)) return;
        e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const getVal = (id) => { const e = $el(id); return !e ? null : e.type === 'checkbox' ? e.checked : e.value; };
    const SAVE_IDS = ['main_api', 'chat_completion_source', 'custom_api_url_text', 'custom_model_id', 'settings_preset_openai', 'stream_toggle',
        'prefer_character_prompt', 'prefer_character_jailbreak', ...Object.keys(PROFILE)];
    // The preset dropdown's option VALUES are numbers; the preset NAME is the option's label.
    const presetOpt = (name) => [...($el('settings_preset_openai')?.options || [])].find((o) => (o.text || '').trim() === name);
    const presetName = () => { const s = $el('settings_preset_openai'); return s && s.selectedIndex >= 0 ? (s.options[s.selectedIndex].text || '').trim() : null; };

    async function applyProfile() {
        setVal('main_api', 'openai');
        const safe = presetOpt(SAFE_PRESET);
        if (safe && getVal('settings_preset_openai') !== safe.value) { setVal('settings_preset_openai', safe.value); await sleep(1200); } // loading a preset rewrites the sliders
        for (const [id, v] of Object.entries(FLAGS)) setVal(id, v);
        setVal('chat_completion_source', 'custom');
        setVal('custom_api_url_text', url());
        setVal('custom_model_id', MODEL);
        setVal('stream_toggle', true);
        for (const [id, v] of Object.entries(PROFILE)) setVal(id, v);
    }
    function lockUi(on) {
        document.body.classList.toggle('nimolfm-locked', on);
        for (const id of LOCKED_IDS) { const e = $el(id); if (e) { e.disabled = on; } }
    }

    // The browser backend calls custom endpoints without cookies, so the gateway is authenticated with a short-lived signed
    // token (valid 6 h, refreshed after 4 h) that we store as the connection's API key. Connect writes it to the secret store.
    const TOKEN_REFRESH_MS = 4 * 3600_000;
    let problem = '';
    async function refreshToken() {
        try {
            const r = await fetch(API + '/token', { credentials: 'same-origin', cache: 'no-store' });
            if (!r.ok) throw new Error(r.status === 401 ? 'you are not logged in' : 'HTTP ' + r.status);
            const { token } = await r.json();
            lockUi(false);
            setVal('api_key_custom', token);
            $el('api_button_openai')?.click();            // writes the key to the secret store and connects
            lockUi(cfg().enabled);
            cfg().tokenAt = Date.now(); save(); problem = '';
            console.log('[NimoLFM] token refreshed');
            return true;
        } catch (e) { problem = 'Could not get a NimoLFM access token (' + (e.message || e) + ').'; console.warn('[NimoLFM]', e); return false; }
    }
    function check() {                // what the profile really looks like right now
        const bad = [];
        const want = { main_api: 'openai', chat_completion_source: 'custom', custom_api_url_text: url(), custom_model_id: MODEL };
        for (const [id, v] of Object.entries(want)) if (getVal(id) !== v) bad.push(`${id} is "${getVal(id)}", expected "${v}"`);
        if (presetOpt(SAFE_PRESET) && presetName() !== SAFE_PRESET) bad.push(`preset is "${presetName()}", expected "${SAFE_PRESET}"`);
        for (const [id, v] of Object.entries(FLAGS)) if (getVal(id) !== v) bad.push(`${id} is ${getVal(id)}, expected ${v}`);
        if (!cfg().tokenAt) bad.push('no access token yet');
        return problem ? [problem, ...bad] : bad;
    }

    async function enable() {
        const c = cfg();
        if (!c.saved) { c.saved = Object.fromEntries(SAVE_IDS.map((id) => [id, getVal(id)])); c.saved.preset_name = presetName(); }
        c.enabled = true; save();
        lockUi(false);                     // unlock briefly so the values can be written
        await applyProfile();
        await refreshToken();              // also clicks Connect
        lockUi(true);
        console.log('[NimoLFM] profile applied', check());
        render();
    }
    async function disable() {
        const c = cfg();
        const saved = c.saved;
        c.enabled = false; c.saved = null; save();     // off FIRST, so the "keep it locked" logic can't fight the restore below
        lockUi(false);
        if (saved) {
            const back = (saved.preset_name && presetOpt(saved.preset_name)) || null;   // by name: the list can change between visits
            const target = back ? back.value : (saved.preset_name ? null : saved.settings_preset_openai);   // older saves only have the number
            if (target != null) { setVal('settings_preset_openai', target); await sleep(1200); }  // restore the preset first: it rewrites the sliders
            for (const id of SAVE_IDS) if (id !== 'settings_preset_openai' && saved[id] != null) setVal(id, saved[id]);
        }
        render();
    }
    let enforcing = false;
    async function enforce() {    // keep the locked profile locked (settings reloads, preset switches...)
        if (!cfg().enabled) { lockUi(false); return; }
        if (enforcing) return; enforcing = true;
        try { lockUi(false); await applyProfile(); } finally { lockUi(true); enforcing = false; }
    }

    // ---- reply rules: tested on the model; appended (transiently) to the last user message, where they are followed best
    // Variant "X10", chosen from ~10 rounds of tests on SillyTavern-shaped prompts, including 8-turn chats where the model
    // writes its own history (4 characters), together with the gateway's DRY sampler. Results: ~155 words/reply, 91% inside
    // the 90-230 word target, 73% use both *asterisks* and "quotes", 5% write the user's moves, ~0% repeated openings.
    const RULES_MARK = 'Write exactly 3 paragraphs';
    function rules() {
        const c = ctx();
        const user = c.name1 || 'the user';
        const ch = c.groupId ? 'the speaking character' : (c.name2 || 'the character');
        return `[Only ${ch} acts in this reply: ${user} is played by the user, so never write what ${user} says, does, thinks or feels. ${RULES_MARK}, about 150 words in total, with concrete detail and fresh wording (never reuse sentences from earlier replies). Every reply uses both marks: *actions and scenery in asterisks* and "every spoken word in double quotes", for example: *She leans closer.* "Tell me more." Paragraph 1: *${ch} acts, and the scene around them.* Paragraph 2: ${ch} speaks in "quotes" with a short *gesture*. Paragraph 3: *what ${ch} feels or notices*. No emoji, no out-of-character notes. Remember: ${user} belongs to the user, so never write ${user}'s words, actions or feelings.]`;
    }
    globalThis.nimoLfmInterceptor = async function (chat, _ctxSize, _abort, type) {
        if (!cfg().enabled) return;
        if (Date.now() - (cfg().tokenAt || 0) > TOKEN_REFRESH_MS + 30 * 60_000) { await refreshToken(); await new Promise((r) => setTimeout(r, 1500)); }
        if (type === 'quiet' || type === 'impersonate') return;
        const last = chat[chat.length - 1];
        if (!last || !last.is_user || last.is_system) return;
        if (typeof last.mes === 'string' && !last.mes.includes(RULES_MARK)) last.mes = last.mes + '\n\n' + rules();
    };

    // ---- UI card
    let status = null, timer = null;
    async function poll() {
        try { const r = await fetch(API + '/status', { credentials: 'same-origin', cache: 'no-store' }); status = r.ok ? await r.json() : null; } catch { status = null; }
        const el = document.getElementById('nimolfm-status'); if (el) el.innerHTML = statusHtml();
    }
    function statusHtml() {
        if (!status) return '<span class="nimolfm-dot off"></span> Checking…';
        if (!status.online) return '<span class="nimolfm-dot off"></span> Offline right now, try again soon';
        const busy = status.busy ?? 0, slots = status.slots ?? 3;
        return busy >= slots ? '<span class="nimolfm-dot busy"></span> Busy: your message will wait a moment in line'
            : `<span class="nimolfm-dot on"></span> Online · ${busy} of ${slots} lanes in use`;
    }
    function render() {
        const c = cfg();
        let card = document.getElementById('nimolfm-card');
        if (!card) {
            card = document.createElement('div'); card.id = 'nimolfm-card';
            const host = document.getElementById('rm_api_block') || document.getElementById('openai_api')?.parentElement;
            if (!host) return;
            host.prepend(card);
        }
        card.className = c.enabled ? 'on' : '';
        card.innerHTML = `
            <div class="nimolfm-head"><span class="nimolfm-name"><i class="fa-solid fa-feather-pointed"></i> NimoLFM</span><span class="nimolfm-badge">Free</span><span class="nimolfm-badge alt">Made for NimoTavern</span></div>
            <p class="nimolfm-lead">A small roleplay model fine-tuned by the Nimo team for NimoTavern. No API key, no account elsewhere, nothing to pay.</p>
            <div id="nimolfm-status" class="nimolfm-status">${statusHtml()}</div>
            <div class="nimolfm-actions">${c.enabled
                ? '<div class="menu_button" id="nimolfm-off"><i class="fa-solid fa-unlock"></i> Switch back to my own API</div>'
                : '<div class="menu_button menu_button_icon" id="nimolfm-on"><i class="fa-solid fa-bolt"></i> Use NimoLFM</div>'}</div>
            ${c.enabled ? '<p class="nimolfm-note"><i class="fa-solid fa-lock"></i> Locked profile: connection, sampler settings and reply rules are managed for you so the model behaves its best. Your own preset and any prompt overrides from character cards are paused while it is on, and come back when you switch to your own API.</p>' : ''}
            ${c.enabled ? (() => { const bad = check(); return bad.length ? `<p class="nimolfm-warn"><i class="fa-solid fa-triangle-exclamation"></i> The profile isn't fully applied yet:<br>${bad.map((b) => '• ' + b.replace(/</g, '&lt;')).join('<br>')}<br><span class="menu_button" id="nimolfm-retry">Try again</span></p>` : '<p class="nimolfm-ok"><i class="fa-solid fa-circle-check"></i> Profile applied and connected.</p>'; })() : ''}
            <details class="nimolfm-more"><summary>About, privacy and limits</summary>
                <h4>What it is</h4>
                <p>NimoLFM is <b>LiquidAI LFM3-1.7B-Base</b> (Liquid AI, <a href="https://huggingface.co/LiquidAI/LFM3-1.7B-Base" target="_blank" rel="noopener">LFM Open License v1.0</a>) that the Nimo team fine-tuned on multi-turn roleplay, prose, long character cards and lorebooks. It is free for anyone using NimoTavern.</p>
                <h4>Privacy</h4>
                <p>Your messages go from your browser to our server, which passes them straight to the model and streams the reply back. We don't store them, log them or send them anywhere else, and there is no telemetry or analytics on what you write. Chats stay encrypted in your account as usual.</p>
                <h4>Limits (please read)</h4>
                <ul>
                    <li><b>It is a small model (1.7 billion parameters).</b> It writes good scenes but is weaker than big paid models at tangled plots, long-term consistency, maths, code and obscure facts.</li>
                    <li>It reads up to <b>${CTX.toLocaleString('en-US')} tokens</b> of context, but works best when the key facts are in the character card or recent messages. Write habits and quirks as short rules ("Always…", "Never…"), not as descriptions.</li>
                    <li>It can repeat itself, invent details or contradict the story. Swipe or edit when it does.</li>
                    <li>Mostly English. Replies are capped at 1,024 tokens.</li>
                    <li>Fair use: up to 40 messages a minute and 2 replies at once per account. When it's busy your message waits in line.</li>
                    <li>It writes fiction. Don't rely on it for facts, advice or anything serious.</li>
                </ul>
                <p><a href="/wiki/nimolfm" target="_blank" rel="noopener">Read the full guide</a></p>
            </details>`;
        card.querySelector('#nimolfm-on')?.addEventListener('click', enable);
        card.querySelector('#nimolfm-off')?.addEventListener('click', disable);
        card.querySelector('#nimolfm-retry')?.addEventListener('click', async () => { lockUi(false); await applyProfile(); await refreshToken(); lockUi(true); render(); });
        card.querySelector('details')?.addEventListener('toggle', (e) => { if (e.target.open) poll(); });
        if (!timer) timer = setInterval(() => { if (document.getElementById('nimolfm-status')?.offsetParent) poll(); }, 30000);
        poll();
    }

    function boot() {
        const { eventSource, event_types } = ctx();
        render();
        if (cfg().enabled) {
            enforce();
            if (Date.now() - (cfg().tokenAt || 0) > TOKEN_REFRESH_MS) refreshToken().then(render);
            else setTimeout(render, 800);
        }
        for (const ev of [event_types.SETTINGS_LOADED_AFTER, event_types.OAI_PRESET_CHANGED_AFTER, event_types.CHAT_CHANGED, event_types.MAIN_API_CHANGED].filter(Boolean)) {
            eventSource.on(ev, () => { if (cfg().enabled) setTimeout(enforce, 50); render(); });
        }
    }
    const t = setInterval(() => {   // wait for SillyTavern's UI
        if (globalThis.SillyTavern?.getContext && document.getElementById('main_api') && document.getElementById('rm_api_block')) { clearInterval(t); try { boot(); } catch (e) { console.warn('NimoLFM', e); } }
    }, 300);
})();
