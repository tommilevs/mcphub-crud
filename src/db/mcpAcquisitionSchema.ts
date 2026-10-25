/** Separate from TypeORM synchronization: immutable plans precede lifecycle records. */
export async function ensureMcpAcquisitionSchema(db: { query(sql: string): Promise<unknown> }): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mcp_acquisition_plans (
      plan_id uuid PRIMARY KEY,
      owner varchar(255) NOT NULL CHECK (length(owner)>0),
      manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
      manifest_digest char(64) NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      expires_at timestamptz NOT NULL CHECK (expires_at>created_at)
    );
    CREATE INDEX IF NOT EXISTS mcp_acquisition_plans_owner_expiry_idx
      ON mcp_acquisition_plans(owner,expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_acquisition_plans_identity_idx
      ON mcp_acquisition_plans(plan_id,owner,manifest_digest);
    CREATE OR REPLACE FUNCTION reject_mcp_acquisition_plan_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'MCP acquisition plans are immutable'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS mcp_acquisition_plans_immutable ON mcp_acquisition_plans;
    CREATE TRIGGER mcp_acquisition_plans_immutable BEFORE UPDATE ON mcp_acquisition_plans
      FOR EACH ROW EXECUTE FUNCTION reject_mcp_acquisition_plan_update();
    CREATE TABLE IF NOT EXISTS mcp_acquisition_operations (
      operation_id uuid PRIMARY KEY,
      plan_id uuid NOT NULL UNIQUE,
      owner varchar(255) NOT NULL,
      manifest_digest char(64) NOT NULL,
      idempotency_key uuid NOT NULL,
      state varchar(20) NOT NULL DEFAULT 'authorized' CHECK (state IN
        ('authorized','staging','starting','verifying','ready','cancelled','failed','rolled_back')),
      authorized_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE(owner,idempotency_key),
      FOREIGN KEY(plan_id,owner,manifest_digest)
        REFERENCES mcp_acquisition_plans(plan_id,owner,manifest_digest)
    );
  `);
}
