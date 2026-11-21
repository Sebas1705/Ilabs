// Loaded only by a dynamic import from ort.ts, so neither this file nor ONNX Runtime Web is in the base bundle.
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

// One thread: the multi-threaded build needs a cross-origin isolated page (SharedArrayBuffer).
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };

export default ort;
