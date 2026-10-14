import { api, ApiRequestError } from './http';
import { onClearProtectedState, requireOwnerScope } from './auth';
import { JobFailure } from './jobs';
import type { ImportResult } from './types';
type Upload = { commandId: string; id?: string; chunkBytes?: number; chunks?: number; next: number; sealed?: boolean };
const prefix = 'robinlab.uploads.';
const key = (scope: string) => prefix + encodeURIComponent(scope);
const read = (scope: string): Record<string, Upload> => JSON.parse(localStorage.getItem(key(scope)) ?? '{}');
onClearProtectedState(async nextScope => {
  for (const name of Object.keys(localStorage)) if (name.startsWith(prefix) && name !== (nextScope ? key(nextScope) : '')) localStorage.removeItem(name);
});
export async function uploadWorkbook(file: File, progress?: (percent: number) => void): Promise<ImportResult> {
  if (file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error('Choose a workbook no larger than 50 MiB.');
  const scope = requireOwnerScope();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
  let upload = read(scope)[digest] ?? { commandId: `upload_${crypto.randomUUID()}`, next: 0 };
  const save = () => {
    if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
    const saved = read(scope); saved[digest] = upload; localStorage.setItem(key(scope), JSON.stringify(saved));
  };
  save();
  try {
  if (!upload.id) {
    const { data } = await api.post<{ id: string; chunkBytes: number; chunks: number }>('/uploads', { bytes: file.size, digest }, { headers: { 'Idempotency-Key': upload.commandId } });
    if (!/^u_[a-f0-9]{64}$/.test(data.id) || data.chunkBytes !== 256 * 1024 || data.chunks !== Math.ceil(file.size / data.chunkBytes)) throw new Error('The upload configuration is invalid.');
    upload = { ...upload, ...data }; save();
  }
  for (let index = upload.next; index < upload.chunks!; index++) {
    const chunk = await file.slice(index * upload.chunkBytes!, (index + 1) * upload.chunkBytes!).arrayBuffer();
    await api.put(`/uploads/${upload.id}/chunks/${index}`, chunk, { headers: { 'Content-Type': 'application/octet-stream' } });
    upload.next = index + 1; save(); progress?.(Math.round(upload.next / upload.chunks! * 100));
  }
  if (!upload.sealed) { await api.post(`/uploads/${upload.id}/seal`, {}); upload.sealed = true; save(); }
  progress?.(100);
  // Keep import identity with the upload, even when background job recovery
  // finishes and clears the general command journal after a page reload.
  const result = await api.post<ImportResult>('/import/excel', { uploadId: upload.id }, { headers: { 'Idempotency-Key': `${upload.commandId}_import` } });
  if (requireOwnerScope() !== scope) throw new Error('Application session changed.');
  const saved = read(scope); delete saved[digest]; localStorage.setItem(key(scope), JSON.stringify(saved));
  return result.data;
  } catch (error) {
    if ((error instanceof ApiRequestError && error.status === 410 || error instanceof JobFailure && ['failed', 'cancelled'].includes(error.state)) && requireOwnerScope() === scope) {
      const saved = read(scope); delete saved[digest]; localStorage.setItem(key(scope), JSON.stringify(saved));
    }
    throw error;
  }
}
