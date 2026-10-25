import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { McpSettings } from '../types/index.js';
import { assertSmartRoutingSettingsAvailable } from '../utils/smartRoutingPath.js';
import { assertJsonDaoTransactionAccess } from './jsonDaoTransaction.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export class SettingsTransactionConflict extends Error {}

/** Cooperative cross-process lock plus atomic replacement; mutation must be synchronous.
 * Legacy writers that ignore this lock still need migration before concurrent publication is enabled.
 */
export function transactJsonSettings<T>(settingsPath: string,
  mutate: (current: McpSettings) => { settings: McpSettings; value: T }, expectedDigest?: string) {
  assertJsonDaoTransactionAccess();
  const target = path.resolve(settingsPath);
  const directory = path.dirname(target);
  const lock = path.join(directory, `.${path.basename(target)}.mcphub-lock`);
  const token = randomUUID();
  let lockFd: number;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new SettingsTransactionConflict('Settings transaction is busy or unavailable'); }
  let temporary: string | undefined;
  try {
    fs.writeFileSync(lockFd, token, 'utf8');
    const original = fs.readFileSync(target);
    const before = digest(original);
    if (expectedDigest !== undefined && expectedDigest !== before) throw new SettingsTransactionConflict('Settings revision changed');
    const current = JSON.parse(original.toString('utf8')) as McpSettings;
    if (!current || typeof current !== 'object' || Array.isArray(current) ||
        !current.mcpServers || typeof current.mcpServers !== 'object' || Array.isArray(current.mcpServers)) {
      throw new Error('Settings document is invalid');
    }
    const result = mutate(current);
    if (!result?.settings || typeof (result as any).then === 'function') throw new Error('Settings mutation must return synchronously');
    if (!result.settings.mcpServers || typeof result.settings.mcpServers !== 'object' || Array.isArray(result.settings.mcpServers)) {
      throw new Error('Updated settings document is invalid');
    }
    assertSmartRoutingSettingsAvailable(result.settings);
    const serialized = JSON.stringify(result.settings, null, 2);
    if (digest(fs.readFileSync(target)) !== before) throw new SettingsTransactionConflict('Settings revision changed');
    temporary = path.join(directory, `.${path.basename(target)}.${token}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (digest(fs.readFileSync(target)) !== before) throw new SettingsTransactionConflict('Settings revision changed');
    fs.renameSync(temporary, target);
    temporary = undefined;
    return { value: result.value, digest: digest(serialized) };
  } finally {
    fs.closeSync(lockFd);
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    // Never remove another participant's lock or automatically reclaim a stale lock.
    if (fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') === token) fs.unlinkSync(lock);
  }
}
