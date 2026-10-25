import fs from 'node:fs';
import path from 'node:path';
import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { observeAcquisitionRuntime } from './mcpAcquisitionActivation.js';
import { rollbackAcquisitionPublication } from './mcpAcquisitionPublicationSettings.js';
import type { JsonPublicationReservation } from './mcpAcquisitionJsonPublication.js';
import { withJsonDaoTransaction } from './jsonDaoTransaction.js';
import { withJsonSettingsFileLock } from './jsonSettingsFileLock.js';

interface ActivationDependencies {
  repository: Pick<AcquisitionOperationRepository, 'claimActivation' | 'completeActivation' | 'requireReconciliation'>;
  observe: typeof observeAcquisitionRuntime;
}

/** Observation never mutates persisted configuration. Uncertain activation requires reconciliation. */
export async function activateJsonAcquisition(owner: string, operationId: string, settingsPath: string,
  overrides?: ActivationDependencies) {
  const { repository, observe } = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()), observe: observeAcquisitionRuntime,
  };
  const claim = await repository.claimActivation(owner, operationId);
  if (!claim) return { status: 'not_claimed' as const };
  try {
    const publication = claim.publication as JsonPublicationReservation;
    const target = path.resolve(settingsPath);
    if (publication.storage !== 'json' || path.resolve(publication.settingsPath) !== target ||
        publication.receipt.operationId !== operationId || publication.receipt.server.owner !== owner) {
      throw new Error('Activation does not match the publication owner or settings');
    }
    const validateCurrent = () => {
      const current = JSON.parse(fs.readFileSync(target, 'utf8'));
      // Exercise compare-only rollback validation without applying the returned document.
      rollbackAcquisitionPublication(current, publication.receipt);
      if (!current.mcpServers?.[publication.receipt.serverName] ||
          !current.groups?.some((group: { id: string; servers: Array<string | { name: string }> }) =>
            group.id === publication.receipt.groupId && group.servers.some(entry =>
              (typeof entry === 'string' ? entry : entry.name) === publication.receipt.serverName))) {
        throw new Error('Published resources are no longer present');
      }
    };
    await withJsonDaoTransaction(() => withJsonSettingsFileLock(target, validateCurrent));
    const evidence = await observe(publication.receipt);
    // Keep the last configuration comparison and readiness commit inside the cooperative lock.
    await withJsonDaoTransaction(() => withJsonSettingsFileLock(target, async () => {
      validateCurrent();
      if (!await repository.completeActivation(owner, operationId, claim.activation_claim_id, evidence)) {
        throw new Error('Activation readiness could not be committed');
      }
    }));
    return { status: 'ready' as const };
  } catch {
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, claim.claim_id); } catch { /* retained claim prevents replay */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
}
