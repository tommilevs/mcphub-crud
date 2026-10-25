import express from 'express';
import request from 'supertest';
import { proposeMcpAcquisition, createMcpAcquisitionPlan, getMcpAcquisitionPlan } from '../../src/controllers/mcpAcquisitionController.js';
import { loadSettings } from '../../src/config/configManager.js';
import { getMarketServers } from '../../src/services/marketService.js';
import { requireAdminMiddleware } from '../../src/utils/requireAdmin.js';
const mockQuery = jest.fn();
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => ({ query: mockQuery }) }));

jest.mock('../../src/config/configManager.js', () => ({ loadSettings: jest.fn() }));
jest.mock('../../src/services/marketService.js', () => ({ getMarketServers: jest.fn() }));

const app = express();
let username: string | undefined;
app.use(express.json());
app.use((req, _res, next) => { (req as any).user = username ? { username, isAdmin: true } : undefined; next(); });
app.post('/proposals', proposeMcpAcquisition);
app.post('/plans', createMcpAcquisitionPlan);
app.get('/plans/:id', getMcpAcquisitionPlan);
beforeEach(() => { jest.resetAllMocks(); username = undefined; });

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
