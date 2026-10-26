import { acquisitionSecretId } from './mcpAcquisitionSecretIdentity.js';
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
import { startExecutionHeartbeat } from './mcpAcquisitionExecutionHeartbeat.js';

export class AcquisitionExecutionUnavailable extends Error {}
type PhaseResult = { status: string; checkpointSaved?: boolean };
interface ExecutionDependencies {
  enabled(): boolean;
  repository: Pick<AcquisitionOperationRepository, 'executionCandidate' | 'claimExecution' | 'heartbeatExecution' | 'requireExecutionReconciliation' | 'get'>;
  putSecret(id: string, value: string): Promise<unknown>;
  stage(owner: string, id: string, executionToken: string): Promise<PhaseResult>;
  verify(owner: string, id: string, references: Record<string, string>): Promise<PhaseResult>;
  publish(owner: string, id: string, references: Record<string, string>): Promise<PhaseResult>;
  activate(owner: string, id: string): Promise<PhaseResult>;
  rollback(owner: string, id: string): Promise<PhaseResult>;
}

/** Exactly one claimed execution; plaintext credentials never enter the database, settings or phase metadata. */
export async function runAcquisitionExecution(owner: string, operationId: string, credentials: Record<string, string> = {},
  overrides?: ExecutionDependencies): Promise<PhaseResult> {
  const execute = await prepareAcquisitionExecution(owner, operationId, credentials, overrides);
  return execute ? execute() : { status: 'not_claimed' };
}

/** Validate and acquire durable ownership before acknowledging an asynchronous HTTP request. */
export async function prepareAcquisitionExecution(owner: string, operationId: string, credentials: Record<string, string> = {},
  overrides?: ExecutionDependencies): Promise<(() => Promise<PhaseResult>) | null> {
  if (!overrides && (process.platform !== 'win32' || process.env.MCPHUB_NATIVE_RUNTIME_ENABLED !== 'true')) {
    throw new AcquisitionExecutionUnavailable('Installed Windows native runtime is required');
  }
  const deps: ExecutionDependencies = overrides ?? { enabled: () => process.platform === 'win32' && process.env.MCPHUB_NATIVE_RUNTIME_ENABLED === 'true',
    repository: new AcquisitionOperationRepository(getAppDataSource()), putSecret: putNativeRuntimeSecret,
    stage: (owner, id, token) => stageAcquisitionPackage(owner, id, undefined, token), verify: verifyAcquisitionOperation, publish: publishVerifiedAcquisition,
    activate: activateAcquisition, rollback: rollbackPublishedAcquisition };
  if (!deps.enabled()) throw new AcquisitionExecutionUnavailable('Installed Windows native runtime is required');
  const candidate = await deps.repository.executionCandidate(owner, operationId);
  if (!candidate) return null;
  if (acquisitionManifestDigest(candidate.manifest) !== candidate.manifest_digest) throw new AcquisitionInputError('Acquisition plan integrity check failed');
  const required: string[] = candidate.manifest.requiredInputs;
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || required.length > 64 ||
      required.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name) || !Object.prototype.hasOwnProperty.call(credentials, name)) ||
      Object.keys(credentials).some(name => !required.includes(name)) ||
      required.some(name => typeof credentials[name] !== 'string' || !credentials[name] || credentials[name].length > 16384 || credentials[name].includes('\0')) ||
      required.reduce((total, name) => total + (credentials[name]?.length ?? 0), 0) > 65536) {
    throw new AcquisitionInputError('Exact reviewed credentials are required');
  }
  const values: Record<string, string> = Object.assign(Object.create(null), credentials);
  credentials = Object.create(null);
  const claim = await deps.repository.claimExecution(owner, operationId, candidate.manifest_digest);
  if (!claim) return null;
  const heartbeat = startExecutionHeartbeat(() => deps.repository.heartbeatExecution(owner, operationId, claim.execution_claim_id));
  let started = false;
  return async () => {
  if (started) return { status: 'not_claimed' };
  started = true;
  const reconcile = async (): Promise<PhaseResult> => {
    let checkpointSaved = false;
    try { checkpointSaved = await deps.repository.requireExecutionReconciliation(owner, operationId, claim.execution_claim_id); } catch { /* execution claim prevents replay */ }
    return { status: 'reconciliation_required', checkpointSaved };
  };
  try {
    const operation = await deps.repository.get(owner, operationId);
    if (operation?.cancel_requested || operation?.state === 'cancelled') return { status: 'cancelled' };
    if (!operation || operation.requires_reconciliation) return reconcile();
    const references: Record<string, string> = Object.create(null);
    for (const name of required) {
      if (!await heartbeat.confirm()) return reconcile();
      const id = acquisitionSecretId(owner, operationId, name);
      await deps.putSecret(id, values[name]); references[name] = id; delete values[name];
    }
    if (!await heartbeat.confirm()) return reconcile();
    const staged = await deps.stage(owner, operationId, claim.execution_claim_id);
    if (staged.status !== 'package_staged') return ['failed', 'cancelled', 'reconciliation_required'].includes(staged.status) ? staged : reconcile();
    if (!await heartbeat.confirm()) return reconcile();
    const verified = await deps.verify(owner, operationId, references);
    if (verified.status !== 'inspected') return verified.status === 'failed' ? verified : reconcile();
    if (!await heartbeat.confirm()) return reconcile();
    const published = await deps.publish(owner, operationId, references);
    if (published.status !== 'published') return reconcile();
    if (!await heartbeat.confirm()) return reconcile();
    const activated = await deps.activate(owner, operationId);
    if (activated.status === 'ready') return activated;
    if (activated.status === 'not_claimed') {
      const operation = await deps.repository.get(owner, operationId);
      if (operation?.cancel_requested && !operation.requires_reconciliation) return deps.rollback(owner, operationId);
    }
    return reconcile();
  } catch { return reconcile(); }
  finally { heartbeat.stop(); for (const name of Object.keys(values)) delete values[name]; }
  };
}
