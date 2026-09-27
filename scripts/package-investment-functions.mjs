import { mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const mode = option('--mode') ?? 'read-only';
if (!['active', 'read-only', 'draining', 'closed'].includes(mode)) throw new Error('Invalid runtime mode');
const output = resolve(option('--output') ?? '.local/integration/bundles');
const source = fileURLToPath(new URL('../investment/mako/serverless/', import.meta.url));
for (const kind of ['api', 'jobs']) {
  const target = join(output, kind);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const directory of [kind, 'shared', 'generated']) await cp(join(source, directory), join(target, directory), { recursive: true });
  const gate = join(target, 'shared/admission.js');
  await writeFile(gate, (await readFile(gate, 'utf8')).replace("export const RUNTIME_MODE = 'active';", `export const RUNTIME_MODE = '${mode}';`));
}
if (mode === 'closed') {
  const target = join(output, 'retired-writer');
  await rm(target, { recursive: true, force: true });
  await cp(join(source, 'retired-writer'), target, { recursive: true });
}
console.log(`Packaged api/jobs in ${mode} mode at ${output}`);
