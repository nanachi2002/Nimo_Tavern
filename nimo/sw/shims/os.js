export const EOL = '\n';
export function platform() { return 'linux'; }
export function type() { return 'Linux'; }
export function homedir() { return '/home/user'; }
export function tmpdir() { return '/tmp'; }
export function hostname() { return 'nimotavern'; }
export function cpus() { return [{ model: 'browser' }]; }
export function totalmem() { return 0; }
export function freemem() { return 0; }
export function networkInterfaces() { return {}; }
export function arch() { return 'wasm'; }
export function release() { return ''; }
export default { EOL, platform, type, homedir, tmpdir, hostname, cpus, totalmem, freemem, networkInterfaces, arch, release };
