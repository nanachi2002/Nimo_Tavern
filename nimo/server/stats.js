// Privacy-preserving usage statistics.
//
// What is recorded (and nothing else):
//  * Per UTC day, plain counters: page views, wiki views, logins, sign-ups, relay calls, unique visitors.
//  * How many distinct accounts were active per day / week / month (a number).
// What is NOT recorded: IP addresses, user agents, usernames, per-user activity history, anything about content.
//
// Unique visitors are counted in RAM only: a keyed hash of the IP with a random salt that exists for one day
// and is then discarded, so the hashes can't be linked across days or turned back into IPs after the day ends.
// The "active accounts" dedupe set is a table of keyed hashes that only ever holds the CURRENT day/week/month
// and is purged when the period ends, so past activity can't be tied to an account.
import crypto from 'node:crypto';

const BOT = /bot|crawl|spider|slurp|curl|wget|python|go-http|java\/|headless|preview|monitor|uptime|lighthouse|facebookexternalhit|embed/i;
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
function periods(d = new Date()) {
    const day = utcDay(d);
    const dt = new Date(day + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // Monday of this ISO week
    return { d: day, w: utcDay(dt), m: day.slice(0, 7) };
}
const COUNTERS = ['visitors', 'pageviews', 'wiki_views', 'logins', 'signups', 'relay_calls'];

export function createStats({ pool, secret }) {
    let pending = new Map();      // day -> counters not yet written
    let visitorDay = null, visitorSalt = null, visitorSet = new Set();
    let cacheDay = null;
    const seenCache = new Set();

    const bump = (day, k, n = 1) => {
        let c = pending.get(day);
        if (!c) pending.set(day, c = Object.fromEntries(COUNTERS.map(x => [x, 0])));
        c[k] += n;
    };

    /** A page was loaded (HTML only, never API/asset requests). Bots are skipped by user agent, which is never stored. */
    function view(req, wiki = false) {
        try {
            const ua = req.headers['user-agent'] || '';
            if (!ua || BOT.test(ua) || req.headers.purpose === 'prefetch' || req.headers['sec-purpose']) return;
            const day = utcDay();
            bump(day, 'pageviews');
            if (wiki) bump(day, 'wiki_views');
            if (visitorDay !== day) { visitorDay = day; visitorSalt = crypto.randomBytes(16); visitorSet = new Set(); } // yesterday's salt and set are dropped here
            const h = crypto.createHmac('sha256', visitorSalt).update(String(req.ip)).digest('base64').slice(0, 12);
            if (!visitorSet.has(h)) { visitorSet.add(h); bump(day, 'visitors'); }
        } catch { /* stats must never break a request */ }
    }
    const count = (k, n = 1) => { try { bump(utcDay(), k, n); } catch { /* */ } };

    /** An authenticated request happened: count the account once per day/week/month. */
    async function markActive(userId) {
        try {
            const p = periods();
            if (cacheDay !== p.d) { cacheDay = p.d; seenCache.clear(); }
            for (const kind of ['d', 'w', 'm']) {
                const key = kind + p[kind] + ':' + userId;
                if (seenCache.has(key)) continue;
                seenCache.add(key);
                const h = crypto.createHmac('sha256', secret).update(`stats:${kind}:${p[kind]}:${userId}`).digest().subarray(0, 16);
                const r = await pool.query('INSERT INTO stats_seen (kind, period, h) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [kind, p[kind], h]);
                if (r.rowCount) await pool.query('INSERT INTO stats_active (kind, period, n) VALUES ($1,$2,1) ON CONFLICT (kind, period) DO UPDATE SET n = stats_active.n + 1', [kind, p[kind]]);
            }
        } catch { /* */ }
    }

    async function flush() {
        const batch = pending; pending = new Map();
        for (const [day, c] of batch) {
            try {
                await pool.query(
                    `INSERT INTO stats_daily (day, ${COUNTERS.join(',')}) VALUES ($1, ${COUNTERS.map((_, i) => '$' + (i + 2)).join(',')})
                     ON CONFLICT (day) DO UPDATE SET ${COUNTERS.map(k => `${k} = stats_daily.${k} + EXCLUDED.${k}`).join(', ')}`,
                    [day, ...COUNTERS.map(k => c[k])]);
            } catch (e) { for (const k of COUNTERS) bump(day, k, c[k]); console.error('[stats] flush failed', e.message); }
        }
    }

    /** Forget dedupe hashes of finished periods. */
    async function purge() {
        const p = periods();
        await pool.query(`DELETE FROM stats_seen WHERE (kind='d' AND period<>$1) OR (kind='w' AND period<>$2) OR (kind='m' AND period<>$3)`, [p.d, p.w, p.m]);
    }

    async function init() {
        // One-time backfill of sign-up history from account creation dates (data that already exists).
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM stats_daily');
        if (!rows[0].n) await pool.query(`INSERT INTO stats_daily (day, signups) SELECT (created_at AT TIME ZONE 'UTC')::date, count(*) FROM users GROUP BY 1 ON CONFLICT DO NOTHING`);
        await purge();
        setInterval(() => { flush(); }, 20_000).unref();
        setInterval(() => { purge().catch(() => { }); }, 3600_000).unref();
    }

    async function summary(days) {
        await flush();
        days = Math.max(7, Math.min(365, days | 0 || 30));
        const q = (sql, a) => pool.query(sql, a).then(r => r.rows);
        const [daily, active, tot, buckets, sess, legacy, actW, actM] = await Promise.all([
            q(`SELECT day::text AS day, visitors, pageviews, wiki_views, logins, signups, relay_calls FROM stats_daily WHERE day > ((now() AT TIME ZONE 'UTC')::date - $1::int) ORDER BY day`, [days]),
            q(`SELECT period, n FROM stats_active WHERE kind='d' AND period > to_char((now() AT TIME ZONE 'UTC')::date - $1::int, 'YYYY-MM-DD')`, [days]),
            q(`SELECT count(*)::int AS accounts, coalesce(sum(used_bytes),0)::float8 AS bytes, coalesce(avg(used_bytes),0)::float8 AS avg FROM users`),
            q(`SELECT count(*) FILTER (WHERE used_bytes = 0)::int AS b0, count(*) FILTER (WHERE used_bytes > 0 AND used_bytes < 1048576)::int AS b1, count(*) FILTER (WHERE used_bytes >= 1048576 AND used_bytes < 10485760)::int AS b2, count(*) FILTER (WHERE used_bytes >= 10485760 AND used_bytes < 104857600)::int AS b3, count(*) FILTER (WHERE used_bytes >= 104857600)::int AS b4 FROM users`),
            q(`SELECT count(*)::int AS sessions, count(DISTINCT user_id)::int AS signed_in FROM sessions WHERE expires_at > now()`),
            q(`SELECT count(*) FILTER (WHERE claimed_user IS NULL)::int AS pending, count(*) FILTER (WHERE claimed_user IS NOT NULL)::int AS claimed FROM legacy_accounts`),
            q(`SELECT period, n FROM stats_active WHERE kind='w' ORDER BY period DESC LIMIT 12`),
            q(`SELECT period, n FROM stats_active WHERE kind='m' ORDER BY period DESC LIMIT 12`),
        ]);
        const byDay = new Map(daily.map(r => [r.day, r]));
        const actByDay = new Map(active.map(r => [r.period, r.n]));
        const series = [];
        for (let i = days - 1; i >= 0; i--) {
            const d = utcDay(new Date(Date.now() - i * 86400_000));
            const r = byDay.get(d) || {};
            series.push({ day: d, visitors: r.visitors || 0, pageviews: r.pageviews || 0, wiki_views: r.wiki_views || 0, logins: r.logins || 0, signups: r.signups || 0, relay_calls: r.relay_calls || 0, active: actByDay.get(d) || 0 });
        }
        const p = periods();
        return {
            generated: new Date().toISOString(), days, series, periods: p,
            weekly: actW.reverse(), monthly: actM.reverse(),
            totals: { ...tot[0], ...sess[0], legacyPending: legacy[0].pending, legacyClaimed: legacy[0].claimed },
            storageBuckets: buckets[0],
        };
    }

    return { view, count, markActive, flush, init, summary };
}
