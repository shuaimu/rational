// Shared calculation loader, independent of persistence and authentication.
import initWasm, * as wasmMod from '../wasm/robinlab_wasm.js';
import wasmUrl from '../wasm/robinlab_wasm_bg.wasm?url';

let wasmReady: Promise<typeof wasmMod> | null = null;
/** Initialize the WASM module once; resolves to its function namespace. */
export function ensureWasm(): Promise<typeof wasmMod> {
  // Object form (not the deprecated positional arg) to avoid wasm-bindgen's init warning.
  if (!wasmReady) wasmReady = initWasm({ module_or_path: wasmUrl }).then(() => wasmMod);
  return wasmReady;
}
