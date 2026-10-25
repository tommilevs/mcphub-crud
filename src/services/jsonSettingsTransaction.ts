import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { McpSettings } from '../types/index.js';
import { assertSmartRoutingSettingsAvailable } from '../utils/smartRoutingPath.js';
import { assertJsonDaoTransactionAccess } from './jsonDaoTransaction.js';
import { withJsonSettingsFileLock, SettingsTransactionConflict } from './jsonSettingsFileLock.js';
export { SettingsTransactionConflict } from './jsonSettingsFileLock.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Cooperative cross-process lock plus atomic replacement; mutation must be synchronous.
 * Legacy writers that ignore this lock still need migration before concurrent publication is enabled.
 */
export function transactJsonSettings<T>(settingsPath: string,
  mutate: (current: McpSettings) => { settings: McpSettings; value: T }, expectedDigest?: string) {
  assertJsonDaoTransactionAccess();
  const target = path.resolve(settingsPath);
  const directory = path.dirname(target);
  const token = randomUUID();
  return withJsonSettingsFileLock(target, () => {
  let temporary: string | undefined;
  try {
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
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  });
}
