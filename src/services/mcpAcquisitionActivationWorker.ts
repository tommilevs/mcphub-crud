import fs from 'node:fs';
import path from 'node:path';
import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { observeAcquisitionRuntime } from './mcpAcquisitionActivation.js';
import { rollbackAcquisitionPublication } from './mcpAcquisitionPublicationSettings.js';
import type { JsonPublicationReservation } from './mcpAcquisitionJsonPublication.js';
import { withJsonDaoTransaction } from './jsonDaoTransaction.js';
import { withJsonSettingsFileLock } from './jsonSettingsFileLock.js';
import type { DataSource } from 'typeorm';
import type { PostgresPublicationReservation } from './mcpAcquisitionPublicationSettings.js';
import { withValidatedPostgresPublication } from './mcpAcquisitionPostgresPublication.js';
import { getAcquisitionSettingsStore } from './mcpAcquisitionPublication.js';

interface ActivationDependencies {
  repository: Pick<AcquisitionOperationRepository, 'claimActivation' | 'completeActivation' | 'requireReconciliation'>;
  observe: typeof observeAcquisitionRuntime;
}

export async function activateAcquisition(owner: string, operationId: string) {
  const store = await getAcquisitionSettingsStore();
  return store.kind === 'json' ? activateJsonAcquisition(owner, operationId, store.settingsPath)
    : activatePostgresAcquisition(owner, operationId, store.db);
}

/** Never hold settings locks while starting the runtime or waiting for embedding work. */
export async function activatePostgresAcquisition(owner: string, operationId: string, db: Pick<DataSource, 'transaction'>,
  overrides?: ActivationDependencies) {
  const { repository, observe } = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()), observe: observeAcquisitionRuntime,
  };
  const claim = await repository.claimActivation(owner, operationId);
  if (!claim) return { status: 'not_claimed' as const };
  try {
    const publication = claim.publication as PostgresPublicationReservation;
    if (publication.storage !== 'postgres' || publication.receipt.operationId !== operationId || publication.receipt.server.owner !== owner) {
      throw new Error('Activation does not match the publication owner or settings');
    }
    await withValidatedPostgresPublication(db, publication, async () => undefined);
    const evidence = await observe(publication.receipt);
    await withValidatedPostgresPublication(db, publication, async manager => {
      const journal = new AcquisitionOperationRepository({ query: (sql, args) => manager.query(sql, args) });
      if (!await journal.completeActivation(owner, operationId, claim.activation_claim_id, evidence)) {
        throw new Error('Activation readiness could not be committed');
      }
    });
    return { status: 'ready' as const };
  } catch {
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, claim.claim_id); } catch { /* retained claim prevents replay */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
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
