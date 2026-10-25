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
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS claim_id uuid;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT FALSE;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS requires_reconciliation boolean NOT NULL DEFAULT FALSE;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS failure_code varchar(64);
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS probe_claim_id uuid;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS probe_result_id uuid;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS inspection jsonb;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS inspected_at timestamptz;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS verification varchar(32)
      CHECK (verification IN ('discovery_only','functional','functional_failed'));
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS publication jsonb;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS publication_reserved_at timestamptz;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS publication_applied_digest char(64);
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS publication_applied_at timestamptz;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS activation_claim_id uuid;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS activation jsonb;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS activated_at timestamptz;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS rollback_claim_id uuid;
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS rollback_digest char(64);
    ALTER TABLE mcp_acquisition_operations ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz;
    CREATE OR REPLACE FUNCTION protect_mcp_acquisition_publication() RETURNS trigger AS $$
      BEGIN
        IF OLD.publication IS NOT NULL AND
          (NEW.publication IS DISTINCT FROM OLD.publication OR
           NEW.publication_reserved_at IS DISTINCT FROM OLD.publication_reserved_at) THEN
          RAISE EXCEPTION 'MCP acquisition publication reservation is immutable';
        END IF;
        IF OLD.publication_applied_digest IS NOT NULL AND
          (NEW.publication_applied_digest IS DISTINCT FROM OLD.publication_applied_digest OR
           NEW.publication_applied_at IS DISTINCT FROM OLD.publication_applied_at) THEN
          RAISE EXCEPTION 'MCP acquisition publication outcome is immutable';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS mcp_acquisition_publication_immutable ON mcp_acquisition_operations;
    CREATE TRIGGER mcp_acquisition_publication_immutable BEFORE UPDATE ON mcp_acquisition_operations
      FOR EACH ROW EXECUTE FUNCTION protect_mcp_acquisition_publication();
    CREATE OR REPLACE FUNCTION guard_mcp_acquisition_rollback_name() RETURNS trigger AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM mcp_acquisition_operations o
          WHERE o.rollback_claim_id IS NOT NULL AND o.state IN ('verifying','failed')
          AND o.publication->>'storage'='postgres'
          AND lower(o.publication->'receipt'->>'serverName')=lower(NEW.name)) THEN
          RAISE EXCEPTION 'Server name is reserved for acquisition rollback';
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql SET search_path FROM CURRENT;
    CREATE OR REPLACE FUNCTION ensure_mcp_acquisition_rollback_guard() RETURNS void AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('mcphub-acquisition-rollback-guard'),hashtext(current_schema()));
        IF to_regclass('servers') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('servers') AND tgname='mcp_acquisition_rollback_name') THEN
          EXECUTE 'CREATE TRIGGER mcp_acquisition_rollback_name BEFORE INSERT OR UPDATE OF name ON servers
            FOR EACH ROW EXECUTE FUNCTION guard_mcp_acquisition_rollback_name()';
        END IF;
      END;
    $$ LANGUAGE plpgsql SET search_path FROM CURRENT;
    SELECT ensure_mcp_acquisition_rollback_guard();
  `);
}
