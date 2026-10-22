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
    CREATE INDEX IF NOT EXISTS tool_results_timestamp_idx
      ON tool_results (timestamp DESC, result_id DESC);
    CREATE INDEX IF NOT EXISTS tool_results_server_tool_idx
      ON tool_results (server, tool);
    CREATE INDEX IF NOT EXISTS tool_results_username_idx
      ON tool_results (username, timestamp DESC);
    CREATE INDEX IF NOT EXISTS tool_results_search_idx
      ON tool_results USING gin (
        to_tsvector('simple', coalesce(server, '') || ' ' || coalesce(tool, '') || ' ' ||
          coalesce(objective, '') || ' ' || coalesce(raw_text, ''))
      );
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
};
