import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export class SettingsTransactionConflict extends Error {}
const ownership = new AsyncLocalStorage<{ path: string; active: boolean }>();

/** Reentrant for nested calls, retained until an asynchronous outer operation settles. */
export function withJsonSettingsFileLock<T>(settingsPath: string, work: () => T, readOnlyFallback = false): T {
  const target = path.resolve(settingsPath);
  const current = ownership.getStore();
  if (current?.active && current.path === target) return work();
  const lock = path.join(path.dirname(target), `.${path.basename(target)}.mcphub-lock`);
  const token = randomUUID();
  const intent = `${lock}.${process.pid}.${token}.owner`;
  const record = JSON.stringify({ version: 1, token, pid: process.pid, createdAt: new Date().toISOString() });
  let fd: number | undefined;
  let intentCreated = false;
  let published = false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(intent, 'wx', 0o600);
    intentCreated = true;
    fs.writeFileSync(fd, record, 'utf8');
    fs.fsyncSync(fd);
    // Exclusive publication: an incomplete record is never visible at the shared path.
    // Both names are in the same directory/filesystem. No partial-copy fallback.
    fs.linkSync(intent, lock);
    published = true;
    fs.unlinkSync(intent);
    intentCreated = false;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (published && fs.readFileSync(lock, 'utf8') === record) fs.unlinkSync(lock);
    if (intentCreated) fs.unlinkSync(intent);
    const code = (error as NodeJS.ErrnoException).code;
    if (readOnlyFallback && ['EROFS', 'EACCES', 'EPERM'].includes(code ?? '')) return work();
    if (code === 'EEXIST') throw new SettingsTransactionConflict('Settings transaction is busy or requires stale-lock reconciliation');
    throw error;
  }
  const context = { path: target, active: true };
  const release = () => {
    context.active = false;
    fs.closeSync(fd!);
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === record) fs.unlinkSync(lock);
  };
  try {
    return ownership.run(context, () => {
      const result = work();
      if (result && typeof (result as any).then === 'function') {
        return Promise.resolve(result).finally(release) as T;
      }
      release(); return result;
    });
  } catch (error) {
    if (context.active) release();
    throw error;
  }
}
