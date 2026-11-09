// Server-side SSRF filter is irrelevant in the browser (requests come from the user's own browser).
export function getUntrustedRequestAgent() { return undefined; }
export default function initPrivateRequestFilter() { }
