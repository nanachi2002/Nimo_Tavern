// NimoTavern wiki: page chrome, search, animated demos and interactive widgets. No dependencies, no network calls except the search index.
import { PROVIDED, bare, explain } from '../../shared/framework-modules.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- page chrome */
function chrome() {
    const side = $('#wk-side');
    $('#wk-menu')?.addEventListener('click', () => side.classList.toggle('open'));
    side?.addEventListener('click', (e) => { if (e.target.closest('a')) side.classList.remove('open'); });
    $('#wk-side a.on')?.scrollIntoView({ block: 'center' });

    // heading anchors + table of contents
    const heads = $$('.wk-article h2, .wk-article h3');
    const toc = $('#wk-toc');
    if (toc && heads.length > 2) {
        toc.innerHTML = '<b>On this page</b>' + heads.map((h) => `<a class="${h.tagName.toLowerCase()}" href="#${h.id}">${esc(h.dataset.t || h.textContent.replace('#', ''))}</a>`).join('');
        const links = $$('a', toc);
        const spy = new IntersectionObserver((es) => {
            for (const e of es) if (e.isIntersecting) { links.forEach((l) => l.classList.toggle('on', l.getAttribute('href') === '#' + e.target.id)); }
        }, { rootMargin: '-70px 0px -70% 0px' });
        heads.forEach((h) => spy.observe(h));
    }

    // copy buttons
    for (const pre of $$('.wk-article pre')) {
        const b = document.createElement('button');
        b.className = 'menu_button copy'; b.type = 'button'; b.innerHTML = '<i class="fa-solid fa-copy"></i>';
        b.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(pre.innerText.replace(/\n?$/, '')); b.innerHTML = '<i class="fa-solid fa-check"></i>'; setTimeout(() => { b.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1400); } catch { /* no clipboard */ }
        });
        pre.append(b);
    }

    // tabs
    for (const t of $$('.tabs')) {
        const tabs = $$(':scope > .tab', t);
        const bar = document.createElement('div'); bar.className = 'tab-bar';
        tabs.forEach((tab, i) => {
            const b = document.createElement('button'); b.type = 'button'; b.textContent = tab.dataset.label || 'Tab ' + (i + 1);
            b.addEventListener('click', () => { $$('button', bar).forEach((x, j) => x.classList.toggle('on', i === j)); tabs.forEach((x, j) => x.classList.toggle('on', i === j)); });
            bar.append(b);
        });
        t.prepend(bar);
        bar.firstChild?.click();
    }
}

/* ---------------------------------------------------------------- search */
function search() {
    const modal = $('#wk-search');
    if (!modal) return;
    const input = $('input', modal), out = $('#wk-results');
    let index = null, sel = 0, hits = [];
    const load = async () => {
        if (index) return index;
        try { index = await (await fetch('/wiki/search.json?v=' + (document.querySelector('meta[name=nimo-v]')?.content || ''))).json(); } catch { index = []; }
        return index;
    };
    const open = async () => { modal.hidden = false; input.value = ''; out.innerHTML = ''; input.focus(); await load(); run(); };
    const close = () => { modal.hidden = true; };
    function run() {
        const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
        hits = [];
        if (!index) return;
        if (!terms.length) hits = index.slice(0, 40).map((p) => ({ p, h: null, score: 0, snip: p.desc }));
        else {
            for (const p of index) {
                const hay = (p.title + ' ' + p.heads.map((h) => h.t).join(' ') + ' ' + p.text).toLowerCase();
                if (!terms.every((t) => hay.includes(t))) continue;
                let score = 0, best = null;
                for (const t of terms) {
                    if (p.title.toLowerCase().includes(t)) score += 12;
                    for (const h of p.heads) if (h.t.toLowerCase().includes(t)) { score += 6; best = best || h; }
                    score += Math.min(8, hay.split(t).length - 1);
                }
                const i = p.text.toLowerCase().indexOf(terms[0]);
                const snip = i >= 0 ? (i > 40 ? '…' : '') + p.text.slice(Math.max(0, i - 40), i + 110) + '…' : p.desc;
                hits.push({ p, h: best, score, snip });
            }
            hits.sort((a, b) => b.score - a.score);
        }
        sel = 0;
        const mark = (s) => terms.reduce((acc, t) => acc.replace(new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'), esc(s));
        out.innerHTML = hits.slice(0, 30).map((h, i) => `<a href="/wiki/${h.p.slug === 'index' ? '' : h.p.slug}${h.h ? '#' + h.h.id : ''}" class="${i === 0 ? 'sel' : ''}"><b>${mark(h.p.title)}</b>${h.h ? ' <span class="nimo-muted">› ' + mark(h.h.t) + '</span>' : ''}<small>${mark(h.snip || '')}</small></a>`).join('') || '<p class="nimo-muted" style="padding:10px">Nothing found. Try fewer or different words.</p>';
    }
    input.addEventListener('input', run);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    input.addEventListener('keydown', (e) => {
        const links = $$('a', out);
        if (e.key === 'Escape') close();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, Math.min(links.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))); links.forEach((l, i) => l.classList.toggle('sel', i === sel)); links[sel]?.scrollIntoView({ block: 'nearest' }); }
        if (e.key === 'Enter' && links[sel]) location.href = links[sel].href;
    });
    $('#wk-search-btn')?.addEventListener('click', open);
    document.addEventListener('keydown', (e) => {
        const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
        if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); open(); }
    });
}

