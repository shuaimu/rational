import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../mako/serverless/generated/', import.meta.url);
const bytes = await readFile(new URL('robinlab_function_wasm_bg.wasm', root));
await writeFile(new URL('manifest.json', root), JSON.stringify({interfaceVersion:1,wasmBindgen:'0.2.108',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
console.log(`Function Wasm: ${bytes.length} bytes`);
