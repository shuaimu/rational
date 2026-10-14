import { readFile, writeFile } from 'node:fs/promises';
const names = { portfolio_heads: 'head', portfolio_public: 'content', latest_prices: 'latest_prices', historical_prices: 'historical_prices' };
const schemas = {};
for (const [collection, file] of Object.entries(names)) schemas[collection] = JSON.parse(await readFile(new URL(`../../mako/schemas/${file}.json`, import.meta.url), 'utf8'));
schemas.cache_status = JSON.parse(await readFile(new URL('../../mako/serverless/schemas/cache_status.json', import.meta.url), 'utf8'));
await writeFile(new URL('../src/api/mako-schemas.json', import.meta.url), JSON.stringify(schemas, null, 2) + '\n');