/* ---------------------------------------------------------------- animated demos */
const CURSOR = '<svg viewBox="0 0 24 24"><path d="M4 2l15 9-6.5 1.6L9.8 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';

function initDemo(root) {
    const stage = $('.demo-stage', root);
    const steps = JSON.parse($('script.steps', root).textContent);
    const initial = stage.innerHTML;
    const title = document.createElement('div');
    title.className = 'demo-title';
    title.innerHTML = `<i class="dot"></i><i class="dot"></i><i class="dot"></i><span>${esc(root.dataset.title || 'Demo')}</span>`;
    root.prepend(title);
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = `<button class="menu_button" data-a="restart" title="Restart"><i class="fa-solid fa-rotate-left"></i></button><button class="menu_button" data-a="prev" title="Previous step"><i class="fa-solid fa-backward-step"></i></button><button class="menu_button" data-a="play" title="Play / pause"><i class="fa-solid fa-play"></i></button><button class="menu_button" data-a="next" title="Next step"><i class="fa-solid fa-forward-step"></i></button><div class="demo-cap"></div><div class="demo-dots">${steps.map((_, i) => `<i data-i="${i}"></i>`).join('')}</div>`;
    root.append(bar);
    const cap = $('.demo-cap', bar), dots = $$('.demo-dots i', bar), playBtn = $('[data-a=play]', bar);
    const pointer = document.createElement('div');
    pointer.className = 'demo-pointer'; pointer.innerHTML = CURSOR;
    let gen = 0, idx = -1, playing = false, visible = false;

    const q = (sel) => (sel ? stage.querySelector(sel) : null);
    // Moves an absolutely positioned element (a "packet") onto the centre of another one. `instant` skips the glide.
    function place(el, sel, instant) {
        const to = q(sel);
        if (!el || !to) return;
        el.dataset.at = sel;
        const s = stage.getBoundingClientRect(), r = to.getBoundingClientRect();
        if (instant) el.style.transition = 'none';
        el.style.transform = `translate(${r.left - s.left + r.width / 2}px, ${r.top - s.top + r.height / 2}px) translate(-50%, -50%)`;
        if (instant) { void el.offsetWidth; el.style.transition = ''; }
    }
    const replace = () => stage.querySelectorAll('[data-at]').forEach((el) => place(el, el.dataset.at, true));
    function reset() {
        stage.innerHTML = initial; stage.append(pointer); pointer.classList.remove('show');
        pointer.style.transform = `translate(${stage.clientWidth * 0.5}px, ${stage.clientHeight * 0.9}px)`;
        replace();
        idx = -1;
    }
    function setCap(i) {
        cap.textContent = steps[i]?.say || '';
        dots.forEach((d, j) => { d.classList.toggle('on', j === i); d.classList.toggle('done', j < i); });
    }
    async function movePointer(el, fast) {
        if (fast || !el) return;
        const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        pointer.classList.add('show');
        pointer.style.transform = `translate(${r.left - s.left + Math.min(r.width * 0.55, r.width - 6)}px, ${r.top - s.top + r.height * 0.6}px)`;
        await sleep(820);
    }
    async function typeInto(el, text, fast, mask) {
        if (!el) return;
        const isIn = 'value' in el && el.tagName !== 'DIV';
        const put = (v) => { const shown = mask ? '•'.repeat(v.length) : v; if (isIn) el.value = shown; else el.textContent = shown; };
        if (fast) { put(text); return; }
        for (let i = 1; i <= text.length; i++) { put(text.slice(0, i)); await sleep(mask ? 55 : 32); }
    }
    async function stream(el, text, fast) {
        if (!el) return;
        const words = text.split(/(\s+)/);
        if (fast) { el.innerHTML = text; return; }
        let acc = '';
        for (const w of words) { acc += w; el.innerHTML = acc + '<span class="caret"></span>'; await sleep(/\s/.test(w) ? 0 : 70); }
        el.innerHTML = acc;
    }
    const reveal = (el) => { if (!el) return; el.removeAttribute('data-hide'); el.classList.add('pop'); };

    async function apply(i, fast, myGen) {
        const s = steps[i];
        setCap(i);
        stage.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
        const target = q(s.at);
        if (s.at) { await movePointer(target, fast); if (myGen !== gen) return; }
        if (target && !fast && s.act !== 'none' && s.hl !== false) target.classList.add('hl');
        if (s.act === 'click' && !fast) { pointer.classList.remove('click'); void pointer.offsetWidth; pointer.classList.add('click'); await sleep(260); if (myGen !== gen) return; }
        for (const sel of s.hide || []) q(sel)?.setAttribute('data-hide', '');
        for (const sel of s.show || []) reveal(q(sel));
        for (const [sel, cls] of Object.entries(s.add || {})) cls.split(' ').forEach((c) => q(sel)?.classList.add(c));
        for (const [sel, cls] of Object.entries(s.rm || {})) cls.split(' ').forEach((c) => q(sel)?.classList.remove(c));
        for (const [sel, html] of Object.entries(s.set || {})) { const el = q(sel); if (el) el.innerHTML = html; }
        for (const [sel, v] of Object.entries(s.css || {})) { const el = q(sel); if (el) for (const [k, val] of Object.entries(v)) el.style.setProperty(k, val); }
        for (const [sel, to] of Object.entries(s.put || {})) place(q(sel), to, true);
        if (s.fly) {
            for (const [sel, to] of Object.entries(s.fly)) place(q(sel), to, fast || reduced);
            if (!fast) { await sleep(s.flyMs ?? 900); if (myGen !== gen) return; }
        }
        if (s.act === 'type') await typeInto(q(s.into || s.at), s.text, fast, s.mask);
        if (s.act === 'stream') await stream(q(s.into || s.at), s.text, fast);
        if (myGen !== gen) return;
        for (const sel of s.after?.show || []) reveal(q(sel));
        for (const sel of s.after?.hide || []) q(sel)?.setAttribute('data-hide', '');
        if (!fast) await sleep(s.wait ?? 900);
        idx = i;
    }
    async function runFrom(i) {
        const myGen = ++gen;
        playing = true; playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        for (let k = i; k < steps.length; k++) {
            await apply(k, false, myGen);
            if (myGen !== gen) return;
        }
        await sleep(2600);
        if (myGen !== gen) return;
        reset(); runFrom(0);
    }
    function stop() { gen++; playing = false; playBtn.innerHTML = '<i class="fa-solid fa-play"></i>'; }
    async function jump(i) {
        stop();
        const myGen = gen;
        reset();
        for (let k = 0; k <= i; k++) await apply(k, true, myGen);
        setCap(i);
    }
    bar.addEventListener('click', (e) => {
        const b = e.target.closest('button'), d = e.target.closest('[data-i]');
        if (d) return jump(+d.dataset.i);
        if (!b) return;
        const a = b.dataset.a;
        if (a === 'play') { if (playing) stop(); else { if (idx >= steps.length - 1) { reset(); runFrom(0); } else runFrom(idx + 1); } }
        if (a === 'restart') { stop(); reset(); setCap(-1); runFrom(0); }
        if (a === 'next') jump(Math.min(steps.length - 1, idx + 1));
        if (a === 'prev') jump(Math.max(0, idx - 1));
    });
    reset(); setCap(0);
    jump(reduced ? steps.length - 1 : 0).then(() => { if (!reduced) setCap(-1); });
    new IntersectionObserver((es) => {
        visible = es[0].isIntersecting;
        if (visible && !playing && !reduced && !root.dataset.touched) { reset(); runFrom(0); }
        if (!visible && playing) stop();
    }, { threshold: 0.45 }).observe(root);
    bar.addEventListener('pointerdown', () => { root.dataset.touched = '1'; });
    // Packets are placed in pixels: put them back where they belong when the layout changes.
    if (initial.includes('data-at')) new ResizeObserver(replace).observe(stage);
}

