import {ensure} from './errors.js';
// The API and dispatcher share the same durable UTC-day identity.
export const PRICE_REFRESH_ENABLED=true;
export function utcDay(due){
 const timestamp=new Date(due).getTime();ensure(Number.isFinite(timestamp),400,'Invalid scheduled time');
 return new Date(timestamp).toISOString().slice(0,10).replace(/-/g,'');
}
export async function admitQuotes(jobs,due){
 return jobs.admit(`market_quotes_daily_${utcDay(due)}`,'prefetch',{mode:'quotes_auto'});
}
