import type { AttributionContextRecord, AttributionContextStore, AttributionContextReference } from '../../services/attributionContextService.js';
import { randomUUID } from 'node:crypto';
import type { DiscoveryEvidence } from '../../services/discoveryEvidence.js';

export class AttributionContextRepository implements AttributionContextStore {
  constructor(private readonly db: { query(sql: string, parameters?: unknown[]): Promise<any> }) {}

  async recordDiscovery(context: AttributionContextReference, callId: string, evidence: DiscoveryEvidence): Promise<void> {
    await this.db.query(`INSERT INTO attribution_discovery_events
      (call_id, context_id, trace_id, branch_id, evidence) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (call_id) DO NOTHING`, [callId, context.contextId, context.traceId, context.branchId, JSON.stringify(evidence)]);
  }

  async pruneExpired(cutoff: Date, limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isFinite(cutoff.getTime())) {
      throw new Error('Invalid cleanup batch');
    }
    const rows = await this.db.query(`WITH expired AS (
      SELECT context_id FROM attribution_contexts WHERE expires_at < $1
      ORDER BY expires_at, context_id LIMIT $2 FOR UPDATE SKIP LOCKED
    ) DELETE FROM attribution_contexts context USING expired
      WHERE context.context_id = expired.context_id RETURNING context.context_id`, [cutoff, limit]);
    return rows.length;
  }

  async insert(record: AttributionContextRecord, event = 'context_started', parentContextId?: string): Promise<void> {
    await this.db.query(`WITH inserted AS (INSERT INTO attribution_contexts
      (context_id, task_id, trace_id, model_segment_id, principal, key_digest,
       created_at, expires_at, claimed_model_id, identity_source, branch_id, client_claims)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *)
      INSERT INTO attribution_identity_events
        (event_id, context_id, parent_context_id, task_id, trace_id, branch_id,
         model_segment_id, event_type, occurred_at, claimed_model_id, identity_source)
      SELECT $13, context_id, $14, task_id, trace_id, branch_id, model_segment_id,
        $15, created_at, claimed_model_id, identity_source FROM inserted`, [
      record.contextId, record.taskId, record.traceId, record.modelSegmentId,
      record.principal, record.keyDigest, record.createdAt, record.expiresAt,
      record.identity.modelId, record.identity.source,
      record.branchId, JSON.stringify(record.clientClaims),
      randomUUID(), parentContextId ?? null, event,
    ]);
  }

  async rotate(oldDigest: string, next: AttributionContextRecord): Promise<boolean> {
    const rows = await this.db.query(`WITH revoked AS (
      UPDATE attribution_contexts SET revoked_at = $1
      WHERE key_digest = $2 AND principal = $3 AND revoked_at IS NULL AND expires_at > $1
      RETURNING task_id, trace_id, context_id
    ), inserted AS (INSERT INTO attribution_contexts
      (context_id, task_id, trace_id, model_segment_id, principal, key_digest,
       created_at, expires_at, claimed_model_id, identity_source, branch_id, client_claims)
      SELECT $4, task_id, trace_id, $5, $3, $6, $1, $7, $8, $9, $10, $11 FROM revoked
      RETURNING *)
      INSERT INTO attribution_identity_events
        (event_id, context_id, parent_context_id, task_id, trace_id, branch_id,
         model_segment_id, event_type, occurred_at, claimed_model_id, identity_source)
      SELECT $12, inserted.context_id, revoked.context_id, inserted.task_id,
        inserted.trace_id, inserted.branch_id, inserted.model_segment_id, 'model_rotated',
        inserted.created_at, inserted.claimed_model_id, inserted.identity_source
      FROM inserted CROSS JOIN revoked RETURNING context_id`, [next.createdAt, oldDigest, next.principal,
      next.contextId, next.modelSegmentId, next.keyDigest, next.expiresAt,
      next.identity.modelId, next.identity.source, next.branchId, JSON.stringify(next.clientClaims), randomUUID()]);
    return rows.length === 1;
  }

  async findByDigest(digest: string): Promise<AttributionContextRecord | null> {
    const rows = await this.db.query('SELECT * FROM attribution_contexts WHERE key_digest = $1', [digest]);
    const row = rows[0];
    if (!row) return null;
    return {
      contextId: row.context_id, taskId: row.task_id, traceId: row.trace_id,
      modelSegmentId: row.model_segment_id, principal: row.principal, keyDigest: row.key_digest,
      branchId: row.branch_id ?? null, clientClaims: row.client_claims ?? {},
      createdAt: new Date(row.created_at), expiresAt: new Date(row.expires_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
      identity: { modelId: row.claimed_model_id, source: row.identity_source, verified: false },
    };
  }
}