/* ---------------------------------------------------------------- widgets */
const W = {};

// Sampler playground ---------------------------------------------------------------
W.sampler = (el) => {
    const toks = [[' smiled', 3.1], [' roared', 2.8], [' laughed', 2.2], [' sighed', 1.9], [' said', 1.7], [' yawned', 1.0], [' vanished', 0.4], [' exploded', -0.2], [' sang', -0.5], [' banana', -2.0]];
    el.innerHTML = `<h4><i class="fa-solid fa-sliders"></i> Sampler playground</h4>
<p class="sub">The model just read <i>“The dragon looked at the knight and…”</i> and scored every possible next word. Move the sliders to see how each setting reshapes the choice.</p>
<div class="wg-row"><label>Temperature</label><input type="range" id="t" min="0.1" max="2" step="0.05" value="1"><output></output></div>
<div class="wg-row"><label>Top K</label><input type="range" id="k" min="1" max="10" step="1" value="10"><output></output></div>
<div class="wg-row"><label>Top P</label><input type="range" id="p" min="0.1" max="1" step="0.01" value="1"><output></output></div>
<div class="wg-row"><label>Min P</label><input type="range" id="m" min="0" max="0.5" step="0.01" value="0"><output></output></div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0"><button class="menu_button" data-pre="0.2,10,1,0" style="width:auto">Precise</button><button class="menu_button" data-pre="1,10,0.9,0.05" style="width:auto">Balanced</button><button class="menu_button" data-pre="1.5,10,1,0" style="width:auto">Wild</button><button class="menu_button" data-pre="1,3,1,0" style="width:auto">Top K = 3</button><button class="menu_button primary" id="go" style="width:auto"><i class="fa-solid fa-dice"></i> Roll 12 words</button></div>
<div class="bars"></div><div class="wg-out"><span class="nimo-muted">Press “Roll” to sample from the distribution above.</span></div>`;
    const g = (id) => +$('#' + id, el).value;
    let final = [];
    function calc() {
        const T = g('t'), K = g('k'), P = g('p'), M = g('m');
        const ex = toks.map(([, l]) => Math.exp(l / T)); const z = ex.reduce((a, b) => a + b, 0);
        let rows = toks.map(([w], i) => ({ w, p: ex[i] / z, keep: true })).sort((a, b) => b.p - a.p);
        rows.forEach((r, i) => { if (i >= K) r.keep = false; });
        const max = rows[0].p; rows.forEach((r) => { if (r.p < M * max) r.keep = false; });
        let cum = 0, cut = false; for (const r of rows) { if (cut) r.keep = false; if (r.keep) { cum += r.p; if (cum >= P) cut = true; } }
        rows[0].keep = true;
        const s = rows.filter((r) => r.keep).reduce((a, r) => a + r.p, 0);
        rows.forEach((r) => { r.f = r.keep ? r.p / s : 0; });
        final = rows;
        $$('output', el).forEach((o, i) => { o.textContent = [T, K, P, M][i]; });
        $('.bars', el).innerHTML = rows.map((r) => `<div class="bar ${r.keep ? '' : 'cut'}"><span>${esc(r.w.trim())}</span><div class="track"><div class="fill" style="width:${(r.keep ? r.f : r.p) * 100}%"></div></div><span>${((r.keep ? r.f : r.p) * 100).toFixed(1)}%</span></div>`).join('');
    }
    $$('input', el).forEach((i) => i.addEventListener('input', calc));
    $$('[data-pre]', el).forEach((b) => b.addEventListener('click', () => { const v = b.dataset.pre.split(','); ['t', 'k', 'p', 'm'].forEach((id, i) => { $('#' + id, el).value = v[i]; }); calc(); }));
    $('#go', el).addEventListener('click', () => {
        const pick = () => { let r = Math.random(), a = 0; for (const x of final) { a += x.f; if (r <= a && x.f > 0) return x.w; } return final[0].w; };
        $('.wg-out', el).innerHTML = Array.from({ length: 12 }, () => '“The dragon looked at the knight and<b class="nimo-quote">' + esc(pick()) + '</b>”').join('<br>');
    });
    calc();
};

