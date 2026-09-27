import binding from '../../../mako/environment-migration.json';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Row = Record<string, unknown>;
const prefixes = ['robinlab.commands.', 'robinlab.jobs.', 'robinlab.uploads.'];
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const commandId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
export class PendingMigrationConflict extends Error {
  constructor() { super('Saved pending operations need reconciliation before Investment can open. Their original records have been retained.'); }
}
function requireValid(condition: unknown): asserts condition { if (!condition) throw new PendingMigrationConflict(); }
function matches(scope: unknown[], side: typeof binding.source) {
  return JSON.stringify(scope.slice(0, 5)) === JSON.stringify([side.endpoint, side.projectId, side.environmentId, side.ownerId, 1]);
}

// Only retry IDs, hashes and progress move. Never copy credentials, replicas or
// command bodies, and never submit a write while migrating browser state.
export function migratePendingOperations(storage: Store, nextScope: string | null): void {
  if (!nextScope) return;
  const target = JSON.parse(nextScope) as unknown[];
  if (!matches(target, binding.destination)) return;
  const writes = new Map<string, unknown>();
  const oldKeys: string[] = [];
  for (const key of Object.keys(storage)) {
    const prefix = prefixes.find(value => key.startsWith(value));
    if (!prefix) continue;
    let oldScope: string; let scope: unknown[];
    try { oldScope = decodeURIComponent(key.slice(prefix.length)); scope = JSON.parse(oldScope) as unknown[]; }
    catch { continue; }
    if (!Array.isArray(scope) || !matches(scope, binding.source)) continue;
    const destination: string = prefix + encodeURIComponent(nextScope);
    const source = JSON.parse(storage.getItem(key) ?? 'null') as unknown;
    const existing: unknown = writes.get(destination) ?? JSON.parse(storage.getItem(destination) ?? (prefix === 'robinlab.jobs.' ? '[]' : '{}')) as unknown;
    if (prefix === 'robinlab.jobs.') {
      requireValid(Array.isArray(source) && Array.isArray(existing));
      const jobs = new Map<string, Row>();
      for (const value of existing) { requireValid(object(value) && value.scope === nextScope && typeof value.id === 'string'); jobs.set(value.id, value); }
      for (const value of source) {
        requireValid(object(value) && value.scope === oldScope && typeof value.id === 'string' && /^j_[a-f0-9]{64}$/.test(value.id));
        const row: Row = { ...value, scope: nextScope };
        if (row.command !== undefined) { requireValid(object(row.command) && row.command.scope === oldScope && commandId(row.command.id)); row.command = { ...row.command, scope: nextScope }; }
        const previous = jobs.get(value.id);
        if (previous?.command && row.command) requireValid(object(previous.command) && object(row.command) && previous.command.id === row.command.id);
        jobs.set(value.id, { ...row, ...previous, command: previous?.command ?? row.command });
      }
      writes.set(destination, [...jobs.values()]);
    } else {
      requireValid(object(source) && object(existing));
      const merged = { ...existing };
      for (const [fingerprint, value] of Object.entries(source)) {
        requireValid(/^[a-f0-9]{64}$/.test(fingerprint) && object(value));
        const identity = prefix === 'robinlab.commands.' ? 'id' : 'commandId';
        requireValid(commandId(value[identity]));
        const previous = merged[fingerprint];
        if (previous !== undefined) {
          requireValid(object(previous) && previous[identity] === value[identity]);
          if (prefix === 'robinlab.uploads.' && previous.id && value.id) requireValid(previous.id === value.id);
        }
        merged[fingerprint] = { ...value, ...(object(previous) ? previous : {}) };
      }
      writes.set(destination, merged);
    }
    oldKeys.push(key);
  }
  // Validate every collision before writing anything. Keep originals if storage
  // fills during a write; rerunning reconciles identical IDs without duplication.
  for (const [key, value] of writes) storage.setItem(key, JSON.stringify(value));
  for (const key of oldKeys) storage.removeItem(key);
}
