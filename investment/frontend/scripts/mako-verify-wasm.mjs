// Compare the real frozen migration source in native Rust and Wasm. No network.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import wasm from '../../crates/wasm/pkg-node/robinlab_wasm.js';
const dir=resolve(process.argv[2]??'');
if(!process.argv[2]) throw new Error('Pass the protected migration snapshot directory.');
const load=async(name)=>JSON.parse(await readFile(resolve(dir,name),'utf8'));
const source=await load('source.json'), expected=await load('financial-current.json');
const readRows=async(name)=>(await readFile(resolve(dir,`${name}.jsonl`),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).row);
const latest=await readRows('latest_prices'),historical=await readRows('historical_prices');
const prices=latest.map(row=>({symbol:row.symbol,price:row.latest_price,price_date:row.latest_price_date}));
const {accounts,tickers,transactions,snapshots}= {...source.public,snapshots:source.public.account_value_snapshots};
transactions.sort((a,b)=>a.id-b.id);
const brokers=[...new Map(source.private.snaptrade_accounts.sort((a,b)=>a.snaptrade_account_id.localeCompare(b.snaptrade_account_id)).filter(r=>r.account_id!==null&&r.balance!==null).map(r=>[r.account_id,{account_id:r.account_id,balance:r.balance}])).values()];
const positionKey=r=>JSON.stringify([r.account_id,r.ticker_id,r.option_code,r.opened_date,r.status]);
const sortPositions=rows=>rows.sort((a,b)=>positionKey(a).localeCompare(positionKey(b)));
const sortPnl=rows=>rows.sort((a,b)=>a.account_id-b.account_id||a.ticker_id-b.ticker_id);
function parity(a,b,path='root') {
 if(typeof a==='number'&&typeof b==='number') {assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8+1e-12*Math.abs(b),`numeric difference at ${path}`);return;}
 if(Array.isArray(a)&&Array.isArray(b)) {assert.equal(a.length,b.length,`row count at ${path}`);a.forEach((v,i)=>parity(v,b[i],`${path}[${i}]`));return;}
 if(a&&b&&typeof a==='object'&&typeof b==='object') {assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),`fields at ${path}`);for(const k of Object.keys(a)) parity(a[k],b[k],`${path}.${k}`);return;}
 assert.ok(a===b,`value difference at ${path}`);
}
const checks={
 positions:()=>parity(sortPositions(wasm.positions(transactions,accounts,tickers,prices,undefined,true)),sortPositions(expected.enrichedPositions)),
 realizedPnl:()=>parity(sortPnl(wasm.realized_pnl(transactions,accounts,tickers,undefined)),sortPnl(expected.realizedPnl)),
 summary:()=>parity(wasm.portfolio_summary(transactions,accounts,tickers),expected.summary),
 accountsPerformance:()=>parity(wasm.account_performance_snapshot(transactions,accounts,tickers,prices,brokers,source.asOf,historical,snapshots),expected.accountsPerformance),
 yield:()=>parity(wasm.portfolio_yield(transactions,accounts,tickers,prices,source.asOf),expected.yield),
};
for(const [name,check] of Object.entries(checks)) {check();console.log(`Passed native/Wasm: ${name}`);}
await writeFile(resolve(dir,'wasm-verification.json'),JSON.stringify({complete:true,checks:Object.keys(checks),absoluteTolerance:1e-8,relativeTolerance:1e-12})+'\n',{mode:0o600,flag:'wx'});
