import express from 'express';
import request from 'supertest';
import { proposeMcpAcquisition, createMcpAcquisitionPlan, getMcpAcquisitionPlan, authorizeMcpAcquisitionPlan,
  getMcpAcquisitionOperation, cancelMcpAcquisitionOperation } from '../../src/controllers/mcpAcquisitionController.js';
import { loadSettings } from '../../src/config/configManager.js';
import { getMarketServers } from '../../src/services/marketService.js';
import { requireAdminMiddleware } from '../../src/utils/requireAdmin.js';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));

jest.mock('../../src/config/configManager.js', () => ({ loadSettings: jest.fn() }));
jest.mock('../../src/services/marketService.js', () => ({ getMarketServers: jest.fn() }));

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
beforeEach(() => { jest.resetAllMocks(); username = undefined; authMethod = undefined; });

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
  const response = await request(app).post('/plans').send({ serverName: 'fixture', version: '1.0.0', targetGroup: 'group', owner: 'bob', approved: true }).expect(201);
  expect(mockQuery.mock.calls[0][1][1]).toBe('alice');
  expect(response.body.data).toMatchObject({ status: 'proposed', verification: 'catalog_only', manifest: { package: { version: '1.0.0' } } });
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
