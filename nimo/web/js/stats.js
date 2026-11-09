// Stats panel (admin only). Renders aggregate numbers returned by /api/nimo/stats as cards and SVG charts.
import { api } from './common.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-US');
function bytes(n) {
    n = Number(n || 0);
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i];
}
const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);

let days = 30;

/** layers: [{ key, label, type: 'bar' | 'line', color }] */
function chart(el, rows, layers, { label = (r) => r.day.slice(5), W = 720 } = {}) {
    const  H = 190, L = 40, R = 8, T = 10, B = 24;
    const n = rows.length;
    let max = Math.max(4, ...rows.flatMap((r) => layers.map((l) => r[l.key] || 0)));
    let q = Math.ceil(max / 4); const mag = Math.pow(10, Math.floor(Math.log10(q)));
    q = Math.ceil(q / mag) * mag; max = q * 4; // 4 grid steps, always whole numbers
    const cw = (W - L - R) / n, x = (i) => L + cw * i + cw / 2, y = (v) => T + (H - T - B) * (1 - v / max);
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="st-chart" role="img">`;
    for (let g = 0; g <= 4; g++) {
        const v = (max / 4) * g, yy = y(v);
        svg += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid"/><text x="${L - 6}" y="${yy + 4}" class="axis" text-anchor="end">${num(Math.round(v))}</text>`;
    }
    const every = Math.max(1, Math.ceil(n / 8));
    rows.forEach((r, i) => { if ((i % every === 0 && n - 1 - i >= every * 0.7) || i === n - 1) svg += `<text x="${x(i)}" y="${H - 6}" class="axis" text-anchor="middle">${esc(label(r))}</text>`; });
    for (const l of layers.filter((q) => q.type === 'bar')) {
        const bw = Math.max(2, cw * 0.66);
        rows.forEach((r, i) => { const v = r[l.key] || 0; if (v) svg += `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" rx="2" style="fill:${l.color}"/>`; });
    }
    for (const l of layers.filter((q) => q.type === 'line')) {
        svg += `<polyline fill="none" stroke-width="2" style="stroke:${l.color}" points="${rows.map((r, i) => x(i) + ',' + y(r[l.key] || 0)).join(' ')}"/>`;
    }
    // hover columns with native tooltips
    rows.forEach((r, i) => { svg += `<rect x="${L + cw * i}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent"><title>${esc(label(r))}\n${layers.map((l) => l.label + ': ' + num(r[l.key])).join('\n')}</title></rect>`; });
    svg += '</svg>';
    const legend = layers.length > 1 ? `<div class="st-legend">${layers.map((l) => `<span><i style="background:${l.color}"></i>${esc(l.label)}</span>`).join('')}</div>` : '';
    el.innerHTML = svg + legend;
}

function hbars(el, items) {
    const max = Math.max(1, ...items.map((i) => i.n));
    el.innerHTML = items.map((i) => `<div class="st-hrow"><span>${esc(i.label)}</span><div class="st-htrack"><div style="width:${(i.n / max) * 100}%"></div></div><b>${num(i.n)}</b></div>`).join('');
}

