import {utcDay} from '../shared/quote-admission.js';
export {admitQuotes} from '../shared/quote-admission.js';
export const dailyOptions={apply:true,reconstruct_rolls:true,fresh:false,replace:false,roll_detect:false,start_date:null};
export async function admitDaily(jobs,due){
 return jobs.admit(`snaptrade_daily_${utcDay(due)}`,'snaptrade',dailyOptions);
}
// The native timer is retired; Mako's hourly dispatcher owns daily admission.
export const DAILY_SYNC_ENABLED=true;
