import path from 'node:path';
import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { rollbackJsonAcquisition, type JsonPublicationReservation } from './mcpAcquisitionJsonPublication.js';
import type { PublicationReceipt } from './mcpAcquisitionPublicationSettings.js';
import { withJsonSettingsFileLock } from './jsonSettingsFileLock.js';
import type { DataSource } from 'typeorm';
import type { PostgresPublicationReservation } from './mcpAcquisitionPublicationSettings.js';
import { rollbackPostgresAcquisition, withRemovedPostgresPublication } from './mcpAcquisitionPostgresPublication.js';
import { getAcquisitionSettingsStore } from './mcpAcquisitionPublication.js';

/** Stop only this operation's runtime, drain embedding work and verify removal. Package staging is retained. */
export async function cleanupAcquisitionRuntime(receipt: PublicationReceipt) {
  const runtime = await import('./mcpService.js');
  const info = runtime.getServerByName(receipt.serverName);
  if (info) {
    const assertOwnership = () => {
      if (runtime.getServerByName(receipt.serverName) !== info ||
        info.config?.owner !== receipt.server.owner || info.config?.options?.acquisitionOperationId !== receipt.operationId) {
        throw new Error('Runtime ownership changed; rollback requires reconciliation');
      }
    };
    assertOwnership();
    if (info.spawningPromise) await info.spawningPromise;
    assertOwnership();
    if (info.activeToolCalls) throw new Error('Acquired runtime still has active tool calls');
    await info.transport?.close();
    assertOwnership();
    await info.client?.close();
    assertOwnership();
    await runtime.closeServer(receipt.serverName);
  }
  await runtime.notifyToolChanged(receipt.serverName);
  if (runtime.getServerByName(receipt.serverName)) throw new Error('Removed server remains in the runtime catalog');
  // The serialized queue drains previous embedding writes before pruning this server.
  await runtime.syncToolsAsVectorEmbeddings(receipt.serverName, []);
  const table = await getAppDataSource().query(`SELECT to_regclass('vector_embeddings') AS relation`);
  if (!table[0]?.relation) return; // Smart Routing may never have initialized an index.
  const remaining = await getAppDataSource().query(`SELECT COUNT(*)::int AS count FROM vector_embeddings
    WHERE content_type IN ('tool','server') AND ((metadata::jsonb->>'serverName')=$1
      OR (content_type='server' AND content_id=$1))`, [receipt.serverName]);
  if (remaining[0]?.count !== 0) throw new Error('Removed server remains in the vector index');
}

interface RollbackDependencies {
  repository: Pick<AcquisitionOperationRepository, 'claimPublicationRollback' | 'completePublicationRollback' | 'requireReconciliation'>;
  cleanup: typeof cleanupAcquisitionRuntime;
}

export async function rollbackPublishedAcquisition(owner: string, operationId: string) {
  const store = await getAcquisitionSettingsStore();
  return store.kind === 'json' ? rollbackPublishedJsonAcquisition(owner, operationId, store.settingsPath)
    : rollbackPublishedPostgresAcquisition(owner, operationId, store.db);
}

/** A durable PostgreSQL name reservation spans deletion, runtime cleanup and journal completion. */
export async function rollbackPublishedPostgresAcquisition(owner: string, operationId: string,
  db: Pick<DataSource, 'transaction'>, overrides?: RollbackDependencies) {
  const { repository, cleanup } = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()), cleanup: cleanupAcquisitionRuntime,
  };
  const claim = await repository.claimPublicationRollback(owner, operationId);
  if (!claim) return { status: 'not_claimed' as const };
  try {
    const publication = claim.publication as PostgresPublicationReservation;
    if (publication.storage !== 'postgres' || publication.receipt.operationId !== operationId || publication.receipt.server.owner !== owner) {
      throw new Error('Rollback does not match the publication owner or settings');
    }
    const result = await rollbackPostgresAcquisition(db, publication);
    await cleanup(publication.receipt); // No settings transaction is held while runtime/index work drains.
    await withRemovedPostgresPublication(db, publication, async manager => {
      const journal = new AcquisitionOperationRepository({ query: (sql, args) => manager.query(sql, args) });
      if (!await journal.completePublicationRollback(owner, operationId, claim.rollback_claim_id, result.digest)) {
        throw new Error('Rollback outcome could not be committed');
      }
    });
    return { status: 'rolled_back' as const };
  } catch {
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, claim.claim_id); } catch { /* durable name reservation stays in place */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
}

/** Roll back registration and activation, retaining the operation receipt and staged package for reconciliation. */
export async function rollbackPublishedJsonAcquisition(owner: string, operationId: string, settingsPath: string,
  overrides?: RollbackDependencies) {
  const { repository, cleanup } = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()), cleanup: cleanupAcquisitionRuntime,
  };
  const claim = await repository.claimPublicationRollback(owner, operationId);
  if (!claim) return { status: 'not_claimed' as const };
  try {
    const publication = claim.publication as JsonPublicationReservation;
    const target = path.resolve(settingsPath);
    if (publication.receipt.operationId !== operationId || publication.receipt.server.owner !== owner) {
      throw new Error('Rollback does not match the publication owner');
    }
    // Do not hold the DAO queue while draining runtime/embedding work: an earlier
    // embedding task may itself need that queue. The file lock still excludes writers.
    await withJsonSettingsFileLock(target, async () => {
      const result = await rollbackJsonAcquisition(target, publication);
      await cleanup(publication.receipt);
      if (!await repository.completePublicationRollback(owner, operationId, claim.rollback_claim_id, result.digest)) {
        throw new Error('Rollback outcome could not be committed');
      }
    });
    return { status: 'rolled_back' as const };
  } catch {
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, claim.claim_id); } catch { /* retained rollback claim prevents replay */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
}
