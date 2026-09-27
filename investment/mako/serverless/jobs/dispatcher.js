import {ensure} from '../shared/errors.js';
export {admitQuotes} from '../shared/quote-admission.js';
export const hourlyOptions={apply:true,reconstruct_rolls:true,fresh:false,replace:false,roll_detect:false,start_date:null};
export async function admitHourly(jobs,due){
 const timestamp=Date.parse(due);ensure(Number.isFinite(timestamp),400,'Invalid scheduled time');
 const hour=new Date(timestamp).toISOString().slice(0,13).replace(/[-T]/g,'');
 return jobs.admit(`snaptrade_hourly_${hour}`,'snaptrade',hourlyOptions);
}
// The native timer is retired; Mako's dispatcher owns hourly admission.
export const HOURLY_SYNC_ENABLED=true;