function render(d) {
    const s = d.series, t = s[s.length - 1] || {}, y = s[s.length - 2] || {};
    const wk = d.weekly, mo = d.monthly;
    const cur = (rows, p) => rows.find((r) => r.period === p)?.n || 0;
    const prevOf = (rows, p) => { const i = rows.findIndex((r) => r.period === p); return i > 0 ? rows[i - 1].n : (i === -1 && rows.length ? rows[rows.length - 1].n : 0); };
    const last7 = s.slice(-7), tot = d.totals;
    const cards = [
        ['fa-eye', 'Visitors today', num(t.visitors), `yesterday ${num(y.visitors)}`],
        ['fa-user-check', 'Active accounts today', num(t.active), `yesterday ${num(y.active)}`],
        ['fa-calendar-week', 'Active this week', num(cur(wk, d.periods.w)), `last week ${num(prevOf(wk, d.periods.w))}`],
        ['fa-calendar', 'Active this month', num(cur(mo, d.periods.m)), `last month ${num(prevOf(mo, d.periods.m))}`],
        ['fa-users', 'Total accounts', num(tot.accounts), `+${num(sum(last7, 'signups'))} in 7 days`],
        ['fa-file-lines', 'Page views today', num(t.pageviews), `wiki ${num(t.wiki_views)}`],
        ['fa-right-to-bracket', 'Logins today', num(t.logins), `${num(sum(last7, 'logins'))} in 7 days`],
        ['fa-hard-drive', 'Encrypted storage', bytes(tot.bytes), `avg ${bytes(tot.avg)} per account`],
        ['fa-laptop', 'Accounts signed in', num(tot.signed_in), `${num(tot.sessions)} live sessions`],
        ['fa-truck-ramp-box', 'Old accounts waiting', num(tot.legacyPending), `${num(tot.legacyClaimed)} already moved`],
        ['fa-route', 'Relay calls today', num(t.relay_calls), `${num(sum(last7, 'relay_calls'))} in 7 days`],
    ];
    $('#cards').innerHTML = cards.map(([i, l, v, sub]) => `<div class="st-card nimo-glass"><div class="st-ico"><i class="fa-solid ${i}"></i></div><div><div class="st-label">${l}</div><div class="st-val">${v}</div><div class="st-sub">${sub}</div></div></div>`).join('');

    chart($('#c-visitors'), s, [{ key: 'visitors', label: 'Unique visitors', type: 'bar', color: 'var(--SmartThemeQuoteColor)' }, { key: 'pageviews', label: 'Page views', type: 'line', color: 'var(--SmartThemeUnderlineColor)' }]);
    chart($('#c-active'), s, [{ key: 'active', label: 'Active accounts', type: 'bar', color: '#58b600' }]);
    chart($('#c-signups'), s, [{ key: 'signups', label: 'New accounts', type: 'bar', color: 'var(--SmartThemeQuoteColor)' }], { W: 480 });
    chart($('#c-logins'), s, [{ key: 'logins', label: 'Logins', type: 'bar', color: 'var(--SmartThemeUnderlineColor)' }], { W: 480 });
    chart($('#c-wiki'), s, [{ key: 'wiki_views', label: 'Wiki views', type: 'bar', color: '#a78bfa' }], { W: 480 });
    chart($('#c-relay'), s, [{ key: 'relay_calls', label: 'Relay calls', type: 'bar', color: '#e1a224' }], { W: 480 });
    chart($('#c-weekly'), wk.map((r) => ({ day: r.period, n: r.n })), [{ key: 'n', label: 'Active accounts', type: 'bar', color: '#58b600' }], { label: (r) => r.day.slice(5), W: 480 });
    chart($('#c-monthly'), mo.map((r) => ({ day: r.period, n: r.n })), [{ key: 'n', label: 'Active accounts', type: 'bar', color: '#58b600' }], { label: (r) => r.day, W: 480 });
    const b = d.storageBuckets;
    hbars($('#c-storage'), [{ label: 'Empty', n: b.b0 }, { label: 'Under 1 MB', n: b.b1 }, { label: '1 to 10 MB', n: b.b2 }, { label: '10 to 100 MB', n: b.b3 }, { label: '100 MB and more', n: b.b4 }]);
    $('#updated').textContent = 'Updated ' + new Date(d.generated).toLocaleTimeString() + ' · showing the last ' + d.days + ' days (UTC)';
}

async function load() {
    const err = $('#err');
    err.classList.remove('show');
    try { render(await api('/stats?days=' + days)); } catch (e) {
        err.textContent = e.status === 404 || e.status === 401 ? 'This page is only available to the admin account.' : e.message;
        err.classList.add('show');
    }
}
$('#range').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.d) { days = +b.dataset.d; document.querySelectorAll('#range [data-d]').forEach((x) => x.classList.toggle('on', x === b)); }
    load();
});
load();
setInterval(load, 60_000);
