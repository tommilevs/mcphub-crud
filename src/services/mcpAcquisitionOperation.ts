import { randomUUID } from 'node:crypto';
import { acquisitionManifestDigest, type AcquisitionPlanDb } from './mcpAcquisitionPlan.js';
import { AcquisitionInputError } from './mcpAcquisitionService.js';
import type { JsonPublicationReservation } from './mcpAcquisitionJsonPublication.js';
import type { PostgresPublicationReservation } from './mcpAcquisitionPublicationSettings.js';
import { acquisitionRowsDatabase } from './mcpAcquisitionDb.js';

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
  private readonly db: AcquisitionPlanDb;
  constructor(db: AcquisitionPlanDb) { this.db = acquisitionRowsDatabase(db); }

  async get(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`SELECT operation_id,plan_id,manifest_digest,state,cancel_requested,requires_reconciliation,failure_code,
      probe_claim_id IS NOT NULL AS probe_started,probe_result_id,verification,inspection,inspected_at,authorized_at,updated_at,
      publication IS NOT NULL AS publication_started,publication_applied_at,
      execution_claim_id IS NOT NULL AS execution_started,execution_started_at,
      (execution_claim_id IS NOT NULL AND NOT requires_reconciliation
        AND state IN ('authorized','staging','starting','verifying')
        AND COALESCE(execution_heartbeat_at,execution_started_at)<NOW()-INTERVAL '120 seconds') AS execution_stale
      FROM mcp_acquisition_operations WHERE operation_id=$1 AND owner=$2`, [operationId, owner]);
    return rows[0] ?? null;
  }

  async executionCandidate(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`SELECT p.manifest,p.manifest_digest FROM mcp_acquisition_operations o
      JOIN mcp_acquisition_plans p ON p.plan_id=o.plan_id WHERE o.operation_id=$1 AND o.owner=$2
      AND o.state='authorized' AND o.execution_claim_id IS NULL AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND p.manifest_digest=o.manifest_digest AND p.expires_at>NOW()`, [operationId, owner]);
    return rows[0] ?? null;
  }

  async claimExecution(owner: string, operationId: string, digest: string) {
    const token = randomUUID();
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o SET execution_claim_id=$4,
      execution_started_at=NOW(),execution_heartbeat_at=NOW(),updated_at=NOW() FROM mcp_acquisition_plans p
      WHERE o.operation_id=$1 AND o.owner=$2 AND o.manifest_digest=$3 AND o.state='authorized'
      AND o.execution_claim_id IS NULL AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND p.plan_id=o.plan_id AND p.manifest_digest=o.manifest_digest AND p.expires_at>NOW()
      RETURNING o.execution_claim_id`, [operationId, owner, digest, token]);
    return rows[0] ?? null;
  }

  async heartbeatExecution(owner: string, operationId: string, token: string) {
    if (!uuid.test(operationId) || !uuid.test(token)) throw new AcquisitionInputError('Invalid execution claim');
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET execution_heartbeat_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND execution_claim_id=$3 AND NOT requires_reconciliation
      AND state IN ('authorized','staging','starting','verifying') RETURNING operation_id`, [operationId, owner, token]);
    return rows.length > 0;
  }

  /** Explicit owner review only: never reclaim a token, replay npm or delete resources. */
  async reviewInterruptedExecution(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET requires_reconciliation=TRUE,
      state=CASE WHEN state='authorized' THEN 'failed' ELSE state END,
      failure_code='execution_heartbeat_lost',updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND execution_claim_id IS NOT NULL AND NOT requires_reconciliation
      AND state IN ('authorized','staging','starting','verifying')
      AND COALESCE(execution_heartbeat_at,execution_started_at)<NOW()-INTERVAL '120 seconds'
      RETURNING operation_id`, [operationId, owner]);
    return rows.length > 0;
  }

  async requireExecutionReconciliation(owner: string, operationId: string, token: string) {
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET requires_reconciliation=TRUE,
      state=CASE WHEN state='authorized' THEN 'failed' ELSE state END,
      failure_code=COALESCE(failure_code,'execution_outcome_unknown'),updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND execution_claim_id=$3
      AND state NOT IN ('ready','rolled_back','cancelled') RETURNING operation_id`, [operationId, owner, token]);
    return rows.length > 0;
  }

  /** Read-only candidate; the reservation below is the atomic publication gate. */
  async publicationCandidate(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`SELECT o.claim_id,o.inspection,p.manifest,p.manifest_digest
      FROM mcp_acquisition_operations o JOIN mcp_acquisition_plans p ON p.plan_id=o.plan_id
      WHERE o.operation_id=$1 AND o.owner=$2 AND o.state='verifying' AND o.claim_id IS NOT NULL
      AND NOT o.cancel_requested AND NOT o.requires_reconciliation AND o.publication IS NULL
      AND o.inspection IS NOT NULL AND o.verification IN ('discovery_only','functional')
      AND o.manifest_digest=p.manifest_digest`, [operationId, owner]);
    return rows[0] ?? null;
  }

  /** One durable reservation only. A retry must reconcile the existing receipt, never apply again. */
  async reservePublication(owner: string, operationId: string, claimId: string, reservation: JsonPublicationReservation | PostgresPublicationReservation) {
    const receipt = reservation?.receipt;
    const validStorage = reservation?.storage === 'json'
      ? !!reservation.settingsPath && /^[a-f0-9]{64}$/.test(reservation.baseDigest)
      : reservation?.storage === 'postgres' && uuid.test(reservation.serverId) && /^[a-f0-9]{64}$/.test(reservation.storedServerDigest);
    if (!uuid.test(operationId) || !uuid.test(claimId) || !validStorage ||
        receipt?.operationId !== operationId || receipt.server?.owner !== owner ||
        receipt.server?.options?.acquisitionOperationId !== operationId ||
        receipt.entry?.name !== receipt.serverName || !Array.isArray(receipt.entry?.tools) || !receipt.entry.tools.length) {
      throw new AcquisitionInputError('Invalid publication reservation');
    }
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o
      SET publication=$4::jsonb,publication_reserved_at=NOW(),updated_at=NOW()
      FROM mcp_acquisition_plans p WHERE o.operation_id=$1 AND o.owner=$2 AND o.claim_id=$3
      AND o.state='verifying' AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND o.publication IS NULL AND o.inspection IS NOT NULL AND p.plan_id=o.plan_id
      AND p.manifest_digest=o.manifest_digest
      AND p.manifest->>'serverName'=$5 AND p.manifest->>'targetGroup'=$6
      AND (o.inspection->'tools') @> $7::jsonb AND $7::jsonb @> (o.inspection->'tools')
      AND ((o.verification='discovery_only' AND NOT (p.manifest ? 'probe') AND o.probe_claim_id IS NULL)
        OR (o.verification='functional' AND o.inspection->>'resultId'=o.probe_result_id::text AND EXISTS(
          SELECT 1 FROM tool_results r WHERE r.result_id=o.probe_result_id AND r.username=$2 AND r.key_id IS NULL
          AND r.payload_available AND r.raw IS NOT NULL AND r.status='success'
          AND r.objective=('acquisition:'||o.operation_id::text)
          AND r.server=p.manifest->>'serverName' AND r.tool=p.manifest->'probe'->>'tool')))
      RETURNING o.operation_id`, [operationId, owner, claimId, JSON.stringify(reservation),
      receipt.serverName, receipt.groupId, JSON.stringify(receipt.entry.tools)]);
    return rows.length > 0;
  }

  async getPublication(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const rows = await this.db.query(`SELECT publication,publication_applied_digest,publication_applied_at
      FROM mcp_acquisition_operations WHERE operation_id=$1 AND owner=$2 AND publication IS NOT NULL`, [operationId, owner]);
    return rows[0] ?? null;
  }

  /** Record the observed write even if cancellation arrived meanwhile; that fact is needed for rollback. */
  async recordPublicationApplied(owner: string, operationId: string, claimId: string, digest: string) {
    if (!uuid.test(operationId) || !uuid.test(claimId) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new AcquisitionInputError('Invalid publication outcome');
    }
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET publication_applied_digest=$4,
      publication_applied_at=NOW(),updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND claim_id=$3 AND state='verifying'
      AND publication IS NOT NULL AND publication_applied_digest IS NULL RETURNING operation_id`, [operationId, owner, claimId, digest]);
    return rows.length > 0;
  }

  async claim(owner: string, operationId: string, executionToken?: string) {
    if (!uuid.test(operationId) || (executionToken !== undefined && !uuid.test(executionToken))) {
      throw new AcquisitionInputError('Invalid execution claim');
    }
    const claimId = randomUUID();
    // Expiry gates acceptance. An already accepted queue entry keeps its exact lease,
    // but neither another worker nor a restarted process may take it over.
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o
      SET state='staging',claim_id=$3,updated_at=NOW()
      FROM mcp_acquisition_plans p WHERE o.operation_id=$1 AND o.owner=$2
      AND o.state='authorized' AND o.claim_id IS NULL AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND p.plan_id=o.plan_id AND p.owner=o.owner AND p.manifest_digest=o.manifest_digest
      AND (($4::uuid IS NULL AND o.execution_claim_id IS NULL AND p.expires_at>NOW())
        OR ($4::uuid IS NOT NULL AND o.execution_claim_id=$4::uuid AND o.execution_started_at<p.expires_at))
      RETURNING o.operation_id,o.state,o.claim_id,p.manifest,p.manifest_digest`, [operationId, owner, claimId, executionToken ?? null]);
    if (!rows.length) return null;
    if (acquisitionManifestDigest(rows[0].manifest) !== rows[0].manifest_digest) {
      await this.requireReconciliation(owner, operationId, claimId);
      throw new Error('Acquisition plan integrity check failed');
    }
    return rows[0];
  }

  async transition(owner: string, operationId: string, claimId: string, from: string, to: string, failureCode: string | null = null) {
    if (to === 'ready') throw new AcquisitionInputError('Readiness requires verified runtime activation');
    if (!uuid.test(operationId) || !uuid.test(claimId) || !canTransitionAcquisition(from, to)) {
      throw new AcquisitionInputError('Invalid acquisition state transition');
    }
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET state=$5,failure_code=$6,
      requires_reconciliation=CASE WHEN $5='rolled_back' THEN FALSE ELSE requires_reconciliation END,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND claim_id=$3 AND state=$4
      AND (NOT cancel_requested OR $5 IN ('failed','rolled_back'))
      AND (NOT requires_reconciliation OR $5 IN ('failed','rolled_back'))
      AND ($5 <> 'rolled_back' OR publication IS NULL)
      RETURNING operation_id,state,cancel_requested`, [operationId, owner, claimId, from, to, failureCode]);
    return rows[0] ?? null;
  }

  async claimActivation(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    const activationClaim = randomUUID();
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET activation_claim_id=$3,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND state='verifying' AND claim_id IS NOT NULL
      AND publication IS NOT NULL AND publication_applied_digest IS NOT NULL AND activation_claim_id IS NULL
      AND NOT cancel_requested AND NOT requires_reconciliation AND rollback_claim_id IS NULL
      RETURNING claim_id,activation_claim_id,publication,publication_applied_digest`, [operationId, owner, activationClaim]);
    return rows[0] ?? null;
  }

  async claimPublicationRollback(owner: string, operationId: string) {
    if (!uuid.test(operationId)) throw new AcquisitionInputError('Invalid operation identifier');
    // The settings tables may have been initialized after the history schema.
    await this.db.query('SELECT ensure_mcp_acquisition_rollback_guard()');
    const token = randomUUID();
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET rollback_claim_id=$3,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND state IN ('verifying','failed')
      AND claim_id IS NOT NULL AND publication IS NOT NULL AND rollback_claim_id IS NULL
      AND (cancel_requested OR requires_reconciliation OR state='failed')
      AND (activation_claim_id IS NULL OR requires_reconciliation)
      AND (publication_applied_digest IS NOT NULL OR requires_reconciliation)
      RETURNING claim_id,rollback_claim_id,publication`, [operationId, owner, token]);
    return rows[0] ?? null;
  }

  async completePublicationRollback(owner: string, operationId: string, token: string, digest: string) {
    if (!uuid.test(operationId) || !uuid.test(token) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new AcquisitionInputError('Invalid publication rollback outcome');
    }
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET state='rolled_back',rollback_digest=$4,
      rolled_back_at=NOW(),requires_reconciliation=FALSE,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND rollback_claim_id=$3 AND state IN ('verifying','failed')
      AND publication IS NOT NULL AND rollback_digest IS NULL RETURNING operation_id`, [operationId, owner, token, digest]);
    return rows.length > 0;
  }

  /** Only the runtime/index coordinator supplies this evidence, after observing actual activation. */
  async completeActivation(owner: string, operationId: string, activationClaim: string, evidence: {
    serverName: string; tools: string[]; indexStatus: 'verified' | 'disabled';
  }) {
    if (!uuid.test(operationId) || !uuid.test(activationClaim) || !evidence?.serverName ||
        !Array.isArray(evidence.tools) || !evidence.tools.length || evidence.tools.some(tool => typeof tool !== 'string' || !tool) ||
        !['verified', 'disabled'].includes(evidence.indexStatus)) throw new AcquisitionInputError('Invalid activation evidence');
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o
      SET state='ready',activation=$4::jsonb,activated_at=NOW(),updated_at=NOW()
      FROM mcp_acquisition_plans p WHERE o.operation_id=$1 AND o.owner=$2 AND o.activation_claim_id=$3
      AND o.state='verifying' AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND o.activation IS NULL AND o.publication_applied_digest IS NOT NULL AND p.plan_id=o.plan_id
      AND p.manifest->>'serverName'=$5 AND o.publication->'receipt'->>'serverName'=$5
      AND $6::jsonb @> (o.inspection->'tools')
      AND ((o.verification='discovery_only' AND NOT (p.manifest ? 'probe') AND o.probe_claim_id IS NULL)
        OR (o.verification='functional' AND o.inspection->>'resultId'=o.probe_result_id::text AND EXISTS(
          SELECT 1 FROM tool_results r WHERE r.result_id=o.probe_result_id AND r.username=$2 AND r.key_id IS NULL
          AND r.payload_available AND r.raw IS NOT NULL AND r.status='success'
          AND r.objective=('acquisition:'||o.operation_id::text)
          AND r.server=p.manifest->>'serverName' AND r.tool=p.manifest->'probe'->>'tool')))
      RETURNING o.operation_id`, [operationId, owner, activationClaim, JSON.stringify(evidence), evidence.serverName, JSON.stringify(evidence.tools)]);
    return rows.length > 0;
  }

  async requireReconciliation(owner: string, operationId: string, claimId: string) {
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations
      SET requires_reconciliation=TRUE,failure_code='native_state_unknown',updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND claim_id=$3 AND state IN ('staging','starting','verifying','failed')
      RETURNING operation_id`, [operationId, owner, claimId]);
    return rows.length > 0;
  }

  async claimProbe(owner: string, operationId: string, digest: string) {
    const claimId = randomUUID();
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations SET probe_claim_id=$3,updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND manifest_digest=$4 AND state='verifying'
      AND NOT cancel_requested AND NOT requires_reconciliation AND probe_claim_id IS NULL
      RETURNING probe_claim_id`, [operationId, owner, claimId, digest]);
    return rows[0]?.probe_claim_id ?? null;
  }

  async beginVerification(owner: string, operationId: string) {
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o SET state='verifying',updated_at=NOW()
      FROM mcp_acquisition_plans p WHERE o.operation_id=$1 AND o.owner=$2 AND o.state='starting'
      AND o.claim_id IS NOT NULL AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND p.plan_id=o.plan_id RETURNING o.claim_id,p.manifest`, [operationId, owner]);
    return rows[0] ?? null;
  }

  async recordInspection(owner: string, operationId: string, claimId: string, evidence: {
    verification: 'discovery_only' | 'functional' | 'functional_failed'; tools: string[]; resultId?: string;
  }) {
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o
      SET inspection=$4::jsonb,verification=$5,inspected_at=NOW(),updated_at=NOW()
      FROM mcp_acquisition_plans p WHERE o.operation_id=$1 AND o.owner=$2 AND o.claim_id=$3
      AND o.state='verifying' AND NOT o.cancel_requested AND NOT o.requires_reconciliation
      AND o.inspection IS NULL AND p.plan_id=o.plan_id
      AND (($5='discovery_only' AND NOT (p.manifest ? 'probe') AND o.probe_claim_id IS NULL)
        OR ($5 IN ('functional','functional_failed') AND o.probe_result_id=$6 AND EXISTS(
          SELECT 1 FROM tool_results r WHERE r.result_id=$6 AND r.username=$2 AND r.key_id IS NULL
          AND r.payload_available AND r.raw IS NOT NULL AND r.objective=('acquisition:'||o.operation_id::text)
          AND r.server=p.manifest->>'serverName' AND r.tool=p.manifest->'probe'->>'tool'
          AND r.status=CASE WHEN $5='functional' THEN 'success' ELSE 'error' END)))
      RETURNING operation_id`, [operationId, owner, claimId, JSON.stringify(evidence), evidence.verification, evidence.resultId ?? null]);
    return rows.length > 0;
  }

  async completeProbe(owner: string, operationId: string, claimId: string, resultId: string) {
    const rows = await this.db.query(`UPDATE mcp_acquisition_operations o SET probe_result_id=$4,updated_at=NOW()
      FROM tool_results r,mcp_acquisition_plans p
      WHERE o.operation_id=$1 AND o.owner=$2 AND o.probe_claim_id=$3 AND (o.probe_result_id IS NULL OR o.probe_result_id=$4)
      AND p.plan_id=o.plan_id AND r.result_id=$4 AND r.username=$2 AND r.key_id IS NULL
      AND r.payload_available AND r.raw IS NOT NULL AND r.objective=('acquisition:'||o.operation_id::text)
      AND r.server=p.manifest->>'serverName' AND r.tool=p.manifest->'probe'->>'tool'
      RETURNING o.operation_id`, [operationId, owner, claimId, resultId]);
    return rows.length > 0;
  }

  async uncertainProbe(owner: string, operationId: string, claimId: string) {
    await this.db.query(`UPDATE mcp_acquisition_operations SET requires_reconciliation=TRUE,
      failure_code='probe_outcome_unknown',updated_at=NOW()
      WHERE operation_id=$1 AND owner=$2 AND probe_claim_id=$3 AND probe_result_id IS NULL`, [operationId, owner, claimId]);
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
