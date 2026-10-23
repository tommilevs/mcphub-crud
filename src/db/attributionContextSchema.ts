export const ensureAttributionContextSchema = async (db: {
  query(sql: string): Promise<unknown>;
}): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attribution_contexts (
      context_id uuid PRIMARY KEY,
      task_id uuid NOT NULL,
      trace_id uuid NOT NULL,
      model_segment_id uuid NOT NULL,
      principal text NOT NULL,
      key_digest char(64) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      claimed_model_id varchar(255),
      identity_source varchar(32) NOT NULL CHECK (identity_source IN ('unknown', 'self_reported'))
    );
    ALTER TABLE attribution_contexts ADD COLUMN IF NOT EXISTS branch_id uuid;
    ALTER TABLE attribution_contexts ADD COLUMN IF NOT EXISTS client_claims jsonb NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS attribution_contexts_expiry_idx ON attribution_contexts (expires_at);
    CREATE INDEX IF NOT EXISTS attribution_contexts_principal_trace_idx
      ON attribution_contexts (principal, trace_id);
  `);
};