// Context window --------------------------------------------------------------------
W.context = (el) => {
    const parts = [['System prompt', 350, '#6c5ce7'], ['Character card', 900, '#0984e3'], ['Persona', 150, '#00b894'], ['World Info', 600, '#e17055'], ['Examples', 400, '#fdcb6e']];
    el.innerHTML = `<h4><i class="fa-solid fa-layer-group"></i> What fits in the context window?</h4>
<p class="sub">The AI can only read so many tokens at once. Everything is packed in this order, and the oldest chat messages are dropped first when space runs out.</p>
<div class="wg-row"><label>Context size</label><input type="range" id="c" min="0" max="5" step="1" value="2"><output></output></div>
<div class="wg-row"><label>Response length</label><input type="range" id="r" min="100" max="1500" step="50" value="400"><output></output></div>
<div class="wg-row"><label>Messages in chat</label><input type="range" id="n" min="0" max="300" step="5" value="60"><output></output></div>
<div class="ctxbar"></div><div class="ctxleg"></div><div class="wg-out"></div>`;
    const sizes = [2048, 4096, 8192, 16384, 32768, 131072];
    const g = (id) => +$('#' + id, el).value;
    function calc() {
        const C = sizes[g('c')], R = g('r'), n = g('n'), hist = n * 110;
        const fixed = parts.reduce((a, p) => a + p[1], 0);
        const room = Math.max(0, C - fixed - R);
        const used = Math.min(hist, room), lost = hist - used;
        const segs = [...parts.map(([l, t, c]) => [l, t, c]), ['Chat history', used, '#d63031'], ['Reply', R, '#636e72'], ['Free', Math.max(0, C - fixed - used - R), '#2d3436']];
        $('.ctxbar', el).innerHTML = segs.map(([l, t, c]) => `<div style="flex:${t} 1 0;background:${c}" title="${l}: ${t}">${t / C > 0.07 ? l.split(' ')[0] : ''}</div>`).join('');
        $('.ctxleg', el).innerHTML = segs.map(([l, t, c]) => `<span><i style="background:${c}"></i>${l} ${t}</span>`).join('');
        const lostMsgs = Math.ceil(lost / 110);
        $('.wg-out', el).innerHTML = (C < fixed + R ? '<b style="color:#ff8a8a">The fixed parts alone don’t fit. Raise the context size or lower the response length.</b>' : lost > 0 ? `<b class="nimo-quote">${lostMsgs} oldest message${lostMsgs > 1 ? 's' : ''}</b> no longer fit, so the AI has <b>forgotten</b> them. Raise the context size, trim the character card, or use <b>Summarize</b>.` : '<b style="color:#7bd62a">Everything fits</b>, the AI remembers the whole chat.');
        const out = $$('output', el); out[0].textContent = C >= 1000 ? Math.round(C / 1024) + 'k' : C; out[1].textContent = R; out[2].textContent = n;
    }
    $$('input', el).forEach((i) => i.addEventListener('input', calc));
    calc();
};

