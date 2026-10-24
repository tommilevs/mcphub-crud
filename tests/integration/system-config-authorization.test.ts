import express from 'express';
import request from 'supertest';

const mockGetSystemConfig = jest.fn();
const mockGetCachedSystemConfig = jest.fn();

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findByUsername: async (username: string) => ({ username, password: 'unused', isAdmin: false }),
  }),
  getSystemConfigDao: jest.fn(() => ({
    get: mockGetSystemConfig,
  })),
  getBearerKeyDao: jest.fn(() => ({
    findEnabled: jest.fn().mockResolvedValue([]),
  })),
  getOAuthTokenDao: jest.fn(() => ({
    findAll: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: mockGetCachedSystemConfig,
}));

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getBearerKeyDao: jest.fn(),
  getGroupDao: jest.fn(),
  getOAuthClientDao: jest.fn(),
  getOAuthTokenDao: jest.fn(),
  getServerDao: jest.fn(),
  getSystemConfigDao: jest.fn(),
  getUserConfigDao: jest.fn(),
  getUserDao: jest.fn(),
}));

jest.mock('../../src/services/oauthServerService.js', () => ({
  isOAuthServerEnabled: jest.fn(() => false),
}));

jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn().mockResolvedValue({ enabled: false }),
}));

jest.mock('../../src/services/mcpService.js', () => ({
  getServersInfo: jest.fn(),
  addServer: jest.fn(),
  addOrUpdateServer: jest.fn(),
  removeServer: jest.fn(),
  getServerByName: jest.fn(),
  notifyToolChanged: jest.fn(),
  broadcastToolListChanged: jest.fn(),
  broadcastPromptListChanged: jest.fn(),
  broadcastResourceListChanged: jest.fn(),
  syncToolEmbedding: jest.fn(),
  toggleServerStatus: jest.fn(),
  reconnectServer: jest.fn(),
  reinstallServer: jest.fn(),
  updateServerInfoVisibility: jest.fn(),
}));

jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  syncAllServerToolsEmbeddings: jest.fn(),
}));

jest.mock('../../src/services/upstreamOAuthDisconnectService.js', () => ({
  disconnectUpstreamOAuth: jest.fn(),
}));

jest.mock('../../src/services/logService.js', () => ({
  __esModule: true,
  default: {
    getLogs: jest.fn(),
    clearLogs: jest.fn(),
    subscribeToStream: jest.fn(),
  },
}));

import logService from '../../src/services/logService.js';
import { auth } from '../../src/middlewares/auth.js';
import { authenticatedRouteRateLimiter } from '../../src/utils/rateLimit.js';
import { updateSystemConfig } from '../../src/controllers/serverController.js';
import { getActivities } from '../../src/controllers/activityController.js';
import { clearLogs, getAllLogs, streamLogs } from '../../src/controllers/logController.js';
import { createUserToken } from '../utils/testHelpers.js';

describe('system configuration authorization', () => {
  beforeEach(() => {
    mockGetCachedSystemConfig.mockReturnValue(null);
    mockGetSystemConfig.mockResolvedValue({
      routing: {
        enableGlobalRoute: true,
        enableGroupNameRoute: true,
        enableBearerAuth: false,
        skipAuth: false,
      },
    });
  });

  it('rejects anonymous requests after another instance disables skipAuth', async () => {
    const staleConfig = { routing: { skipAuth: true, enableBearerAuth: false } };
    mockGetCachedSystemConfig.mockReturnValue(staleConfig);
    mockGetSystemConfig.mockResolvedValueOnce(staleConfig);
    const app = express();
    app.get('/api/protected', authenticatedRouteRateLimiter, auth, (_req, res) =>
      res.sendStatus(200),
    );

    expect((await request(app).get('/api/protected')).status).toBe(200);
    // The database now requires authentication, while this instance's cache is stale.
    expect((await request(app).get('/api/protected')).status).toBe(401);
  });

  it('rejects a non-admin JWT before updating global configuration', async () => {
    const app = express();
    app.use(express.json());
    app.put('/api/system-config', authenticatedRouteRateLimiter, auth, updateSystemConfig);

    const response = await request(app)
      .put('/api/system-config')
      .set('x-auth-token', createUserToken('regular-user', false))
      .send({
        routing: {
          skipAuth: true,
        },
        network: { allowedCidrs: ['0.0.0.0/0'] },
      });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      message: 'Admin privileges required',
    });
  });

  it('rejects a non-admin JWT on activity and system log routes', async () => {
    const app = express();
    app.use(express.json());
    app.get('/api/activities', authenticatedRouteRateLimiter, auth, getActivities);
    app.get('/api/logs', authenticatedRouteRateLimiter, auth, getAllLogs);
    app.delete('/api/logs', authenticatedRouteRateLimiter, auth, clearLogs);
    app.get('/api/logs/stream', authenticatedRouteRateLimiter, auth, streamLogs);

    const token = createUserToken('regular-user', false);
    const responses = [
      await request(app).get('/api/activities').set('x-auth-token', token),
      await request(app).get('/api/logs').set('x-auth-token', token),
      await request(app).delete('/api/logs').set('x-auth-token', token),
      await request(app).get('/api/logs/stream').set('x-auth-token', token),
    ];

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        success: false,
        message: 'Admin privileges required',
      });
    }
  });
  it('streams initial and live log events over HTTP with skipAuth and rejects tokenless access after it is disabled', async () => {
    mockGetSystemConfig.mockResolvedValue({routing:{skipAuth:true,enableBearerAuth:false}});
    jest.mocked(logService.getLogs).mockReturnValue([]);
    let emit!: Parameters<typeof logService.subscribeToStream>[0];
    const unsubscribe=jest.fn();
    jest.mocked(logService.subscribeToStream).mockImplementation(callback=>{emit=callback;return unsubscribe;});
    const app=express();app.get('/api/logs/stream',auth,streamLogs);
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const port=(server.address() as {port:number}).port;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),4000);
    try {
      const response=await fetch(`http://127.0.0.1:${port}/api/logs/stream`,{signal:controller.signal});
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader=response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"initial"');
      emit({type:'log',log:{timestamp:1,type:'info',source:'fixture',message:'live-stream-marker'}});
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('live-stream-marker');
      await reader.cancel();controller.abort();
      await new Promise(resolve=>setImmediate(resolve));
      mockGetSystemConfig.mockResolvedValue({routing:{skipAuth:false,enableBearerAuth:false}});
      const denied=await fetch(`http://127.0.0.1:${port}/api/logs/stream`,{signal:AbortSignal.timeout(3000)});
      expect(denied.status).toBe(401);
      await denied.text();
    } finally {
      clearTimeout(timeout);controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

});
