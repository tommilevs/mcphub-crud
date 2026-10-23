import type { AttributionContextRecord, AttributionContextStore } from '../../services/attributionContextService.js';

export class AttributionContextRepository implements AttributionContextStore {
  constructor(private readonly db: { query(sql: string, parameters?: unknown[]): Promise<any> }) {}

  async insert(record: AttributionContextRecord): Promise<void> {
    await this.db.query(`INSERT INTO attribution_contexts
      (context_id, task_id, trace_id, model_segment_id, principal, key_digest,
       created_at, expires_at, claimed_model_id, identity_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
      record.contextId, record.taskId, record.traceId, record.modelSegmentId,
      record.principal, record.keyDigest, record.createdAt, record.expiresAt,
      record.identity.modelId, record.identity.source,
    ]);
  }

  async findByDigest(digest: string): Promise<AttributionContextRecord | null> {
    const rows = await this.db.query('SELECT * FROM attribution_contexts WHERE key_digest = $1', [digest]);
    const row = rows[0];
    if (!row) return null;
    return {
      contextId: row.context_id, taskId: row.task_id, traceId: row.trace_id,
      modelSegmentId: row.model_segment_id, principal: row.principal, keyDigest: row.key_digest,
      createdAt: new Date(row.created_at), expiresAt: new Date(row.expires_at),
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : undefined,
      identity: { modelId: row.claimed_model_id, source: row.identity_source, verified: false },
    };
  }
}