// Lorebook trigger tester ------------------------------------------------------------
W.lore = (el) => {
    const entries = [
        { name: 'Eldoria (city)', keys: ['eldoria', 'capital'], sec: [], text: 'Eldoria is a floating city ruled by the Moon Council.', const: false },
        { name: 'Ashfang (dragon)', keys: ['dragon', 'ashfang', 'wyrm'], sec: [], text: 'Ashfang is an ancient red dragon who hates liars.', const: false },
        { name: 'Dragon hoard', keys: ['dragon'], sec: ['gold', 'treasure'], text: 'Ashfang’s hoard is hidden under the Ember Mountains.', const: false },
        { name: 'World rules', keys: [], sec: [], text: 'Magic always costs the caster a memory.', const: true },
    ];
    el.innerHTML = `<h4><i class="fa-solid fa-book-atlas"></i> Lorebook trigger tester</h4>
<p class="sub">Write a message. Entries whose <b>keywords</b> appear in it wake up and get added to the prompt. Try “dragon”, then add “gold”.</p>
<textarea class="text_pole" rows="2">The knight asked the dragon about Eldoria.</textarea>
<div style="display:flex;gap:16px;flex-wrap:wrap;margin:8px 0;font-size:.9em"><label><input type="checkbox" id="cs"> Case sensitive</label><label><input type="checkbox" id="ww"> Match whole words</label></div>
<div class="wg-out msg"></div><div class="list"></div><div class="wg-out inj"></div>`;
    const ta = $('textarea', el);
    function calc() {
        const text = ta.value, cs = $('#cs', el).checked, ww = $('#ww', el).checked;
        const hit = (k) => { const a = cs ? text : text.toLowerCase(), b = cs ? k : k.toLowerCase(); if (!b) return false; return ww ? new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(a) : a.includes(b); };
        const fired = entries.map((e) => e.const || (e.keys.some(hit) && (!e.sec.length || e.sec.some(hit))));
        const all = entries.flatMap((e, i) => (fired[i] ? [...e.keys, ...e.sec] : []));
        let html = esc(text);
        for (const k of new Set(all)) if (k) html = html.replace(new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', cs ? 'g' : 'gi'), '<mark>$1</mark>');
        $('.msg', el).innerHTML = html || '<span class="nimo-muted">(empty)</span>';
        $('.list', el).innerHTML = entries.map((e, i) => `<div class="lore-entry ${fired[i] ? 'fire' : ''}"><i class="fa-solid ${fired[i] ? 'fa-bolt' : 'fa-moon'}" style="margin-top:4px"></i><div><b>${esc(e.name)}</b> ${e.const ? '<span class="badge">constant</span>' : ''}<div class="keys">keys: ${e.keys.length ? e.keys.join(', ') : '(none)'}${e.sec.length ? ' · AND ANY: ' + e.sec.join(', ') : ''}</div></div></div>`).join('');
        const inj = entries.filter((_, i) => fired[i]).map((e) => e.text);
        $('.inj', el).innerHTML = `<b>Added to the prompt (${Math.ceil(inj.join(' ').length / 4)} tokens):</b><br>` + (inj.length ? inj.map(esc).join('<br>') : '<span class="nimo-muted">nothing</span>');
    }
    el.addEventListener('input', calc); el.addEventListener('change', calc);
    calc();
};

// Live AES-GCM, in the reader's own browser ------------------------------------------
const hex = (u8, n = 9999) => [...u8.slice(0, n)].map((b) => b.toString(16).padStart(2, '0')).join('');
W.cipher = async (el) => {
    el.innerHTML = `<h4><i class="fa-solid fa-lock"></i> Encrypt something right now</h4>
<p class="sub">This runs the same primitive NimoTavern uses (AES-256-GCM, via your browser’s WebCrypto). Nothing you type here leaves this page.</p>
<input type="text" class="text_pole" value="She whispered the password: moonlight.">
<div class="wg-split" style="margin-top:12px"><div class="wg-box"><h5><i class="fa-solid fa-user"></i> In your browser</h5><div class="pl"></div><div class="hexout key" style="margin-top:8px;color:#7bd62a"></div></div>
<div class="wg-box"><h5><i class="fa-solid fa-server"></i> What a server would store</h5><div class="hexout ct"></div><div class="nimo-muted meta" style="margin-top:6px"></div></div></div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><button class="menu_button" data-a="again" style="width:auto"><i class="fa-solid fa-rotate"></i> Encrypt again (same text)</button><button class="menu_button" data-a="tamper" style="width:auto"><i class="fa-solid fa-user-secret"></i> Flip one bit, then decrypt</button><button class="menu_button" data-a="dec" style="width:auto"><i class="fa-solid fa-unlock"></i> Decrypt</button></div><div class="wg-out res" style="display:none"></div>`;
    if (!crypto?.subtle) { el.innerHTML += '<p>Your browser has no WebCrypto here.</p>'; return; }
    const enc = new TextEncoder(), dec = new TextDecoder();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    $('.key', el).textContent = 'key: ' + hex(new Uint8Array(await crypto.subtle.exportKey('raw', key)), 6) + '… (never leaves this tab)';
    let blob = null;
    async function go() {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const pt = enc.encode($('input', el).value);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
        blob = { iv, ct };
        $('.pl', el).textContent = $('input', el).value;
        $('.ct', el).textContent = hex(iv) + hex(ct);
        $('.meta', el).textContent = `${pt.length} bytes in → ${iv.length + ct.length} bytes out (12-byte random IV + ciphertext + 16-byte authentication tag)`;
        $('.res', el).style.display = 'none';
    }
    const show = (h, ok) => { const r = $('.res', el); r.style.display = 'block'; r.innerHTML = h; r.style.borderColor = ok ? '#58b600' : '#c0392b'; };
    $('input', el).addEventListener('input', go);
    el.addEventListener('click', async (e) => {
        const a = e.target.closest('button')?.dataset.a; if (!a) return;
        if (a === 'again') return go();
        const ct = new Uint8Array(blob.ct);
        if (a === 'tamper') ct[0] ^= 1;
        try { const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.iv }, key, ct); show('<i class="fa-solid fa-check"></i> Decrypted: <b>' + esc(dec.decode(p)) + '</b>', true); } catch { show('<i class="fa-solid fa-ban"></i> <b>Decryption refused.</b> The authentication tag doesn’t match, so the data was changed. Tampering is always detected, never silently accepted.', false); }
    });
    go();
};

