import { mkdir, cp, rm } from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const destination=new URL('.local/mako-serverless/qualification-bundle/',root);
await rm(destination,{recursive:true,force:true});
await mkdir(destination,{recursive:true,mode:0o700});
for (const name of ['index.ts','portfolio.ts','workbooks.js','workbook-fixtures.json']) await cp(new URL(`mako/serverless/qualification/${name}`,root),new URL(name,destination));
for (const name of ['robinlab_function_wasm.js','robinlab_function_wasm.d.ts','robinlab_function_wasm_bg.wasm']) await cp(new URL(`mako/serverless/generated/${name}`,root),new URL(name,destination));
await mkdir(new URL('shared/',destination));
for (const name of ['errors.js','uploads.js','providers.js']) await cp(new URL(`mako/serverless/shared/${name}`,root),new URL(`shared/${name}`,destination));
