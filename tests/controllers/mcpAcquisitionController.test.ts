import express from 'express';
import request from 'supertest';
import { proposeMcpAcquisition } from '../../src/controllers/mcpAcquisitionController.js';
import { loadSettings } from '../../src/config/configManager.js';
import { getMarketServers } from '../../src/services/marketService.js';
import { requireAdminMiddleware } from '../../src/utils/requireAdmin.js';

jest.mock('../../src/config/configManager.js', () => ({ loadSettings: jest.fn() }));
jest.mock('../../src/services/marketService.js', () => ({ getMarketServers: jest.fn() }));

const app = express();
app.use(express.json());
app.post('/proposals', proposeMcpAcquisition);
beforeEach(() => jest.resetAllMocks());

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