// What the server really stores --------------------------------------------------------
W.serverview = async (el) => {
    const files = [['characters/Seraphina.png', 41230], ['chats/Seraphina/2026-11-08@21h14m.jsonl', 18890], ['settings.json  (contains your API keys)', 7342], ['worlds/Eldoria.json', 5120], ['User Avatars/me.png', 22110]];
    el.innerHTML = `<h4><i class="fa-solid fa-eye-slash"></i> You vs. the database</h4>
<p class="sub">Same account, two points of view. Toggle to see what the NimoTavern server (and anyone with admin access to it) actually holds.</p>
<div style="display:flex;gap:6px;margin-bottom:10px"><button class="menu_button on" data-v="you" style="width:auto"><i class="fa-solid fa-user"></i> Your tavern</button><button class="menu_button" data-v="srv" style="width:auto"><i class="fa-solid fa-database"></i> The database</button></div><div class="wg-box list" style="min-height:170px"></div>`;
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const rows = await Promise.all(files.map(async ([p, size]) => ({ p, size, id: hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p)))).slice(0, 40), blob: hex(crypto.getRandomValues(new Uint8Array(40))) })));
    const list = $('.list', el);
    function draw(view, scramble) {
        list.innerHTML = rows.map((r, i) => view === 'you' ? `<div style="padding:3px 0"><i class="fa-solid fa-file" style="color:var(--SmartThemeQuoteColor);width:1.4em"></i>${esc(r.p)} <span class="nimo-muted">· ${(r.size / 1024).toFixed(1)} KB</span></div>` : `<div class="hexout" style="padding:3px 0" data-i="${i}">id ${r.id}…<br><span class="nimo-muted">${(r.size * 0.62 + 28) | 0} bytes ·</span> ${r.blob}…</div>`).join('') + (view === 'srv' ? '<p class="nimo-muted" style="margin:8px 0 0;font-family:var(--mainFontFamily)">No file names, no folders, no text. Just random-looking IDs and bytes.</p>' : '');
        if (scramble && view === 'srv') {
            let n = 0; const t = setInterval(() => { $$('.hexout', list).forEach((d) => { d.firstChild.textContent = 'id ' + hex(crypto.getRandomValues(new Uint8Array(20))) + '…'; }); if (++n > 8) { clearInterval(t); draw('srv', false); } }, 60);
        }
    }
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (!b) return; $$('[data-v]', el).forEach((x) => x.classList.toggle('on', x === b)); draw(b.dataset.v, true); });
    draw('you');
};

