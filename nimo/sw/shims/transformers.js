// Server-side ML models (Transformers.js/ONNX) are disabled in NimoTavern.
const NA = () => { throw new Error('Local ML models are not available in NimoTavern'); };
export async function getRawImage() { NA(); }
export async function getPipeline() { NA(); }
export default { getRawImage, getPipeline };
