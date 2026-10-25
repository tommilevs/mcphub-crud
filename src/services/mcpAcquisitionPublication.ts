import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { acquisitionManifestDigest } from './mcpAcquisitionPlan.js';
import { publishJsonAcquisition } from './mcpAcquisitionJsonPublication.js';
import { resolveNativeInstalledPackage } from './nativeRuntimeSecretService.js';
import type { DataSource } from 'typeorm';
import { AcquisitionPublicationCommitUnknown, publishPostgresAcquisition } from './mcpAcquisitionPostgresPublication.js';
import { getDaoFactory, JsonFileDaoFactory } from '../dao/DaoFactory.js';
import { getSettingsPath } from '../config/index.js';

export type AcquisitionSettingsStore = { kind: 'json'; settingsPath: string } |
  { kind: 'postgres'; db: Pick<DataSource, 'transaction'> };

export async function getAcquisitionSettingsStore(): Promise<AcquisitionSettingsStore> {
  const factory = getDaoFactory();
  if (factory instanceof JsonFileDaoFactory) return { kind: 'json', settingsPath: getSettingsPath() };
  const { DatabaseDaoFactory } = await import('../dao/DatabaseDaoFactory.js');
  if (factory instanceof DatabaseDaoFactory) return { kind: 'postgres', db: getAppDataSource() };
  throw new Error('Acquisition does not support the active settings store');
}

interface PublicationDependencies {
  repository: Pick<AcquisitionOperationRepository, 'publicationCandidate' | 'reservePublication' |
    'recordPublicationApplied' | 'requireReconciliation'>;
  resolve: typeof resolveNativeInstalledPackage;
  publishPostgres?: typeof publishPostgresAcquisition;
}

/** Persist verified configuration. Runtime/index activation and ready state follow separately. */
export async function publishVerifiedJsonAcquisition(owner: string, operationId: string, settingsPath: string,
  secretReferences: Record<string, string> = {}, overrides?: PublicationDependencies) {
  return publishVerifiedAcquisitionToStore(owner, operationId, { kind: 'json', settingsPath }, secretReferences, overrides);
}

export async function publishVerifiedAcquisition(owner: string, operationId: string,
  secretReferences: Record<string, string> = {}) {
  return publishVerifiedAcquisitionToStore(owner, operationId, await getAcquisitionSettingsStore(), secretReferences);
}

export async function publishVerifiedAcquisitionToStore(owner: string, operationId: string, store: AcquisitionSettingsStore,
  secretReferences: Record<string, string> = {}, overrides?: PublicationDependencies) {
  const { repository, resolve } = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()), resolve: resolveNativeInstalledPackage,
  };
  const candidate = await repository.publicationCandidate(owner, operationId);
  if (!candidate) return { status: 'not_claimed' as const };
  let reservationMayExist = false;
  try {
    if (acquisitionManifestDigest(candidate.manifest) !== candidate.manifest_digest) {
      throw new Error('Acquisition plan integrity check failed');
    }
    const manifest = candidate.manifest;
    const resolved = await resolve(operationId, manifest.package.name, manifest.package.version);
    const spec = resolved.spec as Record<string, unknown> | undefined;
    const identity = resolved.package as Record<string, unknown> | undefined;
    if (resolved.verification !== 'package_metadata' || identity?.name !== manifest.package.name ||
        identity?.version !== manifest.package.version || typeof spec?.command !== 'string' ||
        typeof spec.cwd !== 'string' || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === 'string')) {
      throw new Error('Installed package does not match the reviewed plan');
    }
    const input = {
      owner, operationId, manifest, launch: { command: spec.command, args: spec.args, cwd: spec.cwd },
      verifiedTools: candidate.inspection.tools, secretReferences,
    };
    if (store.kind === 'postgres') {
      await (overrides?.publishPostgres ?? publishPostgresAcquisition)(store.db, input, candidate.claim_id);
      return { status: 'published' as const };
    }
    const applied = await publishJsonAcquisition(store.settingsPath, input, async reservation => {
      // A lost response may mean the database committed. Preserve the receipt and reconcile.
      reservationMayExist = true;
      const reserved = await repository.reservePublication(owner, operationId, candidate.claim_id, reservation);
      reservationMayExist = reserved;
      return reserved;
    });
    if (!await repository.recordPublicationApplied(owner, operationId, candidate.claim_id, applied.digest)) {
      throw new Error('Publication outcome could not be recorded');
    }
    return { status: 'published' as const };
  } catch (error) {
    if (error instanceof AcquisitionPublicationCommitUnknown) reservationMayExist = true;
    if (!reservationMayExist) return { status: 'not_published' as const };
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, candidate.claim_id); } catch { /* reservation prevents replay */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
}
