// Public deployment metadata only; never put credentials in frontend config.
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
let config;
try { config = JSON.parse(await readFile(new URL('rational.config.json', root), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; config = JSON.parse(await readFile(new URL('rational.config.example.json', root), 'utf8')); }
const owner = JSON.parse(await readFile(new URL('investment/mako/owner.json', root), 'utf8'));
const publicConfig = { endpoint: config.endpoint, projectId: config.projectId, environmentId: config.environmentId, publicProjectKey: config.publicProjectKey, ownerId: owner.ownerId };
await writeFile(new URL('investment/frontend/src/api/mako-config.json', root), JSON.stringify(publicConfig, null, 2) + '\n');
// The native rollback server requires a separately provisioned worker binding.
// Do not carry an obsolete source-environment worker into the consolidated app.
await writeFile(new URL('investment/mako/runtime.json', root), JSON.stringify(publicConfig, null, 2) + '\n');