// Theme playground ----------------------------------------------------------------------
W.theme = (el) => {
    const presets = { 'SillyTavern dark': ['#dcdcd2', '#7c7c70', '#e1d3a4', '#5d6a42', '#2b2b2f'], 'Midnight blue': ['#e6ecff', '#8fa3d9', '#7fb2ff', '#4a6fa5', '#141a2e'], 'Rose': ['#ffe9f0', '#d39ab0', '#ff8fb5', '#b5527a', '#2a1620'], 'Forest': ['#e8f5e0', '#93b684', '#b9e07a', '#4f7a3a', '#15241a'] };
    const names = ['Main text', 'Italics', 'Quotes', 'Accent', 'Panel tint'];
    el.innerHTML = `<h4><i class="fa-solid fa-palette"></i> Theme playground</h4><p class="sub">Every color in SillyTavern is a variable. Change them here (or pick a preset) and the mini chat updates live. In the real app: User Settings → UI Theme.</p>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${Object.keys(presets).map((k) => `<button class="menu_button" data-p="${k}" style="width:auto">${k}</button>`).join('')}</div>
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;font-size:.88em">${names.map((n, i) => `<label style="display:flex;align-items:center;gap:6px"><input type="color" data-c="${i}"> ${n}</label>`).join('')}</div>
<div class="demo-stage theme-stage" style="min-height:0;border-radius:10px;padding:12px"><div class="mk-chat" style="padding:0"><div class="mk-msg"><div class="av">S</div><div><div class="nm">Seraphina</div><div class="tx"><em>*She smiles softly and sets down her staff.*</em> <q>“You’ve traveled far, haven’t you?”</q></div></div></div><div class="mk-msg user"><div class="av">Y</div><div><div class="nm">You</div><div class="tx">I have. Is there room by the fire?</div></div></div></div></div>`;
    const stage = $('.theme-stage', el);
    function apply(v) {
        const [body, em, quote, accent, tint] = v;
        const s = stage.style;
        s.setProperty('--SmartThemeBodyColor', body); s.setProperty('--SmartThemeEmColor', em); s.setProperty('--SmartThemeQuoteColor', quote);
        s.setProperty('--SmartThemeBotMesBlurTintColor', tint + 'cc'); s.setProperty('--SmartThemeUserMesBlurTintColor', accent + '66');
        s.color = body;
        $$('[data-c]', el).forEach((i, k) => { i.value = v[k]; });
    }
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) apply(presets[b.dataset.p]); });
    el.addEventListener('input', (e) => { if (e.target.dataset.c !== undefined) apply($$('[data-c]', el).map((i) => i.value)); });
    apply(presets['SillyTavern dark']);
};

// Clickable tour of the top bar ------------------------------------------------------------
W.tour = (el) => {
    const items = [...$$('.ico[data-info]', el)];
    const info = $('.tour-info', el);
    items.forEach((i) => i.addEventListener('click', () => {
        items.forEach((x) => x.classList.toggle('on', x === i));
        info.innerHTML = `<h4 style="margin:0 0 4px"><i class="${i.dataset.icon}" style="color:var(--SmartThemeQuoteColor)"></i> ${esc(i.dataset.tip)}</h4>${i.dataset.info}` + (i.dataset.link ? ` <a href="${i.dataset.link}">Read the full guide →</a>` : '');
    }));
    items[0]?.click();
};

