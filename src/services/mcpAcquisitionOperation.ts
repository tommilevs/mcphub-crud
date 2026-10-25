import { randomUUID } from 'node:crypto';
import { AcquisitionPlanRepository, type AcquisitionPlanDb } from './mcpAcquisitionPlan.js';
import { AcquisitionInputError } from './mcpAcquisitionService.js';

const transitions: Record<string, readonly string[]> = {
  staging: ['starting', 'failed', 'rolled_back'],
  starting: ['verifying', 'failed', 'rolled_back'],
  verifying: ['ready', 'failed', 'rolled_back'],
  failed: ['rolled_back'],
};
export function canTransitionAcquisition(from: string, to: string): boolean {
  return transitions[from]?.includes(to) ?? false;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** State persistence only: native actions must be reconciled before recording their outcomes. */
export class AcquisitionOperationRepository {
  constructor(private readonly db: AcquisitionPlanDb) {}

  async get(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`SELECT operation_id,plan_id,manifest_digest,state,cancel_requested,requires_reconciliation,failure_code,authorized_at,updated_at
      FROM mcp_acquisition_operations WHERE operation_id=$1 AND owner=$2`, [operationId, owner]);
    return rows[0] ?? null;
  }

  async claim(owner: string, operationId: string) {
    const operation = await this.get(owner, operationId);
    if (!operation || operation.state !== 'authorized') return null;
    const plan = await new AcquisitionPlanRepository(this.db).get(owner, operation.plan_id);
    if (!plan || plan.manifest_digest !== operation.manifest_digest) return null;
    const claimId = randomUUID();
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o
      SET state='staging',claim_id=$3,updated_at=NOW()
      FROM mcp_acquisition_plans p WHERE o.operation_id=$1 AND o.owner=$2
      AND o.state='authorized' AND o.claim_id IS NULL AND NOT o.cancel_requested
      AND p.plan_id=o.plan_id AND p.manifest_digest=o.manifest_digest AND p.expires_at>NOW()
      RETURNING o.operation_id,o.state,o.claim_id`, [operationId, owner, claimId]);
    return rows.length ? { ...rows[0], manifest: plan.manifest } : null;
  }

  async transition(owner: string, operationId: string, claimId: string, from: string, to: string, failureCode: string | null = null) {
    if (!uuid.test(operationId) || !uuid.test(claimId) || !canTransitionAcquisition(from, to)) {
      throw new AcquisitionInputError('Invalid acquisition state transition');
    }
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET state=$5,failure_code=$6,
      requires_reconciliation=CASE WHEN $5='rolled_back' THEN FALSE ELSE requires_reconciliation END,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND claim_id=$3 AND state=$4
      AND (NOT cancel_requested OR $5 IN ('failed','rolled_back'))
      AND (NOT requires_reconciliation OR $5 IN ('failed','rolled_back'))
      RETURNING operation_id,state,cancel_requested`, [operationId, owner, claimId, from, to, failureCode]);
    return rows[0] ?? null;
  }

  async requireReconciliation(owner: string, operationId: string, claimId: string) {
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations
      SET requires_reconciliation=TRUE,failure_code='native_state_unknown',updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND claim_id=$3 AND state IN ('staging','starting','verifying')
      RETURNING operation_id`, [operationId, owner, claimId]);
    return rows.length > 0;
  }

  async cancel(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations
      SET cancel_requested=TRUE,state=CASE WHEN state='authorized' THEN 'cancelled' ELSE state END,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND state IN ('authorized','staging','starting','verifying')
      RETURNING operation_id,state,cancel_requested`, [operationId, owner]);
    return rows[0] ?? this.get(owner, operationId);
  }
}
