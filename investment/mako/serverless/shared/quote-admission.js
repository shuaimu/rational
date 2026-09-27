// The API and dispatcher share the same durable UTC-hour identity.
export const PRICE_REFRESH_ENABLED=true;
export async function admitQuotes(jobs,due){
 const hour=new Date(due).toISOString().slice(0,13).replace(/[-T]/g,'');
 return jobs.admit(`market_quotes_${hour}`,'prefetch',{mode:'quotes_auto'});
}
