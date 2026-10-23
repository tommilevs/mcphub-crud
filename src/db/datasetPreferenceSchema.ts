export async function ensureDatasetPreferenceSchema(db:{query(sql:string):Promise<unknown>}):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS dataset_preferences(
    preference_id uuid PRIMARY KEY,owner_scope char(64) NOT NULL,username text NOT NULL,key_id text,
    pair_hash char(64) NOT NULL,comparison_hash char(64) NOT NULL,chosen_id uuid NOT NULL,rejected_id uuid NOT NULL CHECK(chosen_id<>rejected_id),
    evidence_digest char(64) NOT NULL,evidence_snapshot jsonb NOT NULL,
    rationale text NOT NULL,allow_self_reported boolean NOT NULL DEFAULT false,
    status varchar(16) NOT NULL CHECK(status IN ('draft','approved','retired')),privacy_approved boolean NOT NULL DEFAULT false,
    revision integer NOT NULL DEFAULT 1,reviewed_by text NOT NULL,reviewed_at timestamptz NOT NULL DEFAULT NOW()
  );CREATE UNIQUE INDEX IF NOT EXISTS dataset_preferences_active_pair_idx ON dataset_preferences(owner_scope,pair_hash) WHERE status<>'retired';
  CREATE UNIQUE INDEX IF NOT EXISTS dataset_preferences_active_comparison_idx ON dataset_preferences(owner_scope,comparison_hash) WHERE status<>'retired';
  CREATE INDEX IF NOT EXISTS dataset_preferences_owner_idx ON dataset_preferences(username,key_id,reviewed_at DESC);
  CREATE TABLE IF NOT EXISTS dataset_preference_versions(
    preference_id uuid NOT NULL REFERENCES dataset_preferences(preference_id) ON DELETE CASCADE,
    revision integer NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(preference_id,revision)
  )`);
}
