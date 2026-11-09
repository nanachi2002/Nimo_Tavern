// Shared mutable runtime state of the NimoTavern Service Worker.
export const nimoState = {
    ready: false,
    username: null,
    relayEnabled: false,
    relayAlways: false,
    optimizeImages: true, // convert uploaded PNG/JPEG pictures to WebP (saves storage); user can turn it off in Account
};
