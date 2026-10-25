import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { clearSettingsCache } from '../config/index.js';
import type { McpSettings } from '../types/index.js';
import { withJsonDaoTransaction } from './jsonDaoTransaction.js';
import { withJsonSettingsFileLock } from './jsonSettingsFileLock.js';
import { transactJsonSettings } from './jsonSettingsTransaction.js';
import { prepareAcquisitionPublication, rollbackAcquisitionPublication, type PublicationReceipt } from './mcpAcquisitionPublicationSettings.js';

type Preparation = Parameters<typeof prepareAcquisitionPublication>;
export interface JsonPublicationInput {
  manifest: Preparation[1]; operationId: string; owner: string;
  launch: Preparation[4]; verifiedTools: string[]; secretReferences?: Record<string, string>;
}
export interface JsonPublicationReservation {
  storage: 'json'; settingsPath: string; baseDigest: string; receipt: PublicationReceipt;
}

/** The caller must durably reserve this receipt on its claimed operation before returning true.
 * A crash after reservation requires reconciliation, never an automatic replay.
 */
export async function publishJsonAcquisition(settingsPath: string, input: JsonPublicationInput,
  persistReservation: (reservation: JsonPublicationReservation) => Promise<boolean>) {
  const target = path.resolve(settingsPath);
  return withJsonDaoTransaction(() => withJsonSettingsFileLock(target, async () => {
    const bytes = fs.readFileSync(target);
    const baseDigest = createHash('sha256').update(bytes).digest('hex');
    const current = JSON.parse(bytes.toString('utf8')) as McpSettings;
    const prepared = prepareAcquisitionPublication(current, input.manifest, input.operationId, input.owner,
      input.launch, input.verifiedTools, input.secretReferences);
    const reservation: JsonPublicationReservation = { storage: 'json', settingsPath: target, baseDigest,
      receipt: structuredClone(prepared.receipt) };
    if (!await persistReservation(structuredClone(reservation))) {
      throw new Error('Publication reservation could not be committed');
    }
    const result = transactJsonSettings(target, () => ({ settings: prepared.settings, value: prepared.receipt }), baseDigest);
    clearSettingsCache();
    return { receipt: result.value, digest: result.digest };
  }));
}

export async function rollbackJsonAcquisition(settingsPath: string, reservation: JsonPublicationReservation) {
  const target = path.resolve(settingsPath);
  if (reservation.storage !== 'json' || target !== path.resolve(reservation.settingsPath)) {
    throw new Error('Publication receipt belongs to different settings');
  }
  return withJsonDaoTransaction(() => {
    const result = transactJsonSettings(target, current => ({
      settings: rollbackAcquisitionPublication(current, reservation.receipt), value: null,
    }));
    clearSettingsCache();
    return { digest: result.digest };
  });
}
