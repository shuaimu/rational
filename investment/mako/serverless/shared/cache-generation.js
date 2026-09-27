const encoder=new TextEncoder();
export async function historicalDigest(rows){
 const values=rows.map(r=>[r.symbol,r.price_date,r.price,r.source,r.fetched_at,r.is_market_close]);
 values.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:a[1]>b[1]?1:0);
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(values))))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export function latestFromHistory(rows){
 const latest=new Map();
 for(const r of rows){const old=latest.get(r.symbol);if(!old||r.price_date>old.latest_price_date)latest.set(r.symbol,{symbol:r.symbol,latest_price_date:r.price_date,latest_price:r.price,source:r.source,fetched_at:r.fetched_at});}
 return [...latest.values()].sort((a,b)=>a.symbol<b.symbol?-1:a.symbol>b.symbol?1:0);
}
