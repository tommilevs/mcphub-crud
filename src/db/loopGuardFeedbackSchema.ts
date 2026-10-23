export async function ensureLoopGuardFeedbackSchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
  await db.query(`ALTER TABLE tool_result_state ADD COLUMN IF NOT EXISTS loop_guard_feedback jsonb;
    CREATE TABLE IF NOT EXISTS tool_result_loop_feedback (
      feedback_id uuid PRIMARY KEY,
      result_id uuid NOT NULL REFERENCES tool_results(result_id) ON DELETE CASCADE,
      verdict varchar(20) NOT NULL CHECK (verdict IN ('helpful', 'false_positive', 'ignored')),
      reviewed_by text NOT NULL,
      reviewed_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tool_result_loop_feedback_result_idx
      ON tool_result_loop_feedback (result_id, reviewed_at DESC);
    CREATE TABLE IF NOT EXISTS tool_result_loop_reactions (
      call_id uuid PRIMARY KEY,
      result_id uuid NOT NULL REFERENCES tool_results(result_id) ON DELETE CASCADE,
      context_id uuid NOT NULL,
      trace_id uuid NOT NULL,
      branch_id uuid NOT NULL,
      model_segment_id uuid NOT NULL,
      action varchar(24) NOT NULL CHECK (action IN ('accepted','declined','changed_strategy','intentional_retry')),
      source text NOT NULL DEFAULT 'self_reported' CHECK (source = 'self_reported'),
      recorded_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tool_result_loop_reactions_result_idx
      ON tool_result_loop_reactions (result_id, recorded_at DESC);
  `);
}
