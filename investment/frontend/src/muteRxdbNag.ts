// RxDB's free Dexie storage prints a multi-line "consider our premium plugins" banner
// (with a full stack trace) on every storage-instance init — see
// node_modules/rxdb/.../rx-storage-instance-dexie.js. It's purely informational, not an
// error, but it looks alarming and repeats on every load. Filter out just that one banner;
// every other console.warn passes through untouched.
const RXDB_NAG = 'RxDB Open Core RxStorage';
const original = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes(RXDB_NAG)) return;
  original(...args);
};
