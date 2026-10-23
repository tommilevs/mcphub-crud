export async function ensureExperienceSchema(db:{query(sql:string):Promise<unknown>}):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS experience_entries(
    experience_id uuid PRIMARY KEY, username text NOT NULL,key_id text,
    title varchar(160) NOT NULL,summary text NOT NULL,task_type varchar(255) NOT NULL,
    scope jsonb NOT NULL,tool_versions jsonb NOT NULL,evidence_ids uuid[] NOT NULL,evidence_snapshot jsonb NOT NULL,
    status varchar(16) NOT NULL CHECK(status IN ('draft','approved','retired')),
    revision integer NOT NULL DEFAULT 1,reviewed_by text NOT NULL,reviewed_at timestamptz NOT NULL DEFAULT NOW(),
    search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple'::regconfig,title||' '||summary||' '||task_type)) STORED
  );CREATE INDEX IF NOT EXISTS experience_entries_search_idx ON experience_entries USING gin(search_vector);
  CREATE INDEX IF NOT EXISTS experience_entries_owner_idx ON experience_entries(username,key_id,status,reviewed_at DESC);
  CREATE TABLE IF NOT EXISTS experience_entry_audit(
    experience_id uuid NOT NULL REFERENCES experience_entries(experience_id) ON DELETE CASCADE,
    revision integer NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(experience_id,revision)
  )`);
}
