export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export class ContinuationRequired extends ApiError {
  constructor(){super(503,'Operation needs another invocation; retry with the same command');}
}
export function ensure(condition, status = 503, message = 'Portfolio storage is inconsistent') {
  if (!condition) throw new ApiError(status, message);
}
export function publicError(error) {
  if (error instanceof ApiError) return { status:error.status, error:error.message };
  return { status:503, error:'Cloud operation is unavailable; retry with the same command' };
}
export function domainCall(invoke, input) {
  const response = JSON.parse(invoke(JSON.stringify({interfaceVersion:1,...input})));
  if (!response.ok) throw new ApiError(response.status, response.error);
  return response.result;
}
export async function batches(items, concurrency, action) {
  const output = [];
  for (let i=0;i<items.length;i+=concurrency) output.push(...await Promise.all(items.slice(i,i+concurrency).map(action)));
  return output;
}
export const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
