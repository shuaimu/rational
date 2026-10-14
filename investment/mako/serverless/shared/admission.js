import {ensure} from './errors.js';
// Deployment-specific modes are pinned in the bundle. Migration packaging may
// choose read-only, draining, or closed; unknown modes fail closed.
export const RUNTIME_MODE = 'active';
export function checkAdmission(mode, method, path) {
 if(mode==='active')return;
 const jobRead=method==='GET'&&(path==='/jobs'||/^\/jobs\/j_[a-f0-9]{64}$/.test(path));
 if(mode==='draining'&&jobRead)return;
 const safeMetadataRead=['/snaptrade/status','/admin/cache-coverage','/admin/cache-price-trend'].includes(path);
 if(mode==='read-only'&&method==='GET'&&(safeMetadataRead||!path.startsWith('/admin/')&&!path.startsWith('/snaptrade/')))return;
 ensure(false,503,'Investment writes are paused for migration. Open Rational Investment at https://shuaimu.github.io/rational/investment/ and retry the same command after cutover.');
}
