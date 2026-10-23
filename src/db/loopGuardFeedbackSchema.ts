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
  `);
}
