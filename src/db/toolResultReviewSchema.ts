export async function ensureToolResultReviewSchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS tool_result_reviews (
    result_id uuid NOT NULL REFERENCES tool_results(result_id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    raw_sha256 varchar(64) NOT NULL,
    quality varchar(16) NOT NULL CHECK (quality IN ('unknown','correct','incorrect','uncertain')),
    privacy varchar(16) NOT NULL CHECK (privacy IN ('unreviewed','approved','rejected')),
    reviewed_by text NOT NULL,
    reviewed_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (result_id,revision)
  );
  CREATE TABLE IF NOT EXISTS tool_result_training_contexts (
    result_id uuid NOT NULL REFERENCES tool_results(result_id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision > 0),
    discovery_call_id uuid NOT NULL,
    objective text NOT NULL,
    tool_catalogue jsonb NOT NULL,
    privacy_approved boolean NOT NULL DEFAULT FALSE,
    reviewed_by text NOT NULL,
    reviewed_at timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (result_id,revision)
  )`);
}
