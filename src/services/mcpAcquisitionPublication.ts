import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { acquisitionManifestDigest } from './mcpAcquisitionPlan.js';
import { publishJsonAcquisition } from './mcpAcquisitionJsonPublication.js';
import { resolveNativeInstalledPackage } from './nativeRuntimeSecretService.js';

interface PublicationDependencies {
  repository: Pick<AcquisitionOperationRepository, 'publicationCandidate' | 'reservePublication' |
    'recordPublicationApplied' | 'requireReconciliation'>;
  resolve: typeof resolveNativeInstalledPackage;
}

/** Persist verified configuration. Runtime/index activation and ready state follow separately. */
export async function publishVerifiedJsonAcquisition(owner: string, operationId: string, settingsPath: string,
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
    const applied = await publishJsonAcquisition(settingsPath, {
      owner, operationId, manifest, launch: { command: spec.command, args: spec.args, cwd: spec.cwd },
      verifiedTools: candidate.inspection.tools, secretReferences,
    }, async reservation => {
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
  } catch {
    if (!reservationMayExist) return { status: 'not_published' as const };
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, candidate.claim_id); } catch { /* reservation prevents replay */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
}
