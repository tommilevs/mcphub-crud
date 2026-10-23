export async function ensureDatasetExportSchema(db:{query(sql:string):Promise<unknown>}):Promise<void>{
  await db.query(`CREATE TABLE IF NOT EXISTS dataset_split_registry(
    owner_scope char(64) NOT NULL,token_hash char(64) NOT NULL,
    split varchar(16) NOT NULL CHECK(split IN ('train','validation','test')),
    created_at timestamptz NOT NULL DEFAULT NOW(),PRIMARY KEY(owner_scope,token_hash)
  );CREATE TABLE IF NOT EXISTS dataset_exports(
    export_id uuid PRIMARY KEY,username text NOT NULL,key_id text,
    split varchar(16) NOT NULL CHECK(split IN ('train','validation','test')),
    selected_ids uuid[] NOT NULL,exported_ids uuid[] NOT NULL,
    manifest jsonb NOT NULL,file_sha256 char(64) NOT NULL,byte_length integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW()
  );CREATE INDEX IF NOT EXISTS dataset_exports_owner_idx ON dataset_exports(username,key_id,created_at DESC)`);
}
