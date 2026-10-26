jest.mock('openid-client', () => ({}));
// Substitute only the isolated database connection and local catalog. The HTTP
// auth, queue, repositories, npm/DPAPI IPC, MCP SDK and activation are real.
let mockAcquisitionDb: any;
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => mockAcquisitionDb }));
jest.mock('../../src/services/marketService.js', () => ({ getMarketServers: () => ({
  'native-acquisition-fixture': { name: 'native-acquisition-fixture', installations: {
    npm: { type: 'npm', command: 'npx', args: ['-y', 'mcphub-acquisition-fixture'] },
  }, arguments: { FIXTURE_KEY: { required: true } } },
}) }));
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { Client as PgClient, Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { ensureMcpAcquisitionSchema } from '../../src/db/mcpAcquisitionSchema.js';
import { ensureToolResultHistorySchema } from '../../src/db/toolResultHistorySchema.js';
import { clearSettingsCache } from '../../src/config/index.js';
import { JsonFileDaoFactory, setDaoFactory } from '../../src/dao/DaoFactory.js';
import { auth } from '../../src/middlewares/auth.js';
import { requireAdminMiddleware } from '../../src/utils/requireAdmin.js';
import { createUserToken } from '../utils/testHelpers.js';
import { createMcpAcquisitionPlan, authorizeMcpAcquisitionPlan, executeMcpAcquisitionOperation,
  getMcpAcquisitionOperation, cancelMcpAcquisitionOperation, reviewInterruptedMcpAcquisition } from '../../src/controllers/mcpAcquisitionController.js';
import { AcquisitionOperationRepository } from '../../src/services/mcpAcquisitionOperation.js';
import { getServerByName, cleanupAllServers, initializeClientsFromSettings } from '../../src/services/mcpService.js';
import { deleteNativeRuntimeSecret, forgetNativeInstall, getNativeRuntimeStatus, inspectNativeInstallCleanup, getNativeInstallStatus } from '../../src/services/nativeRuntimeSecretService.js';
import * as inspectionModule from '../../src/services/mcpAcquisitionInspection.js';
import { NativeRuntimeTransport } from '../../src/services/nativeRuntimeTransport.js';

const suite = process.platform === 'win32' && process.env.MCPHUB_ACQUISITION_TEST_ROOT &&
  process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD ? describe : describe.skip;
suite('HTTP acquisition through real Windows service and PostgreSQL', () => {
  const root = process.env.MCPHUB_ACQUISITION_TEST_ROOT!;
  const schema = `native_acquisition_${randomUUID().replace(/-/g, '')}`;
  const prefix = '/api/market/acquisition';
  let admin: PgClient, pool: Pool, registry: http.Server, app: express.Express;
  let id: string | undefined;
  let holdRegistry = false;
  let registryReached: (() => void) | undefined;
  const heldResponses = new Set<http.ServerResponse>();
  const original = { settings: process.env.MCPHUB_SETTING_PATH, useDb: process.env.USE_DB,
    native: process.env.MCPHUB_NATIVE_RUNTIME_ENABLED, pipe: process.env.MCPHUB_NATIVE_PIPE };
  beforeAll(async () => {
    process.env.MCPHUB_SETTING_PATH = path.join(root, 'settings.json');
    process.env.USE_DB = 'false';
    process.env.MCPHUB_NATIVE_RUNTIME_ENABLED = 'true';
    process.env.MCPHUB_NATIVE_PIPE = process.env.MCPHUB_NATIVE_TEST_PIPE;
    const start = NativeRuntimeTransport.prototype.start;
    jest.spyOn(NativeRuntimeTransport.prototype, 'start').mockImplementation(async function(this: NativeRuntimeTransport) {
      const report = this.onerror;
      this.onerror = error => { process.stderr.write(`Synthetic native transport: ${error.message}\n`); report?.(error); };
      return start.call(this);
    });
    const inspect = inspectionModule.inspectAcquiredMcp;
    jest.spyOn(inspectionModule, 'inspectAcquiredMcp').mockImplementation(async (...args) => {
      try { return await inspect(...args); }
      catch (error) {
        // Entire harness is synthetic. Keep diagnostics here, never in production logs.
        process.stderr.write(`Synthetic acquisition inspection failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
        throw error;
      }
    });
    const config = { host: '127.0.0.1', port: Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT),
      user: 'postgres', password: process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD, database: 'postgres' };
    admin = new PgClient(config); await admin.connect();
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},public` });
    mockAcquisitionDb = { isInitialized: true, query: async (sql: string, args?: any[]) => {
      try { return (await pool.query(sql, args)).rows; }
      catch (error: any) { process.stderr.write(`Synthetic database failure: ${error.code} ${error.message}\n`); throw error; }
    } };
    await ensureMcpAcquisitionSchema(mockAcquisitionDb);
    await ensureToolResultHistorySchema(mockAcquisitionDb);
    const settings = { mcpServers: {}, users: ['alice', 'bob'].map(username => ({ username, password: 'unused', isAdmin: true })),
      groups: [{ id: 'fixture-group', name: 'fixture-group', owner: 'alice', visibility: 'private', servers: [] }],
      systemConfig: { smartRouting: { enabled: false }, oauthServer: { enabled: false },
        routing: { skipAuth: false, enableBearerAuth: false } } };
    fs.writeFileSync(process.env.MCPHUB_SETTING_PATH, JSON.stringify(settings));
    clearSettingsCache(); JsonFileDaoFactory.getInstance().resetInstances(); setDaoFactory(JsonFileDaoFactory.getInstance());
    await initializeClientsFromSettings(true);
    const tarball = fs.readFileSync(process.env.MCPHUB_ACQUISITION_TEST_TARBALL!);
    const registryPort = Number(process.env.MCPHUB_ACQUISITION_REGISTRY_PORT);
    registry = http.createServer((req, res) => {
      if (req.url === '/fixture.tgz') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(tarball); return; }
      if (req.url === '/mcphub-acquisition-fixture') {
        if (holdRegistry) {
          heldResponses.add(res);
          res.once('close', () => heldResponses.delete(res));
          registryReached?.();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: 'mcphub-acquisition-fixture', 'dist-tags': { latest: '1.0.0' }, versions: {
          '1.0.0': { name: 'mcphub-acquisition-fixture', version: '1.0.0',
            bin: { 'mcphub-acquisition-fixture': 'index.cjs' }, dist: {
              tarball: `http://127.0.0.1:${registryPort}/fixture.tgz`, shasum: createHash('sha1').update(tarball).digest('hex'),
            } },
        } })); return;
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>((resolve, reject) => { registry.once('error', reject); registry.listen(registryPort, '127.0.0.1', resolve); });
    app = express(); app.use(express.json()); app.use('/api', auth, requireAdminMiddleware);
    app.post(`${prefix}/plans`, createMcpAcquisitionPlan);
    app.post(`${prefix}/plans/:id/authorize`, authorizeMcpAcquisitionPlan);
    app.post(`${prefix}/operations/:id/execute`, executeMcpAcquisitionOperation);
    app.get(`${prefix}/operations/:id`, getMcpAcquisitionOperation);
    app.post(`${prefix}/operations/:id/cancel`, cancelMcpAcquisitionOperation);
    app.post(`${prefix}/operations/:id/review-interrupted`, reviewInterruptedMcpAcquisition);
  }, 30000);
  afterAll(async () => {
    const info = getServerByName('native-acquisition-fixture');
    await info?.transport?.close(); await info?.client?.close(); cleanupAllServers();
    if (id) {
      await deleteNativeRuntimeSecret(`acq-${createHash('sha256').update(`alice\0${id}\0FIXTURE_KEY`).digest('hex')}`);
      await forgetNativeInstall(id);
    }
    for (const response of heldResponses) response.destroy();
    if (registry) await new Promise<void>(resolve => registry.close(() => resolve()));
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    for (const [name, value] of Object.entries({ MCPHUB_SETTING_PATH: original.settings, USE_DB: original.useDb,
      MCPHUB_NATIVE_RUNTIME_ENABLED: original.native, MCPHUB_NATIVE_PIPE: original.pipe })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    clearSettingsCache(); JsonFileDaoFactory.getInstance().resetInstances();
  }, 30000);

  test('owner cancellation stops an in-flight native npm job without publishing or replaying it', async () => {
    const token = createUserToken('alice', true);
    const plan = (await request(app).post(`${prefix}/plans`).set('x-auth-token', token)
      .send({ serverName: 'native-acquisition-fixture', version: '1.0.0', targetGroup: 'fixture-group' }).expect(201)).body.data;
    const operationId = (await request(app).post(`${prefix}/plans/${plan.plan_id}/authorize`).set('x-auth-token', token)
      .send({ digest: plan.manifest_digest, idempotencyKey: randomUUID() }).expect(200)).body.data.operation_id;
    const endpoint = `${prefix}/operations/${operationId}`;
    const reached = new Promise<void>(resolve => { registryReached = resolve; });
    holdRegistry = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await request(app).post(`${endpoint}/execute`).set('x-auth-token', token)
        .send({ credentials: { FIXTURE_KEY: 'synthetic-cancel-only' } }).expect(202);
      await Promise.race([reached, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native npm did not reach the held registry')), 30000);
      })]);
      clearTimeout(timer);
      const staging = (await request(app).get(endpoint).set('x-auth-token', token).expect(200)).body.data;
      expect(staging.state).toBe('staging');
      await expect(inspectNativeInstallCleanup(operationId,'mcphub-acquisition-fixture','1.0.0')).rejects.toThrow('terminal');
      await request(app).post(`${endpoint}/cancel`).set('x-auth-token', createUserToken('bob', true)).expect(404);
      await request(app).post(`${endpoint}/cancel`).set('x-auth-token', token).expect(200);
      const deadline = Date.now() + 20000;
      let observed: any;
      do {
        observed = (await request(app).get(endpoint).set('x-auth-token', token).expect(200)).body.data;
        if (observed.state === 'failed' || observed.requires_reconciliation) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      expect(observed).toMatchObject({ state: 'failed', cancel_requested: true,
        failure_code: 'cancelled_requires_cleanup', requires_reconciliation: false });
      const nativeStatus=await getNativeInstallStatus(operationId);
      if(nativeStatus.processExitConfirmed===true) {
        const preflight=await inspectNativeInstallCleanup(operationId,'mcphub-acquisition-fixture','1.0.0');
        expect(preflight).toMatchObject({id:operationId,verification:'cleanup_preflight',state:'cancelled'});
      } else {
        await expect(inspectNativeInstallCleanup(operationId,'mcphub-acquisition-fixture','1.0.0')).rejects.toThrow('terminal');
      }
      await expect(inspectNativeInstallCleanup(operationId,'mcphub-acquisition-fixture','2.0.0')).rejects.toThrow('identity');
      expect(getServerByName('native-acquisition-fixture')).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(process.env.MCPHUB_SETTING_PATH!, 'utf8')).mcpServers).toEqual({});
      // Known stopped work retains its package/credentials until explicit owned cleanup.
      expect(fs.existsSync(path.join(root, 'acquisitions', operationId, 'operation.json'))).toBe(true);
      await request(app).post(`${endpoint}/execute`).set('x-auth-token', token)
        .send({ credentials: { FIXTURE_KEY: 'synthetic-cancel-only' } }).expect(409);
    } finally {
      clearTimeout(timer); holdRegistry = false; registryReached = undefined;
      for (const response of heldResponses) response.destroy();
      await deleteNativeRuntimeSecret(`acq-${createHash('sha256').update(`alice\0${operationId}\0FIXTURE_KEY`).digest('hex')}`);
      await forgetNativeInstall(operationId);
    }
  }, 60000);

  test('JWT owner executes once, retains RAW, publishes and activates a credential-backed package', async () => {
    const token = createUserToken('alice', true), bob = createUserToken('bob', true);
    await request(app).post(`${prefix}/plans`).send({}).expect(401);
    const plan = (await request(app).post(`${prefix}/plans`).set('x-auth-token', token)
      .send({ serverName: 'native-acquisition-fixture', version: '1.0.0', targetGroup: 'fixture-group', probeTool: 'fixture_probe' }).expect(201)).body.data;
    const operation = (await request(app).post(`${prefix}/plans/${plan.plan_id}/authorize`).set('x-auth-token', token)
      .send({ digest: plan.manifest_digest, idempotencyKey: randomUUID() }).expect(200)).body.data;
    id = operation.operation_id;
    const endpoint = `${prefix}/operations/${id}`;
    await request(app).post(`${endpoint}/execute`).set('x-auth-token', token).send({}).expect(400);
    // A separate authorization can be cancelled before credentials or native work.
    const cancelPlan = (await request(app).post(`${prefix}/plans`).set('x-auth-token', token)
      .send({ serverName: 'native-acquisition-fixture', version: '1.0.0', targetGroup: 'fixture-group' }).expect(201)).body.data;
    const cancelId = (await request(app).post(`${prefix}/plans/${cancelPlan.plan_id}/authorize`).set('x-auth-token', token)
      .send({ digest: cancelPlan.manifest_digest, idempotencyKey: randomUUID() }).expect(200)).body.data.operation_id;
    const cancelled = await request(app).post(`${prefix}/operations/${cancelId}/cancel`).set('x-auth-token', token).expect(200);
    expect(cancelled.body.data).toMatchObject({ state: 'cancelled', cancel_requested: true });
    await request(app).post(`${prefix}/operations/${cancelId}/execute`).set('x-auth-token', token)
      .send({ credentials: { FIXTURE_KEY: 'synthetic-acquisition-only' } }).expect(409);
    expect(fs.existsSync(path.join(root, 'acquisitions', cancelId))).toBe(false);
    const stalePlan = (await request(app).post(`${prefix}/plans`).set('x-auth-token', token)
      .send({ serverName: 'native-acquisition-fixture', version: '1.0.0', targetGroup: 'fixture-group' }).expect(201)).body.data;
    const staleId = (await request(app).post(`${prefix}/plans/${stalePlan.plan_id}/authorize`).set('x-auth-token', token)
      .send({ digest: stalePlan.manifest_digest, idempotencyKey: randomUUID() }).expect(200)).body.data.operation_id;
    const operations = new AcquisitionOperationRepository(mockAcquisitionDb);
    expect(await operations.claimExecution('alice', staleId, stalePlan.manifest_digest)).toBeTruthy();
    await request(app).post(`${prefix}/operations/${staleId}/review-interrupted`).set('x-auth-token', token).send({}).expect(409);
    await pool.query(`UPDATE mcp_acquisition_operations SET execution_heartbeat_at=NOW()-INTERVAL '3 minutes' WHERE operation_id=$1`, [staleId]);
    await request(app).post(`${prefix}/operations/${staleId}/review-interrupted`).set('x-auth-token', bob).send({}).expect(409);
    const reviewed = await request(app).post(`${prefix}/operations/${staleId}/review-interrupted`).set('x-auth-token', token).send({}).expect(200);
    expect(reviewed.body.data).toMatchObject({ state: 'failed', requires_reconciliation: true });
    await request(app).post(`${prefix}/operations/${staleId}/execute`).set('x-auth-token', token)
      .send({ credentials: { FIXTURE_KEY: 'synthetic-acquisition-only' } }).expect(409);
    expect(fs.existsSync(path.join(root, 'acquisitions', staleId))).toBe(false);
    await request(app).post(`${endpoint}/execute`).set('x-auth-token', bob).send({ credentials: { FIXTURE_KEY: 'synthetic-acquisition-only' } }).expect(409);
    const accepted = await request(app).post(`${endpoint}/execute`).set('x-auth-token', token)
      .send({ credentials: { FIXTURE_KEY: 'synthetic-acquisition-only' } }).expect(202);
    expect(JSON.stringify(accepted.body)).not.toContain('synthetic-acquisition-only');
    await request(app).post(`${endpoint}/execute`).set('x-auth-token', token).send({ credentials: { FIXTURE_KEY: 'synthetic-acquisition-only' } }).expect(409);
    const deadline = Date.now() + 90000;
    let observed: any;
    do {
      observed = (await request(app).get(endpoint).set('x-auth-token', token).expect(200)).body.data;
      if (['ready', 'failed', 'rolled_back', 'cancelled'].includes(observed.state) || observed.requires_reconciliation) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (observed.state !== 'ready') {
      process.stderr.write(`Synthetic acquisition phase: ${JSON.stringify(observed)}\n`);
      process.stderr.write(`Synthetic probe journal: ${JSON.stringify((await pool.query('SELECT probe_claim_id,probe_result_id FROM mcp_acquisition_operations WHERE operation_id=$1', [id])).rows)}\n`);
      for (const name of ['fixture-events.txt', 'fixture-error.txt']) {
        const file = path.join(root, 'acquisitions', id!, name);
        if (fs.existsSync(file)) process.stderr.write(`Synthetic ${name}: ${fs.readFileSync(file, 'utf8').slice(0, 2500)}\n`);
      }
    }
    expect(observed).toMatchObject({ state: 'ready', verification: 'functional', execution_started: true, requires_reconciliation: false });
    await request(app).get(endpoint).set('x-auth-token', bob).expect(404);
    const raw = await pool.query('SELECT raw,status,payload_available FROM tool_results WHERE result_id=$1 AND username=$2', [observed.probe_result_id, 'alice']);
    expect(raw.rows).toHaveLength(1); expect(raw.rows[0]).toMatchObject({ status: 'success', payload_available: true });
    expect(JSON.parse(raw.rows[0].raw).content).toEqual([{ type: 'text', text: '{"credentialPresent":true}' }]);
    expect(JSON.stringify(raw.rows[0].raw)).not.toContain('synthetic-acquisition-only');
    await expect(pool.query('UPDATE tool_results SET raw=$1 WHERE result_id=$2', ['changed', observed.probe_result_id])).rejects.toThrow();
    const stored = fs.readFileSync(process.env.MCPHUB_SETTING_PATH!, 'utf8');
    expect(stored).not.toContain('synthetic-acquisition-only');
    expect(JSON.parse(stored).groups[0].servers).toEqual([{ name: 'native-acquisition-fixture', tools: ['check_environment', 'fixture_probe'], prompts: [], resources: [] }]);
    const info = getServerByName('native-acquisition-fixture');
    expect(info?.status).toBe('connected');
    const called = await info!.client!.callTool({ name: 'check_environment', arguments: {} });
    expect(called.content).toEqual([{ type: 'text', text: '{"credentialPresent":true}' }]);
    expect(fs.readFileSync(path.join(root, 'acquisitions', id!, 'probe-calls.txt'), 'utf8')).toBe('probe\n');
    expect(JSON.stringify(await getNativeRuntimeStatus())).not.toContain('synthetic-acquisition-only');
  }, 100000);
});
