// Builds the AI prompt for a multiplayer session: a compact version of SillyTavern's chat-completion prompt
// (main prompt, character card, world, lorebook, personas, examples, history, post-history instruction).
// Output: { system, messages: [{ role: 'user'|'assistant', content }] } with alternating roles, which every
// provider adapter (OpenAI-compatible, Anthropic, Gemini) can send as is.

export const DEFAULT_MAIN = 'Write {{char}}\'s next reply in a fictional group roleplay between {{char}} and the players: {{group}}. '
    + 'Each player controls their own character; the persona descriptions below say who they are. '
    + 'Narrate the world and any side characters as needed, react to every player\'s latest action, and keep the story moving. '
    + 'Never write dialogue, thoughts or actions for the players\' characters.';
export const DEFAULT_POST = 'It is now {{char}}\'s turn. Respond to the players\' latest actions. Do not speak or act for {{group}}.';

/** Rough token estimate (no tokenizer on the server): ~3.5 characters per token. */
export const estTokens = (s) => Math.ceil((s?.length || 0) / 3.5);

function listNames(names) {
    if (names.length <= 1) return names[0] || 'the players';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function macros(text, ctx) {
    return String(text || '')
        .replace(/\{\{char\}\}/gi, ctx.char)
        .replace(/\{\{(user|group|persona)\}\}/gi, ctx.group)
        .replace(/\{\{charIfNotGroup\}\}/gi, ctx.group)
        .replace(/\{\{(original|trim)\}\}/gi, '')
        .replace(/<USER>/g, ctx.group).replace(/<BOT>/g, ctx.char);
}

function keyMatches(key, text, entry) {
    key = String(key || '').trim();
    if (!key) return false;
    const re = /^\/(.+)\/([a-z]*)$/s.exec(key);
    if (re) { try { return new RegExp(re[1], re[2].replace(/[gy]/g, '')).test(text); } catch { return false; } }
    const cs = !!entry.caseSensitive;
    const hay = cs ? text : text.toLowerCase();
    const needle = cs ? key : key.toLowerCase();
    if (entry.matchWholeWords !== false && /^[\p{L}\p{N}_ ]+$/u.test(needle)) {
        const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, cs ? 'u' : 'iu').test(hay);
    }
    return hay.includes(needle);
}

/**
 * SillyTavern World Info activation, simplified: constant entries, primary keys, optional secondary keys with
 * selectiveLogic (0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL), per-entry or default scan depth, order, budget.
 */
export function activateLore(entries, history, { depth = 4, budget = 2048 } = {}) {
    const active = [];
    for (const e of entries || []) {
        if (!e || e.disable || !String(e.content || '').trim()) continue;
        if (e.constant) { active.push(e); continue; }
        const d = Number.isInteger(e.scanDepth) && e.scanDepth >= 0 ? e.scanDepth : depth;
        const text = history.slice(-Math.max(1, d)).map((m) => m.text).join('\n');
        if (!(e.key || []).some((k) => keyMatches(k, text, e))) continue;
        const sec = (e.keysecondary || []).filter((k) => String(k).trim());
        if (e.selective && sec.length) {
            const hits = sec.map((k) => keyMatches(k, text, e));
            const logic = e.selectiveLogic ?? 0;
            const ok = logic === 0 ? hits.some(Boolean) : logic === 1 ? !hits.every(Boolean) : logic === 2 ? !hits.some(Boolean) : hits.every(Boolean);
            if (!ok) continue;
        }
        active.push(e);
    }
    active.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    const out = []; let used = 0;
    for (const e of active) {
        const t = estTokens(e.content);
        if (used + t > budget) continue;
        out.push(e); used += t;
    }
    return out;
}

/**
 * @param {object} cfg       sealed session config: card, world, lorebook, prompts, sampling
 * @param {Array} players    [{ name, description }] players with a persona, in turn order
 * @param {Array} history    [{ kind: 'ai'|'player'|'ooc'|'system', name, text }] in chat order
 */
export function buildPrompt(cfg, players, history) {
    const card = cfg.card || {};
    const ctx = { char: card.name || 'Character', group: listNames(players.map((p) => p.name)) };
    const story = history.filter((m) => m.kind === 'ai' || m.kind === 'player');
    const sampling = cfg.sampling || {};
    const contextTokens = Math.max(1024, Math.min(Number(sampling.context) || 16384, 2_000_000));
    const replyTokens = Math.max(16, Math.min(Number(sampling.maxTokens) || 600, 32_000));

    const sys = [];
    sys.push(macros(card.system_prompt || cfg.prompts?.main || DEFAULT_MAIN, ctx));
    if (card.description) sys.push(macros(card.description, ctx));
    if (card.personality) sys.push(`${ctx.char}'s personality: ${macros(card.personality, ctx)}`);
    if (card.scenario) sys.push(`Scenario: ${macros(card.scenario, ctx)}`);
    if (cfg.world) sys.push(`World setting:\n${macros(cfg.world, ctx)}`);
    const lore = activateLore(cfg.lorebook, story, { depth: Number(cfg.loreDepth) || 4, budget: Math.floor(contextTokens * 0.25) });
    if (lore.length) sys.push(lore.map((e) => macros(e.content, ctx)).join('\n'));
    if (players.length) sys.push('The players and their characters:\n' + players.map((p) => `- ${p.name}${p.description ? ': ' + macros(p.description, ctx) : ''}`).join('\n'));
    if (card.mes_example) sys.push(`Examples of how ${ctx.char} writes:\n` + macros(card.mes_example, ctx).replace(/<START>/gi, '***').trim());
    const system = sys.filter(Boolean).join('\n\n');
    const post = macros(card.post_history_instructions || cfg.prompts?.post || DEFAULT_POST, ctx);

    // History, newest first, until the context budget (minus the reply and the fixed parts) is used up.
    let budget = contextTokens - replyTokens - estTokens(system) - estTokens(post) - 32;
    const picked = [];
    for (let i = story.length - 1; i >= 0 && budget > 0; i--) {
        const m = story[i];
        const content = m.kind === 'player' ? `${m.name}: ${m.text}` : m.text;
        const t = estTokens(content) + 4;
        if (t > budget && picked.length) break;
        picked.unshift({ role: m.kind === 'ai' ? 'assistant' : 'user', content });
        budget -= t;
    }
    // Strict alternation (Anthropic/Gemini require it): merge neighbours with the same role; start with a user turn.
    const messages = [];
    for (const m of picked) {
        const last = messages[messages.length - 1];
        if (last && last.role === m.role) last.content += '\n\n' + m.content;
        else messages.push({ ...m });
    }
    if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(The session begins.)' });
    const last = messages[messages.length - 1];
    if (last.role === 'user') last.content += `\n\n[${post}]`;
    else messages.push({ role: 'user', content: `[${post}]` });
    return { system, messages, maxTokens: replyTokens, temperature: sampling.temperature, topP: sampling.topP, charName: ctx.char };
}
