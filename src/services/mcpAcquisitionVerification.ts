import { getAppDataSource } from '../db/connection.js';
import { AcquisitionOperationRepository } from './mcpAcquisitionOperation.js';
import { inspectAcquiredMcp } from './mcpAcquisitionInspection.js';

interface VerificationDependencies {
  repository: Pick<AcquisitionOperationRepository, 'beginVerification' | 'recordInspection' | 'requireReconciliation' | 'transition'>;
  inspect: typeof inspectAcquiredMcp;
}

/** One continuation from installed package to evidence. Publication remains separate. */
export async function verifyAcquisitionOperation(owner: string, operationId: string,
  secretReferences: Record<string, string> = {}, overrides?: VerificationDependencies) {
  const { repository, inspect } = overrides ?? {
    repository: new AcquisitionOperationRepository(getAppDataSource()), inspect: inspectAcquiredMcp,
  };
  const claim = await repository.beginVerification(owner, operationId);
  if (!claim) return { status: 'not_claimed' as const };
  try {
    const result = await inspect(operationId, claim.manifest, secretReferences, { username: owner });
    const evidence = { verification: result.verification, tools: result.tools.map(tool => tool.name),
      ...('probe' in result && result.probe ? { resultId: result.probe.resultId } : {}) };
    if (!await repository.recordInspection(owner, operationId, claim.claim_id, evidence)) {
      throw new Error('Inspection evidence could not be committed');
    }
    if (result.verification === 'functional_failed') {
      if (!await repository.transition(owner, operationId, claim.claim_id, 'verifying', 'failed', 'probe_failed')) {
        throw new Error('Probe failure state could not be committed');
      }
      return { status: 'failed' as const };
    }
    return { status: 'inspected' as const, verification: result.verification };
  } catch {
    let checkpointSaved = false;
    try { checkpointSaved = await repository.requireReconciliation(owner, operationId, claim.claim_id); } catch { /* retained claim prevents replay */ }
    return { status: 'reconciliation_required' as const, checkpointSaved };
  }
}
