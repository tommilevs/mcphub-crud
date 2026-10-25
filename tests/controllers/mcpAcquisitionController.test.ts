import express from 'express';
import request from 'supertest';
import { proposeMcpAcquisition, createMcpAcquisitionPlan, getMcpAcquisitionPlan, authorizeMcpAcquisitionPlan,
  getMcpAcquisitionOperation, cancelMcpAcquisitionOperation, executeMcpAcquisitionOperation } from '../../src/controllers/mcpAcquisitionController.js';
import { enqueueAcquisitionExecution } from '../../src/services/mcpAcquisitionExecutionQueue.js';
import { loadSettings } from '../../src/config/configManager.js';
import { getMarketServers } from '../../src/services/marketService.js';
import { requireAdminMiddleware } from '../../src/utils/requireAdmin.js';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));

jest.mock('../../src/config/configManager.js', () => ({ loadSettings: jest.fn() }));
jest.mock('../../src/services/marketService.js', () => ({ getMarketServers: jest.fn() }));
jest.mock('../../src/services/mcpAcquisitionExecutionQueue.js',()=>({enqueueAcquisitionExecution:jest.fn()}));

const app = express();
let username: string | undefined;
let authMethod: string | undefined;
app.use(express.json());
app.use((req, _res, next) => { (req as any).user = username ? { username, isAdmin: true } : undefined; (req as any).authMethod = authMethod; next(); });
app.post('/proposals', proposeMcpAcquisition);
app.post('/plans', createMcpAcquisitionPlan);
app.get('/plans/:id', getMcpAcquisitionPlan);
app.post('/plans/:id/authorize', authorizeMcpAcquisitionPlan);
app.get('/operations/:id', getMcpAcquisitionOperation);
app.post('/operations/:id/cancel', cancelMcpAcquisitionOperation);
app.post('/operations/:id/execute', executeMcpAcquisitionOperation);
beforeEach(() => { jest.resetAllMocks(); username = undefined; authMethod = undefined; });

test('execution requires dashboard authentication and rejects caller-selected commands',async()=>{
  username='alice';authMethod='apiKey';
  await request(app).post('/operations/operation/execute').send({authMethod:'jwt'}).expect(403);
  authMethod='jwt';
  await request(app).post('/operations/operation/execute').send({command:'arbitrary.exe'}).expect(400);
  expect(enqueueAcquisitionExecution).not.toHaveBeenCalled();
});
test('execution accepts an owner-bound background job without returning credential values',async()=>{
  username='alice';authMethod='jwt';(enqueueAcquisitionExecution as jest.Mock).mockResolvedValue({accepted:true});
  const result=await request(app).post('/operations/operation/execute').send({credentials:{API_KEY:'private-fixture'}}).expect(202);
  expect(enqueueAcquisitionExecution).toHaveBeenCalledWith('alice','operation',{API_KEY:'private-fixture'});
  expect(JSON.stringify(result.body)).not.toContain('private-fixture');
});
test('duplicate execution returns conflict without acknowledging another job',async()=>{
  username='alice';authMethod='session';(enqueueAcquisitionExecution as jest.Mock).mockResolvedValue({accepted:false});
  await request(app).post('/operations/operation/execute').send({}).expect(409);
});
test('unexpected execution errors cannot expose credential diagnostics',async()=>{
  username='alice';authMethod='jwt';(enqueueAcquisitionExecution as jest.Mock).mockRejectedValue(new Error('private-fixture-value'));
  const result=await request(app).post('/operations/operation/execute').send({credentials:{API_KEY:'private-fixture-value'}}).expect(503);
  expect(JSON.stringify(result.body)).not.toContain('private-fixture-value');
});

test('shared admin gate denies requests without admin identity before catalog access', async () => {
  const guarded = express();
  guarded.use(express.json());
  guarded.post('/proposals', requireAdminMiddleware, proposeMcpAcquisition);
  await request(guarded).post('/proposals').send({ objective: 'browser' }).expect(403);
  expect(loadSettings).not.toHaveBeenCalled();
  expect(getMarketServers).not.toHaveBeenCalled();
});

test('rejects invalid inputs before reading configuration', async () => {
  for (const body of [{}, { objective: 5 }, { objective: 'browser', limit: '3' }]) {
    await request(app).post('/proposals').send(body).expect(400);
  }
  expect(loadSettings).not.toHaveBeenCalled();
  expect(getMarketServers).not.toHaveBeenCalled();
});

test('uses all configured names for exclusion and returns metadata only', async () => {
  (loadSettings as jest.Mock).mockResolvedValue({ mcpServers: { hidden: { enabled: false, env: { KEY: 'private' } } } });
  (getMarketServers as jest.Mock).mockReturnValue(Object.fromEntries(['hidden', 'new'].map(name => [name, {
    name, description: 'browser automation', installations: { npm: { command: 'never-return-me' } },
  }])));
  const response = await request(app).post('/proposals').send({ objective: 'browser' }).expect(200);
  expect(response.body.data.candidates.map((candidate: { name: string }) => candidate.name)).toEqual(['new']);
  expect(JSON.stringify(response.body)).not.toMatch(/hidden|private|never-return-me/);
  expect(response.body.data.installationPerformed).toBe(false);
});

