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
    CREATE TABLE IF NOT EXISTS attribution_identity_events (
      event_id uuid PRIMARY KEY,
      context_id uuid NOT NULL REFERENCES attribution_contexts(context_id) ON DELETE CASCADE,
      parent_context_id uuid,
      task_id uuid NOT NULL,
      trace_id uuid NOT NULL,
      branch_id uuid,
      model_segment_id uuid NOT NULL,
      event_type varchar(32) NOT NULL CHECK (event_type IN ('context_started', 'branch_forked', 'model_rotated')),
      occurred_at timestamptz NOT NULL,
      claimed_model_id varchar(255),
      identity_source varchar(32) NOT NULL CHECK (identity_source IN ('unknown', 'self_reported'))
    );
    CREATE INDEX IF NOT EXISTS attribution_identity_events_trace_idx
      ON attribution_identity_events (trace_id, occurred_at, event_id);
    CREATE TABLE IF NOT EXISTS attribution_task_reviews (
      task_id uuid NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      outcome varchar(20) NOT NULL CHECK (outcome IN ('unknown', 'success', 'failure', 'partial', 'abandoned')),
      training_consent boolean NOT NULL DEFAULT FALSE,
      reviewed_by text NOT NULL,
      reviewed_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (task_id, revision)
    );
    CREATE INDEX IF NOT EXISTS attribution_task_reviews_text_task_idx
      ON attribution_task_reviews ((task_id::text), revision DESC);
    CREATE TABLE IF NOT EXISTS attribution_discovery_events (
      call_id uuid PRIMARY KEY,
      context_id uuid NOT NULL REFERENCES attribution_contexts(context_id) ON DELETE CASCADE,
      trace_id uuid NOT NULL,
      branch_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT NOW(),
      evidence jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attribution_discovery_events_trace_idx
      ON attribution_discovery_events (trace_id, branch_id, occurred_at DESC);
  `);
};
