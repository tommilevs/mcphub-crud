import { AsyncLocalStorage } from 'node:async_hooks';
import { withJsonSettingsFileLock } from './jsonSettingsFileLock.js';

const context = new AsyncLocalStorage<{ active: boolean }>();
let queue = Promise.resolve();
let busy = false;

/** Whole DAO operations, not individual writes, must share the critical section. */
export async function withJsonDaoTransaction<T>(work: () => T | Promise<T>): Promise<T> {
  if (context.getStore()?.active) return work();
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const token = { active: true };
  busy = true;
  try { return await context.run(token, work); }
  finally { token.active = false; busy = false; release(); }
}

/** Synchronous legacy writers cannot await the queue; fail rather than overwrite its in-flight snapshot. */
export function assertJsonDaoTransactionAccess(): void {
  if (busy && !context.getStore()?.active) throw new Error('Settings mutation conflicts with an active JSON transaction');
}

export function serializeJsonDao<T extends object>(dao: T, settingsPath?: () => string, lockReads = true): T {
  const seen = new Set<PropertyKey>();
  for (let prototype: object | null = dao; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const key of Reflect.ownKeys(prototype)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const value = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      // Preserve synchronous helpers and ordinary method replacement/decorators.
      if (typeof value !== 'function' || value.constructor.name !== 'AsyncFunction') continue;
      Object.defineProperty(dao, key, { configurable: true, writable: true,
        value: (...args: unknown[]) => withJsonDaoTransaction(() => {
          const read = /^(find|get|has|exists|count|list|read|load|validate|verify|check|is)([A-Z_]|$)/.test(String(key));
          const invoke = () => Reflect.apply(value, dao, args);
          return settingsPath && (!read || lockReads)
            ? withJsonSettingsFileLock(settingsPath(), invoke, read) : invoke();
        }) });
    }
  }
  return dao;
}
