import { ensureLoopGuardFeedbackSchema } from './loopGuardFeedbackSchema.js';
import { ensureToolResultReviewSchema } from './toolResultReviewSchema.js';
import { ensureExperienceSchema } from './experienceSchema.js';
import { ensureSkillProposalSchema } from './skillProposalSchema.js';
import { ensureDatasetExportSchema } from './datasetExportSchema.js';
type Queryable = {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
};

export const ensureToolResultHistorySchema = async (dataSource: Queryable): Promise<void> => {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS tool_results (
      result_id uuid PRIMARY KEY,
      timestamp timestamptz NOT NULL DEFAULT NOW(),
      server varchar(255) NOT NULL,
      tool varchar(255) NOT NULL,
      duration_ms integer NOT NULL,
      status varchar(20) NOT NULL CHECK (status IN ('success', 'error')),
      group_name varchar(255),
      username varchar(255),
      key_id varchar(255),
      session_id varchar(255),
      conversation_id varchar(255),
      parent_result_id uuid,
      objective text,
      arguments text,
      raw text,
      raw_text text,
      raw_bytes bigint NOT NULL DEFAULT 0,
      raw_sha256 char(64),
      payload_available boolean NOT NULL DEFAULT TRUE,
      payload_omission_reason text
    );
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS tool_result_state (
      result_id uuid PRIMARY KEY REFERENCES tool_results(result_id) ON DELETE CASCADE,
      pinned boolean NOT NULL DEFAULT FALSE,
      use_count integer NOT NULL DEFAULT 0,
      last_referenced_at timestamptz
    );
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS tool_result_chunks (
      result_id uuid NOT NULL REFERENCES tool_results(result_id) ON DELETE CASCADE,
      chunk_index integer NOT NULL,
      chunk_version integer NOT NULL DEFAULT 1,
      content text NOT NULL,
      embedding vector,
      PRIMARY KEY (result_id, chunk_index, chunk_version)
    );
  `);

  // The history tables are created outside TypeORM migrations so the feature
  // can be enabled on an existing MCPHub database. Keep upgrades additive:
  // CREATE TABLE IF NOT EXISTS does not add columns to an older installation.
  await dataSource.query(`
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS group_name varchar(255);
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS attribution jsonb;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS username varchar(255);
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS key_id varchar(255);
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS session_id varchar(255);
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS conversation_id varchar(255);
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS parent_result_id uuid;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS objective text;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS arguments text;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS raw text;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS raw_text text;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS raw_bytes bigint NOT NULL DEFAULT 0;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS raw_sha256 char(64);
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS payload_available boolean NOT NULL DEFAULT TRUE;
    ALTER TABLE tool_results ADD COLUMN IF NOT EXISTS payload_omission_reason text;
    ALTER TABLE tool_result_state ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT FALSE;
    ALTER TABLE tool_result_state ADD COLUMN IF NOT EXISTS loop_guard_advice jsonb;
    ALTER TABLE tool_result_state ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
    ALTER TABLE tool_result_state ADD COLUMN IF NOT EXISTS last_referenced_at timestamptz;
    ALTER TABLE tool_result_chunks ADD COLUMN IF NOT EXISTS chunk_index integer NOT NULL DEFAULT 0;
    ALTER TABLE tool_result_chunks ADD COLUMN IF NOT EXISTS chunk_version integer NOT NULL DEFAULT 1;
    ALTER TABLE tool_result_chunks ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT '';
    ALTER TABLE tool_result_chunks ADD COLUMN IF NOT EXISTS embedding vector;
  `);

  await dataSource.query(`
    CREATE INDEX IF NOT EXISTS tool_results_timestamp_idx
      ON tool_results (timestamp DESC, result_id DESC);
    CREATE INDEX IF NOT EXISTS tool_results_server_tool_idx
      ON tool_results (server, tool);
    CREATE INDEX IF NOT EXISTS tool_results_username_idx
      ON tool_results (username, timestamp DESC);
    CREATE INDEX IF NOT EXISTS tool_results_session_idx
      ON tool_results (session_id, timestamp DESC, result_id DESC);
    CREATE INDEX IF NOT EXISTS tool_results_conversation_idx
      ON tool_results (conversation_id, timestamp DESC, result_id DESC);
    CREATE INDEX IF NOT EXISTS tool_results_parent_idx
      ON tool_results (parent_result_id);
    CREATE INDEX IF NOT EXISTS tool_results_attribution_trace_idx
      ON tool_results ((attribution->>'traceId'), timestamp DESC);
    CREATE INDEX IF NOT EXISTS tool_results_attribution_task_idx
      ON tool_results ((attribution->>'taskId'), timestamp DESC);
    CREATE INDEX IF NOT EXISTS tool_results_search_idx
      ON tool_results USING gin (
        to_tsvector('simple', coalesce(server, '') || ' ' || coalesce(tool, '') || ' ' ||
          coalesce(objective, '') || ' ' || coalesce(raw_text, ''))
      );
    CREATE INDEX IF NOT EXISTS tool_result_chunks_search_idx
      ON tool_result_chunks USING gin (to_tsvector('simple', content));
  `);

  await dataSource.query(`
    CREATE OR REPLACE FUNCTION reject_tool_result_update()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'tool_results rows are immutable';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS tool_results_immutable ON tool_results;
    CREATE TRIGGER tool_results_immutable
      BEFORE UPDATE ON tool_results
      FOR EACH ROW EXECUTE FUNCTION reject_tool_result_update();
  `);
  await ensureLoopGuardFeedbackSchema(dataSource);
  await ensureToolResultReviewSchema(dataSource);
  await ensureExperienceSchema(dataSource);
  await ensureSkillProposalSchema(dataSource);
  await ensureDatasetExportSchema(dataSource);
};
