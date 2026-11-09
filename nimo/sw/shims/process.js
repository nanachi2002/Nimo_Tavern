import p from 'process/browser.js';
p.env = p.env || {};
p.platform = 'linux';
p.versions = {}; // no 'node' key: emscripten modules must detect a worker, not Node
p.version = 'v22.0.0';
p.cwd = () => '/srv';
p.exit = () => { throw new Error('process.exit called'); };
p.memoryUsage = () => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0 });
p.hrtime = Object.assign((prev) => { const t = performance.now(); const s = Math.floor(t / 1000), ns = Math.floor((t % 1000) * 1e6); return prev ? [s - prev[0], ns - prev[1]] : [s, ns]; }, { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) });
p.stdout = { write: (s) => console.log(s), isTTY: false };
p.stderr = { write: (s) => console.error(s), isTTY: false };
p.argv = ['node', 'server.js'];
p.pid = 1;
p.uptime = () => performance.now() / 1000;
p.on = () => p; p.once = () => p;
export default p;
export const env = p.env, platform = p.platform, cwd = p.cwd, nextTick = p.nextTick, argv = p.argv, versions = p.versions;