test('configuration failures cannot leak diagnostic secrets', async () => {
  (loadSettings as jest.Mock).mockRejectedValue(new Error('private credential'));
  const response = await request(app).post('/proposals').send({ objective: 'browser' }).expect(500);
  expect(JSON.stringify(response.body)).not.toContain('private credential');
});

test('plan creation requires an authenticated owner and existing target group', async () => {
  await request(app).post('/plans').send({}).expect(401);
  username = 'alice';
  await request(app).post('/plans').send({}).expect(400);
  (loadSettings as jest.Mock).mockResolvedValue({ groups: [] });
  await request(app).post('/plans').send({ serverName: 'fixture', version: '1.0.0', targetGroup: 'unknown' }).expect(404);
  expect(mockQuery).not.toHaveBeenCalled();
});

test('plan creation binds to authenticated owner and never executes or authorizes', async () => {
  username = 'alice';
  (loadSettings as jest.Mock).mockResolvedValue({ groups: [{ id: 'group' }], mcpServers: {} });
  (getMarketServers as jest.Mock).mockReturnValue({ fixture: { name: 'fixture', installations: {
    npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'], env: { KEY: 'private-value' } },
  } } });
  mockQuery.mockImplementation(async (_sql, args) => [{ plan_id: args[0], manifest: JSON.parse(args[2]), manifest_digest: args[3] }]);
  const response = await request(app).post('/plans').send({ serverName: 'fixture', version: '1.0.0', targetGroup: 'group', probeTool: 'fixture_ping', owner: 'bob', approved: true }).expect(201);
  expect(mockQuery.mock.calls[0][1][1]).toBe('alice');
  expect(response.body.data).toMatchObject({ status: 'proposed', verification: 'catalog_only', manifest: { package: { version: '1.0.0' } } });
  expect(response.body.data.manifest.probe).toEqual({ tool: 'fixture_ping' });
  expect(JSON.stringify(response.body)).not.toContain('private-value');
});

test('configured names cannot become duplicate plans and missing plans do not reveal owners', async () => {
  username = 'alice';
  (loadSettings as jest.Mock).mockResolvedValue({ groups: [{ id: 'group' }], mcpServers: { FIXTURE: { enabled: false } } });
  await request(app).post('/plans').send({ serverName: 'fixture', version: '1.0.0', targetGroup: 'group' }).expect(409);
  expect(mockQuery).not.toHaveBeenCalled();
  mockQuery.mockResolvedValue([]);
  await request(app).get('/plans/00000000-0000-4000-8000-000000000000').expect(404);
  expect(mockQuery.mock.calls[0][1][1]).toBe('alice');
});

test('model approval flags cannot authorize through bearer/forward/skip authentication', async () => {
  username = 'alice';
  for (const method of ['bearer', 'forward', 'skip', undefined]) {
    authMethod = method;
    await request(app).post('/plans/00000000-0000-4000-8000-000000000000/authorize')
      .send({ approved: true, authMethod: 'jwt' }).expect(403);
  }
  expect(mockQuery).not.toHaveBeenCalled();
});

test('dashboard approval requires an exact digest and rejects unavailable plans', async () => {
  username = 'alice'; authMethod = 'jwt';
  const endpoint = '/plans/00000000-0000-4000-8000-000000000000/authorize';
  await request(app).post(endpoint).send({ approved: true }).expect(400);
  mockQuery.mockResolvedValue([]);
  await request(app).post(endpoint).send({ digest: 'a'.repeat(64), idempotencyKey: '00000000-0000-4000-8000-000000000001' }).expect(409);
});

test('operation reads and cancellation bind authenticated owner and conceal missing operations', async () => {
  const endpoint = '/operations/00000000-0000-4000-8000-000000000000';
  await request(app).get(endpoint).expect(401);
  username = 'alice';
  mockQuery.mockResolvedValue([]);
  await request(app).get(endpoint).expect(404);
  await request(app).post(endpoint + '/cancel').send({ owner: 'bob' }).expect(404);
  expect(mockQuery.mock.calls.every(call => call[1][1] === 'alice')).toBe(true);
});

test('cancellation reports active cleanup as pending, never as completed cancellation', async () => {
  username = 'alice';
  mockQuery.mockResolvedValue([{ operation_id: 'fixture', state: 'starting', cancel_requested: true }]);
  const response = await request(app).post('/operations/00000000-0000-4000-8000-000000000000/cancel').expect(200);
  expect(response.body.data).toMatchObject({ state: 'starting', cancel_requested: true });
  expect(JSON.stringify(response.body)).not.toContain('claim_id');
});
