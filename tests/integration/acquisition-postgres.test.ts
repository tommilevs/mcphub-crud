import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ensureMcpAcquisitionSchema } from '../../src/db/mcpAcquisitionSchema.js';
import { AcquisitionPlanRepository, buildAcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';
import type { MarketServer } from '../../src/types/index.js';
import { AcquisitionOperationRepository } from '../../src/services/mcpAcquisitionOperation.js';

const postgresDescribe = process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD ? describe : describe.skip;
postgresDescribe('immutable MCP acquisition plans in PostgreSQL', () => {
  const schema = `acquisition_${randomUUID().replace(/-/g, '')}`;
  let admin: Client;
  let pool: Pool;
  let repository: AcquisitionPlanRepository;
  beforeAll(async () => {
    const config = {
      host: process.env.MCPHUB_ATTRIBUTION_TEST_HOST ?? '127.0.0.1',
      port: Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT ?? 5432),
      user: process.env.MCPHUB_ATTRIBUTION_TEST_USER ?? 'postgres',
      password: process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,
      database: process.env.MCPHUB_ATTRIBUTION_TEST_DB ?? 'mcphub_history_test',
    };
    admin = new Client(config);
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},public` });
    const db = { query: async (sql: string, args?: any[]) => (await pool.query(sql, args)).rows };
    await ensureMcpAcquisitionSchema(db);
    await ensureMcpAcquisitionSchema(db); // startup/restart must preserve existing schema
    repository = new AcquisitionPlanRepository(db);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount).toBe(0);
      await admin.end();
    }
  });

  test('persists exact plan across repository instances and isolates owners', async () => {
    const manifest = buildAcquisitionManifest({ name: 'synthetic', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', '@fixture/mcp'] },
    }, arguments: {} } as unknown as MarketServer, '1.2.3', 'fixture-group');
    const created = await repository.create('alice', manifest);
    const restarted = new AcquisitionPlanRepository({ query: async (sql, args) => (await pool.query(sql, args)).rows });
    expect((await restarted.get('alice', created.plan_id))?.manifest).toEqual(manifest);
    expect(await restarted.get('bob', created.plan_id)).toBeNull();
    await expect(pool.query('UPDATE mcp_acquisition_plans SET owner=$1 WHERE plan_id=$2', ['bob', created.plan_id]))
      .rejects.toThrow('immutable');
    await expect(pool.query('UPDATE mcp_acquisition_plans SET manifest=$1 WHERE plan_id=$2', ['{}', created.plan_id]))
      .rejects.toThrow('immutable');
    expect((await restarted.get('alice', created.plan_id))?.manifest_digest).toBe(created.manifest_digest);
  });

  test('expired plans are unavailable without changing immutable data', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO mcp_acquisition_plans(plan_id,owner,manifest,manifest_digest,created_at,expires_at)
      VALUES($1,'alice','{}',$2,NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour')`, [id, 'a'.repeat(64)]);
    expect(await repository.get('alice', id)).toBeNull();
  });

  test('refuses a persisted payload whose digest does not match', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO mcp_acquisition_plans(plan_id,owner,manifest,manifest_digest,expires_at)
      VALUES($1,'alice','{}',$2,NOW()+INTERVAL '1 hour')`, [id, 'a'.repeat(64)]);
    await expect(repository.get('alice', id)).rejects.toThrow('integrity');
    expect(await repository.get('bob', id)).toBeNull();
  });

  test('concurrent authorization creates one operation and rejects wrong owner/digest or reused key', async () => {
    const manifest = buildAcquisitionManifest({ name: 'synthetic', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', '@fixture/mcp'] },
    }, arguments: {} } as unknown as MarketServer, '1.2.3', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const key = randomUUID();
    expect(await repository.authorize('bob', plan.plan_id, plan.manifest_digest, key)).toBeNull();
    expect(await repository.authorize('alice', plan.plan_id, 'b'.repeat(64), key)).toBeNull();
    const operations = await Promise.all(Array.from({ length: 5 }, () =>
      repository.authorize('alice', plan.plan_id, plan.manifest_digest, key)));
    expect(new Set(operations.map(operation => operation.operation_id)).size).toBe(1);
    expect(operations[0].state).toBe('authorized');
    expect((await repository.get('alice', plan.plan_id))?.operation_state).toBe('authorized');
    const other = await repository.create('alice', manifest);
    expect(await repository.authorize('alice', other.plan_id, other.manifest_digest, key)).toBeNull();
    const otherOperation = await repository.authorize('alice', other.plan_id, other.manifest_digest, randomUUID());
    expect(otherOperation.state).toBe('authorized');
    // A plan that already has its own operation must not swallow another plan's key.
    expect(await repository.authorize('alice', other.plan_id, other.manifest_digest, key)).toBeNull();
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM mcp_acquisition_operations WHERE plan_id=$1', [plan.plan_id])).rows[0].count).toBe(1);
  });

  test('only one worker claims execution, cancellation blocks progress and stale claims cannot write', async () => {
    const db = { query: async (sql: string, args?: any[]) => (await pool.query(sql, args)).rows };
    const operations = new AcquisitionOperationRepository(db);
    const manifest = buildAcquisitionManifest({ name: 'fixture', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'] },
    } } as unknown as MarketServer, '1.0.0', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const operation = await repository.authorize('alice', plan.plan_id, plan.manifest_digest, randomUUID());
    expect(await operations.claim('bob', operation.operation_id)).toBeNull();
    const claims = (await Promise.all(Array.from({ length: 5 }, () => operations.claim('alice', operation.operation_id)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(await operations.transition('alice', operation.operation_id, randomUUID(), 'staging', 'starting')).toBeNull();
    expect((await operations.cancel('alice', operation.operation_id)).state).toBe('staging');
    expect(await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'starting')).toBeNull();
    expect((await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'rolled_back')).state).toBe('rolled_back');
    expect((await operations.cancel('alice', operation.operation_id)).state).toBe('rolled_back');
    expect(await operations.claim('alice', operation.operation_id)).toBeNull();
  });

  test('uncertain native outcomes block forward progress until cleanup is reconciled', async () => {
    const operations = new AcquisitionOperationRepository({ query: async (sql, args) => (await pool.query(sql, args)).rows });
    const manifest = buildAcquisitionManifest({ name: 'fixture', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'] },
    } } as unknown as MarketServer, '1.0.0', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const operation = await repository.authorize('alice', plan.plan_id, plan.manifest_digest, randomUUID());
    const claim = await operations.claim('alice', operation.operation_id);
    expect(await operations.requireReconciliation('bob', operation.operation_id, claim.claim_id)).toBe(false);
    expect(await operations.requireReconciliation('alice', operation.operation_id, claim.claim_id)).toBe(true);
    expect((await operations.get('alice', operation.operation_id)).requires_reconciliation).toBe(true);
    expect(await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'starting')).toBeNull();
    await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'failed', 'native_state_unknown');
    expect((await operations.get('alice', operation.operation_id)).failure_code).toBe('native_state_unknown');
    await operations.transition('alice', operation.operation_id, claim.claim_id, 'failed', 'rolled_back');
    expect((await operations.get('alice', operation.operation_id)).requires_reconciliation).toBe(false);
  });
});
