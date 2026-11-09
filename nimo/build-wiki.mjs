// Wiki build: web/wiki/NN-slug.html fragments (+ _partials) are wrapped in web/wiki-layout.html
// with a sidebar, prev/next links and a client-side search index. Output: dist/pages/wiki/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function buildWiki() {
    const dir = path.join(here, 'web/wiki');
    const layout = fs.readFileSync(path.join(here, 'web/wiki-layout.html'), 'utf8');
    const out = path.join(here, 'dist/pages/wiki');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const partial = (n) => fs.readFileSync(path.join(dir, '_partials', n + '.html'), 'utf8');

    const pages = fs.readdirSync(dir).filter(f => /^\d+-.*\.html$/.test(f)).sort().map((f) => {
        let src = fs.readFileSync(path.join(dir, f), 'utf8');
        const take = (k) => {
            const m = src.match(new RegExp('<!--' + k + ' ([\\s\\S]*?) -->\\r?\\n?'));
            if (m) src = src.replace(m[0], '');
            return m ? m[1].trim() : '';
        };
        const meta = { title: take('TITLE'), icon: take('ICON') || 'fa-solid fa-book', group: take('GROUP') || 'Guides', desc: take('DESC') };
        meta.slug = f.replace(/^\d+-/, '').replace(/\.html$/, '');
        // partials can nest one level
        for (let i = 0; i < 2; i++) src = src.replace(/\{\{include:([a-z0-9-]+)\}\}/g, (_, n) => partial(n));
        return { ...meta, src };
    });

    const groups = [...new Set(pages.map(p => p.group))];
    const href = (p) => (p.slug === 'index' ? '/wiki' : '/wiki/' + p.slug);
    const index = [];

    pages.forEach((p, i) => {
        const heads = [];
        const used = new Set();
        let body = p.src.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, l, inner) => {
            const text = inner.replace(/<[^>]+>/g, '').trim();
            let id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
            while (used.has(id)) id += '-2';
            used.add(id);
            heads.push({ id, t: text });
            return '<h' + l + ' id="' + id + '" data-t="' + esc(text) + '">' + inner + ' <a class="anchor" href="#' + id + '" aria-label="Link to this section">#</a></h' + l + '>';
        });
        if (p.slug === 'index') {
            const cards = groups.map(g =>
                '<h3 class="wk-group-title">' + g + '</h3><div class="wk-cards">' +
                pages.filter(x => x.group === g && x.slug !== 'index').map(x =>
                    '<a class="wk-card nimo-glass" href="' + href(x) + '"><h3><i class="' + x.icon + '"></i> ' + x.title + '</h3><p>' + x.desc + '</p></a>').join('') + '</div>').join('');
            body = body.replace('{{CARDS}}', cards);
        }
        const side = groups.map(g => '<h4>' + g + '</h4>' + pages.filter(x => x.group === g).map(x =>
            '<a href="' + href(x) + '" class="' + (x === p ? 'on' : '') + '"><i class="' + x.icon + '"></i> ' + x.title + '</a>').join('')).join('');
        const prev = pages[i - 1], next = pages[i + 1];
        const pn = (prev ? '<a class="nimo-glass" href="' + href(prev) + '"><small>← Previous</small>' + prev.title + '</a>' : '<span></span>') +
            (next ? '<a class="nimo-glass next" href="' + href(next) + '"><small>Next →</small>' + next.title + '</a>' : '');
        const html = layout.replace(/\{\{TITLE\}\}/g, p.title).replace(/\{\{DESC\}\}/g, esc(p.desc)).replace('{{GROUP}}', p.group)
            .replace('{{ICON}}', p.icon).replace('{{SIDEBAR}}', () => side).replace('{{PREVNEXT}}', () => pn).replace('{{BODY}}', () => body);
        fs.writeFileSync(path.join(out, p.slug + '.html'), html);
        const text = body.replace(/<a class="anchor"[^>]*>#<\/a>/g, ' ').replace(/<!--nosearch-->[\s\S]*?<!--\/nosearch-->/g, ' ').replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
            .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
        index.push({ slug: p.slug, title: p.title, group: p.group, desc: p.desc, heads, text: text.slice(0, 9000) });
    });
    fs.writeFileSync(path.join(out, 'search.json'), JSON.stringify(index));
    console.log('wiki: ' + pages.length + ' pages');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildWiki();
