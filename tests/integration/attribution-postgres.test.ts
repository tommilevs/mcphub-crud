import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ensureAttributionContextSchema } from '../../src/db/attributionContextSchema.js';
import { AttributionContextRepository } from '../../src/db/repositories/AttributionContextRepository.js';
import { AttributionContextService } from '../../src/services/attributionContextService.js';
import type { Request, Response } from 'express';
let mockSummaryDb: { query: (sql: string, parameters?: unknown[]) => Promise<any> };
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => mockSummaryDb }));
import { getAttributionSummary } from '../../src/controllers/attributionController.js';
import { saveTaskReview } from '../../src/controllers/taskReviewController.js';
import { ToolResultRepositoryDb } from '../../src/db/repositories/ToolResultRepository.js';
import { observeLoopGuard } from '../../src/services/loopGuardCoordinator.js';

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
  test('task reviews reject concurrent stale writes and preserve consent revocation history', async () => {
    const task = await service.start('review-user');
    const save = async (revision: number, consent: boolean) => {
      let status = 200;
      let data: any;
      const res = { status: (value: number) => { status = value; return res; }, json: (value: any) => { data = value; } };
      await saveTaskReview({ user: { isAdmin: true, username: 'reviewer' }, params: { taskId: task.taskId },
        body: { outcome: 'partial', trainingConsent: consent, revision },
      } as unknown as Request, res as unknown as Response);
      return { status, data };
    };
    const concurrent = await Promise.all([save(0, true), save(0, true)]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await save(1, false)).status).toBe(200);
    const reviews = (await pool.query('SELECT revision, training_consent FROM attribution_task_reviews WHERE task_id=$1 ORDER BY revision', [task.taskId])).rows;
    expect(reviews).toEqual([{ revision: 1, training_consent: true }, { revision: 2, training_consent: false }]);
  });
  test('history reads the latest review without modifying stored RAW', async () => {
    const task = await service.start('history-review-user');
    const resultId = randomUUID();
    const raw = '{"content":[{"type":"text","text":"immutable evidence"}]}';
    await pool.query(`ALTER TABLE tool_results ADD COLUMN result_id uuid;
      ALTER TABLE tool_results ADD COLUMN raw text;
      CREATE TABLE tool_result_state (result_id uuid PRIMARY KEY, pinned boolean DEFAULT false,
        use_count integer DEFAULT 0, last_referenced_at timestamptz, loop_guard_advice jsonb)`);
    await pool.query('INSERT INTO tool_results (result_id, status, attribution, raw) VALUES ($1,$2,$3,$4)',
      [resultId, 'success', JSON.stringify({ taskId: task.taskId }), raw]);
    await pool.query('INSERT INTO tool_result_state (result_id) VALUES ($1)', [resultId]);
    await pool.query(`INSERT INTO attribution_task_reviews (task_id, revision, outcome, training_consent, reviewed_by)
      VALUES ($1,1,'success',true,'reviewer'),($1,2,'partial',false,'reviewer')`, [task.taskId]);
    const repository = new ToolResultRepositoryDb(mockSummaryDb as never);
    const result = await repository.findById(resultId);
    expect(result?.taskReview).toMatchObject({ revision: 2, outcome: 'partial', trainingConsent: false });
    expect(result?.raw).toBe(raw);
    expect((await pool.query('SELECT raw FROM tool_results WHERE result_id=$1', [resultId])).rows[0].raw).toBe(raw);
  });
  test('discovery evidence persists once per call and contains no query payload', async () => {
    const task = await service.start('discovery-user');
    const context = (await service.resolve('discovery-user', task.traceKey))!;
    const callId = randomUUID();
    const evidence = { operation: 'search_tools' as const, candidates: [{ name: 'demo-tool', schemaSha256: null }], truncated: false };
    await service.recordDiscovery(context, callId, evidence);
    await service.recordDiscovery(context, callId, evidence);
    const rows = (await pool.query('SELECT evidence FROM attribution_discovery_events WHERE call_id=$1', [callId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence).toEqual(evidence);
  });
  test('LoopGuard isolates trace branches and persists advice outside RAW', async () => {
    const oldFlag = process.env.MCPHUB_LOOP_GUARD_ENABLED;
    const oldIgnored = process.env.MCPHUB_LOOP_GUARD_IGNORED_TOOLS;
    process.env.MCPHUB_LOOP_GUARD_ENABLED = 'true';
    try {
      await pool.query(`ALTER TABLE tool_results ADD COLUMN username text;
        ALTER TABLE tool_results ADD COLUMN key_id text;
        ALTER TABLE tool_results ADD COLUMN server text;
        ALTER TABLE tool_results ADD COLUMN tool text;
        ALTER TABLE tool_results ADD COLUMN arguments text;
        ALTER TABLE tool_results ADD COLUMN raw_sha256 text`);
      const traceId = randomUUID(), branchId = randomUUID();
      let record: any;
      for (let index = 0; index < 3; index++) {
        record = { resultId: randomUUID(), timestamp: new Date(Date.now() - 3000 + index * 1000),
          server: 'demo', tool: 'inspect', status: 'error', arguments: '{}', rawSha256: 'same-error',
          username: 'loop-user', attribution: { traceId, branchId } };
        await pool.query(`INSERT INTO tool_results (result_id,timestamp,server,tool,status,arguments,raw_sha256,username,attribution)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [record.resultId, record.timestamp, record.server, record.tool,
          record.status, record.arguments, record.rawSha256, record.username, JSON.stringify(record.attribution)]);
        await pool.query('INSERT INTO tool_result_state (result_id) VALUES ($1)', [record.resultId]);
      }
      const advice = await observeLoopGuard(record);
      expect(advice?.trigger).toBe('repeated_identical_failure');
      expect((await pool.query('SELECT loop_guard_advice FROM tool_result_state WHERE result_id=$1', [record.resultId])).rows[0].loop_guard_advice).toEqual(advice);
      expect(await observeLoopGuard({ ...record, attribution: { traceId, branchId: randomUUID() } })).toBeNull();
      const cycleBranch = randomUUID();
      for (let index = 0; index < 6; index++) {
        record = { ...record, resultId: randomUUID(), timestamp: new Date(Date.now() - 6000 + index * 1000),
          tool: index % 2 ? 'diagnose-b' : 'diagnose-a', rawSha256: index % 2 ? 'error-b' : 'error-a',
          attribution: { traceId, branchId: cycleBranch } };
        await pool.query(`INSERT INTO tool_results (result_id,timestamp,server,tool,status,arguments,raw_sha256,username,attribution)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [record.resultId, record.timestamp, record.server, record.tool,
          record.status, record.arguments, record.rawSha256, record.username, JSON.stringify(record.attribution)]);
        await pool.query('INSERT INTO tool_result_state (result_id) VALUES ($1)', [record.resultId]);
      }
      expect((await observeLoopGuard(record))?.trigger).toBe('alternating_failure_cycle');
      expect(await observeLoopGuard({ ...record, rawSha256: 'new-progress' })).toBeNull();
      process.env.MCPHUB_LOOP_GUARD_IGNORED_TOOLS = 'demo/diagnose-a';
      expect(await observeLoopGuard(record)).toBeNull();
    } finally {
      if (oldFlag === undefined) delete process.env.MCPHUB_LOOP_GUARD_ENABLED;
      else process.env.MCPHUB_LOOP_GUARD_ENABLED = oldFlag;
      if (oldIgnored === undefined) delete process.env.MCPHUB_LOOP_GUARD_IGNORED_TOOLS;
      else process.env.MCPHUB_LOOP_GUARD_IGNORED_TOOLS = oldIgnored;
    }
  });
});
