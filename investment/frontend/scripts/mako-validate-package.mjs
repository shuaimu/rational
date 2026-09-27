import Ajv from 'ajv';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
if(!process.argv[2])throw new Error('Pass a protected migration package directory.');
const directory=resolve(process.argv[2]),root=resolve(import.meta.dirname,'../..');
const ajv=new Ajv({allErrors:true,strict:true});const counts={};
for(const [collection,schemaName] of Object.entries({portfolio_public:'content',portfolio_private:'content',portfolio_commands:'content',historical_prices:'historical_prices',latest_prices:'latest_prices',provider_requests:'provider_requests',split_fetch:'split_fetch'})) {
 const validate=ajv.compile(JSON.parse(await readFile(resolve(root,`mako/schemas/${schemaName}.json`),'utf8')));let row=0;
 for await(const line of createInterface({input:createReadStream(resolve(directory,`${collection}.jsonl`)),crlfDelay:Infinity})) {
  row++;if(!validate(JSON.parse(line)))throw new Error(`Schema mismatch: ${collection} row ${row} (${validate.errors.map(e=>`${e.dataPath}:${e.keyword}`).join(', ')})`);
 }
 counts[collection]=row;console.log(`Validated ${collection}: ${row} documents`);
}
const validate=ajv.compile(JSON.parse(await readFile(resolve(root,'mako/schemas/head.json'),'utf8')));
if(!validate(JSON.parse(await readFile(resolve(directory,'head.json'),'utf8'))))throw new Error('Head schema mismatch');
await writeFile(resolve(directory,'schema-verification.json'),JSON.stringify({complete:true,counts})+'\n',{mode:0o600,flag:'wx'});
