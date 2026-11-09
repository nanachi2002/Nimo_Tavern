// Generic stub (CommonJS so any named import resolves) for Node built-ins / packages
// that cannot run in a browser.
const handler = {
    get(target, prop) {
        if (prop === '__esModule') return false;
        if (prop === 'default') return proxy;
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === 'then' || prop === Symbol.iterator || prop === Symbol.asyncIterator) return undefined;
        return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
};
const proxy = new Proxy(function () { }, handler);
module.exports = proxy;
