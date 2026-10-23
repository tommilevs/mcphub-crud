import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ensureAttributionContextSchema } from '../../src/db/attributionContextSchema.js';
import { AttributionContextRepository } from '../../src/db/repositories/AttributionContextRepository.js';
import { AttributionContextService } from '../../src/services/attributionContextService.js';
import type { Request, Response } from 'express';
let mockSummaryDb: { query: (sql: string, parameters?: unknown[]) => Promise<any> };
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => mockSummaryDb }));
import { getAttributionSummary } from '../../src/controllers/attributionController.js';

const suite = process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD ? describe : describe.skip;
suite('attribution PostgreSQL isolated schema', () => {
  const schema = `attribution_test_${randomUUID().replaceAll('-', '')}`;
  const config = {
    host: process.env.MCPHUB_ATTRIBUTION_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT ?? 5432),
    user: process.env.MCPHUB_ATTRIBUTION_TEST_USER,
    password: process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,
    database: process.env.MCPHUB_ATTRIBUTION_TEST_DB ?? 'postgres',
    connectionTimeoutMillis: 5000,
  };
  let admin: Client;
  let pool: Pool;
  let service: AttributionContextService;
  beforeAll(async () => {
    admin = new Client(config);
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...config, options: `-c search_path=${schema}`, max: 4 });
    await ensureAttributionContextSchema(pool);
    await ensureAttributionContextSchema(pool);
    service = new AttributionContextService(new AttributionContextRepository({
      query: async (sql, parameters) => (await pool.query(sql, parameters)).rows,
    }));
    mockSummaryDb = { query: async (sql, parameters) => (await pool.query(sql, parameters)).rows };
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount).toBe(0);
      await admin.end();
    }
  });
  test('persists contexts and emits exactly one successor on concurrent rotation', async () => {
    const first = await service.start('alice', { modelClaim: 'one' });
    expect((await service.resolve('alice', first.traceKey))?.identity.modelId).toBe('one');
    expect(await service.resolve('bob', first.traceKey)).toBeNull();
    const child = await service.fork('alice', first.traceKey);
    expect(child?.traceId).toBe(first.traceId);
    const rotations = await Promise.all([
      service.rotate('alice', first.traceKey, 'two'), service.rotate('alice', first.traceKey, 'three'),
    ]);
    expect(rotations.filter(Boolean)).toHaveLength(1);
    expect(await service.resolve('alice', first.traceKey)).toBeNull();
    const events = (await pool.query('SELECT event_type FROM attribution_identity_events ORDER BY event_type')).rows;
    expect(events.map((row) => row.event_type)).toEqual(['branch_forked', 'context_started', 'model_rotated']);
  });
  test('rolls back context issuance when its identity event cannot be saved', async () => {
    const before = (await pool.query('SELECT count(*) FROM attribution_contexts')).rows[0].count;
    await pool.query(`CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated event failure'; END; $$;
      CREATE TRIGGER reject_test_event BEFORE INSERT ON attribution_identity_events
      FOR EACH ROW EXECUTE FUNCTION reject_test_event()`);
    try {
      await expect(service.start('rollback-user')).rejects.toThrow('simulated event failure');
      expect((await pool.query('SELECT count(*) FROM attribution_contexts')).rows[0].count).toBe(before);
    } finally {
      await pool.query('DROP TRIGGER reject_test_event ON attribution_identity_events');
    }
  });
  test('cleanup removes only old expired contexts and cascades their events', async () => {
    const old = await service.start('retention-user');
    const live = await service.start('retention-user');
    await pool.query("UPDATE attribution_contexts SET expires_at = NOW() - INTERVAL '31 days' WHERE context_id=$1", [old.contextId]);
    const repository = new AttributionContextRepository({ query: async (sql, parameters) => (await pool.query(sql, parameters)).rows });
    expect(await repository.pruneExpired(new Date(Date.now() - 30 * 86400000), 1)).toBe(1);
    expect(await service.resolve('retention-user', old.traceKey)).toBeNull();
    expect(await service.resolve('retention-user', live.traceKey)).not.toBeNull();
    expect((await pool.query('SELECT 1 FROM attribution_identity_events WHERE context_id=$1', [old.contextId])).rowCount).toBe(0);
  });
  test('summary counts legacy, self-reported and conflicted calls without false verification', async () => {
    await pool.query('CREATE TABLE tool_results (timestamp timestamptz DEFAULT NOW(), status text, attribution jsonb)');
    await pool.query(`INSERT INTO tool_results (status, attribution) VALUES
      ('success', NULL),
      ('error', '{"identity":{"modelId":"model-a","source":"self_reported","verified":false}}'),
      ('success', '{"identity":{"modelId":null,"source":"unknown","verified":false},"conflictReason":"conflict"}')`);
    let payload: any;
    await getAttributionSummary({ user: { isAdmin: true }, query: {} } as unknown as Request, {
      json: (value: unknown) => { payload = value; },
      status: () => { throw new Error('Summary request failed'); },
    } as unknown as Response);
    expect(payload.data).toMatchObject({ total: 3, known: 1, verified: 0, conflicted: 1, executionErrors: 1 });
    expect(payload.data.models.find((row: any) => row.model_id === 'model-a')).toMatchObject({ calls: 1, execution_errors: 1, source: 'self_reported' });
  });
});