// NimoFramework port check ---------------------------------------------------------
W.portcheck = (el) => {
    const SAMPLE = `import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { exec } from 'node:child_process';
import { roll } from './lib/dice.js';

export const info = { id: 'my-plugin', name: 'My plugin', description: 'Example' };

export async function init(router) {
    router.get('/config', (req, res) => {
        const file = path.join(process.cwd(), 'plugins', 'my-plugin', 'config.yaml');
        res.json(yaml.parse(fs.readFileSync(file, 'utf8')));
    });
    router.post('/roll', (req, res) => res.json({ result: roll(req.body.sides) }));
    router.post('/run', (req, res) => exec('ls', (err, out) => res.send(out)));
    setInterval(() => console.log('still alive'), 60000);
}
`;
    el.innerHTML = `<h4><i class="fa-solid fa-stethoscope"></i> Port check</h4>
<p class="sub">Paste your plugin's server file (the one with <code>init(router)</code>). The check runs in this page: nothing is uploaded. It reads the code as text, so treat the result as a guide, not a guarantee.</p>
<textarea class="text_pole pc-in" rows="11" spellcheck="false" aria-label="Your plugin's server code"></textarea>
<div class="pc-actions"><button type="button" class="menu_button" data-a="sample"><i class="fa-solid fa-flask"></i> Load the example</button><button type="button" class="menu_button" data-a="clear"><i class="fa-solid fa-eraser"></i> Clear</button></div>
<div class="pc-out" aria-live="polite"></div>`;
    const input = $('.pc-in', el), out = $('.pc-out', el);
    const ICON = { ok: 'fa-circle-check', warn: 'fa-triangle-exclamation', no: 'fa-circle-xmark' };
    const row = (lvl, head, text) => `<div class="pc-row ${lvl}"><i class="fa-solid ${ICON[lvl]}"></i><div><b>${head}</b><span>${text}</span></div></div>`;

    function check() {
        const raw = input.value;
        if (!raw.trim()) { out.innerHTML = '<p class="nimo-muted">Paste some code above, or load the example.</p>'; return; }
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
        const mods = new Set();
        const patterns = [
            /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
            /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
            /\bimport\s+(?:[^'"()]*?\sfrom\s*)?(['"])([^'"]+)\1/g,
            /\bexport\s+[^'"()=]*?\sfrom\s*(['"])([^'"]+)\1/g,
        ];
        for (const re of patterns) for (const m of code.matchAll(re)) mods.add(m[2]);
        const esm = /^\s*(import\s*[\w{*'"]|export\s+(const|let|var|function|async|default|class|\{|\*))/m.test(code);

        const rows = [];
        let blocked = 0, bundle = esm;
        for (const id of [...mods].sort((a, b) => bare(a).localeCompare(bare(b)))) {
            const { kind, hint } = explain(id);
            const name = `<code>${esc(id)}</code>`;
            if (kind === 'provided') rows.push(row('ok', name, 'Provided by NimoFramework. Nothing to do.'));
            else if (kind === 'impossible' || kind === 'node') { blocked++; rows.push(row('no', name, esc(hint))); }
            else { bundle = true; rows.push(row('warn', name, esc(hint))); }
        }

        const notes = [];
        const has = (re) => re.test(code);
        if (esm) notes.push(row('warn', 'ES module syntax (<code>import</code> / <code>export</code>)', 'NimoFramework loads CommonJS. The build command below converts it for you; your source stays as it is.'));
        if (has(/\.listen\s*\(/)) { blocked++; notes.push(row('no', '<code>.listen()</code>', 'A plugin cannot open a port. Register your routes on the <code>router</code> given to <code>init()</code>: they are served at <code>/api/plugins/&lt;id&gt;/</code>.')); }
        if (has(/\bsetInterval\s*\(|\bcron\b/)) notes.push(row('warn', 'Background timer', 'The browser stops the Service Worker after about 30 seconds without requests, and your timer with it. Do the work when a request arrives, and keep state in <code>nimo.storage</code>.'));
        if (has(/\bprocess\.env\b/)) notes.push(row('warn', '<code>process.env</code>', 'It is empty here: users have no environment variables. Keep settings in <code>nimo.storage</code> and let the user edit them in your extension\'s UI.'));
        if (has(/\b__dirname\b|\b__filename\b|process\.cwd\s*\(|import\.meta/)) notes.push(row('warn', 'Paths on disk (<code>__dirname</code>, <code>process.cwd()</code>, <code>import.meta</code>)', 'The folder layout is different. Use <code>nimo.dataDir</code> for data you write and <code>nimo.extensionDir</code> for files shipped in your repository.'));
        if (has(/\bnew\s+(WebSocketServer|Server)\b/)) { blocked++; notes.push(row('no', 'Socket server', 'A browser cannot accept connections. Use normal routes, or streaming with <code>res.write()</code>.')); }
        if (!has(/\binfo\b\s*[=:]|exports\.info\b/)) notes.push(row('warn', 'No <code>info</code> found', 'Export <code>info = { id, name, description }</code>, the same object SillyTavern asks for.'));
        else {
            const id = code.match(/\bid\s*:\s*(['"`])([^'"`]*)\1/)?.[2];
            if (id !== undefined && !/^[a-z0-9_-]+$/.test(id)) notes.push(row('no', `Plugin id <code>${esc(id)}</code>`, 'An id may only contain lowercase letters, digits, <code>-</code> and <code>_</code>.'));
            if (id === 'list' || id === 'status') notes.push(row('no', `Plugin id <code>${esc(id)}</code>`, 'This id is reserved by NimoFramework. Pick another one.'));
        }
        if (!has(/\binit\b/)) notes.push(row('warn', 'No <code>init</code> found', 'Export <code>init(router)</code> and register your routes in it.'));

        let verdict;
        if (blocked) verdict = `<div class="pc-verdict no"><i class="fa-solid fa-circle-xmark"></i><div><b>${blocked} thing${blocked > 1 ? 's' : ''} to change first</b><span>The red lines cannot work in a browser. Each one says what to use instead. Everything else can stay.</span></div></div>`;
        else if (bundle) verdict = '<div class="pc-verdict warn"><i class="fa-solid fa-box"></i><div><b>Portable, with one build step</b><span>Bundle your code and its packages into a single CommonJS file with the command below.</span></div></div>';
        else verdict = '<div class="pc-verdict ok"><i class="fa-solid fa-circle-check"></i><div><b>No build needed</b><span>Copy this file into your extension\'s repository and point <code>"nimo": { "framework": 1, "server": "…" }</code> at it.</span></div></div>';
        const cmd = bundle ? '<p class="pc-cmd-t">Build command (run it in your plugin\'s folder, then commit <code>server.cjs</code>):</p><div class="pc-cmd"><code>npx esbuild src/index.js --bundle --platform=node --format=cjs --external:express --external:node-fetch --outfile=server.cjs</code></div>' : '';
        out.innerHTML = verdict + (rows.length ? '<h5>Modules</h5>' + rows.join('') : '') + (notes.length ? '<h5>Code patterns</h5>' + notes.join('') : '') + cmd
            + `<p class="nimo-muted pc-foot">${mods.size} module${mods.size === 1 ? '' : 's'} found. NimoFramework provides ${PROVIDED.length} of them out of the box: see <a href="#modules-you-can-require">the list</a>.</p>`;
    }
    input.addEventListener('input', check);
    el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'sample') input.value = SAMPLE;
        if (a === 'clear') input.value = '';
        if (a) check();
    });
    input.value = SAMPLE; check();
};

// The list of modules a plugin can require(), always in step with the framework.
W.fwmodules = (el) => {
    el.classList.remove('widget');
    el.innerHTML = PROVIDED.map((m) => `<code>${esc(m)}</code>`).join(' ');
};

function widgets() { for (const el of $$('[data-widget]')) { try { W[el.dataset.widget]?.(el); } catch (e) { console.warn('widget', e); } } }

chrome(); search(); widgets();
for (const d of $$('.demo')) { try { initDemo(d); } catch (e) { console.warn('demo', e); } }
