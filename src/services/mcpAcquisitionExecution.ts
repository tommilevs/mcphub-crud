import { createHash } from 'node:crypto';
import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { acquisitionManifestDigest } from './mcpAcquisitionPlan.js';
import { AcquisitionInputError } from './mcpAcquisitionService.js';
import { putNativeRuntimeSecret } from './nativeRuntimeSecretService.js';
import { stageAcquisitionPackage } from './mcpAcquisitionInstaller.js';
import { verifyAcquisitionOperation } from './mcpAcquisitionVerification.js';
import { publishVerifiedAcquisition } from './mcpAcquisitionPublication.js';
import { activateAcquisition } from './mcpAcquisitionActivationWorker.js';
import { rollbackPublishedAcquisition } from './mcpAcquisitionRollback.js';

export class AcquisitionExecutionUnavailable extends Error {}
type PhaseResult = { status: string; checkpointSaved?: boolean };
interface ExecutionDependencies {
  enabled(): boolean;
  repository: Pick<AcquisitionOperationRepository, 'executionCandidate' | 'claimExecution' | 'requireExecutionReconciliation' | 'get'>;
  putSecret(id: string, value: string): Promise<unknown>;
  stage(owner: string, id: string): Promise<PhaseResult>;
  verify(owner: string, id: string, references: Record<string, string>): Promise<PhaseResult>;
  publish(owner: string, id: string, references: Record<string, string>): Promise<PhaseResult>;
  activate(owner: string, id: string): Promise<PhaseResult>;
  rollback(owner: string, id: string): Promise<PhaseResult>;
}

/** Exactly one claimed execution; plaintext credentials never enter the database, settings or phase metadata. */
export async function runAcquisitionExecution(owner: string, operationId: string, credentials: Record<string, string> = {},
  overrides?: ExecutionDependencies): Promise<PhaseResult> {
  const deps: ExecutionDependencies = overrides ?? { enabled: () => process.platform === 'win32' && process.env.MCPHUB_NATIVE_RUNTIME_ENABLED === 'true',
    repository: new AcquisitionOperationRepository(getAppDataSource()), putSecret: putNativeRuntimeSecret,
    stage: stageAcquisitionPackage, verify: verifyAcquisitionOperation, publish: publishVerifiedAcquisition,
    activate: activateAcquisition, rollback: rollbackPublishedAcquisition };
  if (!deps.enabled()) throw new AcquisitionExecutionUnavailable('Installed Windows native runtime is required');
  const candidate = await deps.repository.executionCandidate(owner, operationId);
  if (!candidate) return { status: 'not_claimed' };
  if (acquisitionManifestDigest(candidate.manifest) !== candidate.manifest_digest) throw new AcquisitionInputError('Acquisition plan integrity check failed');
  const required: string[] = candidate.manifest.requiredInputs;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || required.length > 64 ||
      required.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name) || !Object.prototype.hasOwnProperty.call(credentials, name)) ||
      Object.keys(credentials).some(name => !required.includes(name)) ||
      required.some(name => typeof credentials[name] !== 'string' || !credentials[name] || credentials[name].length > 16384 || credentials[name].includes('\0')) ||
      required.reduce((total, name) => total + (credentials[name]?.length ?? 0), 0) > 65536) {
    throw new AcquisitionInputError('Exact reviewed credentials are required');
  }
  const claim = await deps.repository.claimExecution(owner, operationId, candidate.manifest_digest);
  if (!claim) return { status: 'not_claimed' };
  const reconcile = async (): Promise<PhaseResult> => {
    let checkpointSaved = false;
    try { checkpointSaved = await deps.repository.requireExecutionReconciliation(owner, operationId, claim.execution_claim_id); } catch { /* execution claim prevents replay */ }
    return { status: 'reconciliation_required', checkpointSaved };
  };
  try {
    const references: Record<string, string> = Object.create(null);
    for (const name of required) {
      const id = `acq-${createHash('sha256').update(`${owner}\0${operationId}\0${name}`).digest('hex')}`;
      await deps.putSecret(id, credentials[name]); references[name] = id;
    }
    credentials = Object.create(null); // Do not retain plaintext throughout a long installation.
    const staged = await deps.stage(owner, operationId);
    if (staged.status !== 'package_staged') return ['failed', 'cancelled', 'reconciliation_required'].includes(staged.status) ? staged : reconcile();
    const verified = await deps.verify(owner, operationId, references);
    if (verified.status !== 'inspected') return verified.status === 'failed' ? verified : reconcile();
    const published = await deps.publish(owner, operationId, references);
    if (published.status !== 'published') return reconcile();
    const activated = await deps.activate(owner, operationId);
    if (activated.status === 'ready') return activated;
    if (activated.status === 'not_claimed') {
      const operation = await deps.repository.get(owner, operationId);
      if (operation?.cancel_requested && !operation.requires_reconciliation) return deps.rollback(owner, operationId);
    }
    return reconcile();
  } catch { return reconcile(); }
}
