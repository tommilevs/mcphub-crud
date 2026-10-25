jest.mock('openid-client', () => ({}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client as PgClient, Pool } from 'pg';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server as McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { clearSettingsCache, getNameSeparator } from '../../src/config/index.js';
import { JsonFileDaoFactory, setDaoFactory } from '../../src/dao/DaoFactory.js';
import { updateMyCredential } from '../../src/controllers/credentialBindingController.js';
import { auth } from '../../src/middlewares/auth.js';
import {
  sseUserContextMiddleware,
  userContextMiddleware,
} from '../../src/middlewares/userContext.js';
import {
  cleanupAllServers,
  getServerByName,
  initializeClientsFromSettings,
} from '../../src/services/mcpService.js';
import { PrincipalRuntimeService } from '../../src/services/principalRuntimeService.js';
import {
  handleMcpOtherRequest,
  handleMcpPostRequest,
  transports,
} from '../../src/services/sseService.js';
import type { McpSettings } from '../../src/types/index.js';
import { MCP_APPS_CAPABILITIES } from '../../src/utils/mcpApps.js';
import { createUserToken } from '../utils/testHelpers.js';
import { ensureAttributionContextSchema } from '../../src/db/attributionContextSchema.js';
import { createGatewayProof } from '../../src/services/gatewayProvenance.js';
import { ensureToolResultHistorySchema } from '../../src/db/toolResultHistorySchema.js';
import { ToolResultRepositoryDb } from '../../src/db/repositories/ToolResultRepository.js';
import { ToolResultHistoryService } from '../../src/services/toolResultHistoryService.js';
import { getToolResults,getToolResultById,getToolResultRaw,getToolResultRange,pinToolResult,getToolResultChunks,searchToolResultChunks } from '../../src/controllers/toolResultController.js';
import { generateEmbedding } from '../../src/services/vectorSearchService.js';

let mockAttributionDb: {isInitialized?:boolean;query:(sql:string,parameters?:unknown[])=>Promise<any>} | undefined;
jest.mock('../../src/db/connection.js',()=>{
  const actual=jest.requireActual('../../src/db/connection.js');
  return {...actual,getAppDataSource:()=>mockAttributionDb??actual.getAppDataSource()};
});

jest.mock('../../src/services/oauthService.js', () => ({ initializeAllOAuthClients: jest.fn() }));
jest.mock('../../src/services/mcpOAuthProvider.js', () => ({ createOAuthProvider: jest.fn() }));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  generateEmbedding: jest.fn().mockRejectedValue(new Error('Synthetic fixture disables provider calls')),
  removeServerToolEmbeddings: jest.fn(),
  removeToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
  syncAllServerToolsEmbeddings: jest.fn(),
}));
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: jest.fn() }),
}));
jest.mock('../../src/services/toolResultCompressionService.js', () => ({
  maybeCompressToolResult: (result: unknown) => result,
}));
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn(async () => ({ enabled: false })),
}));

const alice = 'alice@example.com';
const bob = 'bob@example.com';
const clients: Client[] = [];
const restCalls: string[] = [];
let app: express.Express;
let server: HttpServer;
let baseUrl: string;
let directory: string;
const originalEnv = {
  MCPHUB_SETTING_PATH: process.env.MCPHUB_SETTING_PATH,
  MCPHUB_CREDENTIAL_ENCRYPTION_KEY: process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY,
  USE_DB: process.env.USE_DB,
};

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-apps-openapi-e2e-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.USE_DB = 'false';
  app = express();
  app.use(express.json());
  app.use('/api', auth, userContextMiddleware);
  app.put('/api/credentials/:name', updateMyCredential);
  app.get('/api/tool-results',getToolResults);
  app.get('/api/tool-results/:id',getToolResultById);
  app.get('/api/tool-results/:id/raw',getToolResultRaw);
  app.get('/api/tool-results/:id/range',getToolResultRange);
  app.patch('/api/tool-results/:id/pin',pinToolResult);
  app.get('/api/tool-results/:id/chunks',getToolResultChunks);
  app.get('/api/tool-results/:id/search',searchToolResultChunks);
  const routes = ['/mcp', '/mcp/:group'];
  app.post(routes, sseUserContextMiddleware, handleMcpPostRequest);
  app.get(routes, sseUserContextMiddleware, handleMcpOtherRequest);
  app.delete(routes, sseUserContextMiddleware, handleMcpOtherRequest);
  app.post('/upstream-mcp', async (req, res) => {
    const upstream = new McpServer(
      { name: 'private-mcp-fixture', version: '1' },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'identity', inputSchema: { type: 'object' } }],
    }));
    upstream.setRequestHandler('tools/call', async () => ({
      content: [
        { type: 'text', text: JSON.stringify({ credential: req.headers['x-personal-key'] }) },
      ],
    }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void upstream.close();
    });
    await upstream.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/upstream-rest', (req, res) => {
    const credential = req.headers['x-personal-key'] as string;
    restCalls.push(credential);
    res.json({ credential, upstream: 'rest' });
  });
  server = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const credentialTemplate = [{ target: 'headers' as const, name: 'X-Personal-Key' }];
  const settings: McpSettings = {
    mcpServers: {
      shared: {
        type: 'streamable-http',
        url: `${baseUrl}/upstream-mcp`,
        owner: 'admin',
        visibility: 'public',
      },
      regular: {
        type: 'streamable-http',
        url: `${baseUrl}/upstream-mcp`,
        owner: alice,
        visibility: 'private',
        credentialTemplate,
      },
      rest: {
        type: 'openapi',
        owner: alice,
        visibility: 'private',
        credentialTemplate,
        openapi: {
          schema: {
            openapi: '3.0.0',
            info: { title: 'Private REST fixture', version: '1' },
            servers: [{ url: baseUrl }],
            paths: {
              '/upstream-rest': {
                get: {
                  operationId: 'identity',
                  parameters: [
                    { name: 'x-personal-key', in: 'header', schema: { type: 'string' } },
                  ],
                  responses: { '200': { description: 'ok' } },
                },
              },
            },
          },
          passthroughHeaders: ['x-personal-key'],
        },
      },
    },
    users: [alice, bob, 'admin'].map((username) => ({
      username,
      password: 'unused',
      isAdmin: username === 'admin',
    })),
    groups: [
      {
        id: 'mixed-group',
        name: 'mixed',
        owner: alice,
        visibility: 'private',
        servers: ['shared', 'regular', 'rest'],
      },
    ],
    bearerKeys: [alice, bob].map((username, index) => ({
      id: `apps-personal-${index}`,
      name: username,
      token: `${username}-bearer`,
      kind: 'user',
      owner: username,
      enabled: true,
      accessType: 'all',
      createdAt: new Date().toISOString(),
    })),
    systemConfig: {
      network: { allowedCidrs: ['127.0.0.1/32'] },
      routing: {
        enableGlobalRoute: true,
        enableGroupNameRoute: true,
        enableBearerAuth: true,
        skipAuth: false,
      },
      oauthServer: { enabled: false },
    },
  };
  fs.writeFileSync(process.env.MCPHUB_SETTING_PATH, JSON.stringify(settings));
  clearSettingsCache();
  JsonFileDaoFactory.getInstance().resetInstances();
  setDaoFactory(JsonFileDaoFactory.getInstance());
  await initializeClientsFromSettings(true);
  for (const name of ['regular', 'rest']) {
    const result = await request(app)
      .put(`/api/credentials/${name}`)
      .set('x-auth-token', createUserToken(alice, false))
      .send({ values: { 'headers.X-Personal-Key': `alice-${name}-credential` } });
    expect(result.status).toBe(200);
  }
  const deadline = Date.now() + 5000;
  while (getServerByName('shared')?.status === 'connecting' && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(getServerByName('shared')?.status).toBe('connected');
});

afterAll(async () => {
  for (const client of clients) await client.close();
  for (const entry of Object.values(transports)) await entry.transport.close();
  cleanupAllServers();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearSettingsCache();
  JsonFileDaoFactory.getInstance().resetInstances();
});

const connect = async (username: string, route = '') => {
  const client = new Client(
    { name: 'apps-openapi-e2e', version: '1' },
    { capabilities: MCP_APPS_CAPABILITIES },
  );
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp${route}`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${username}-bearer`,
          'x-personal-key': 'passthrough-must-not-win',
        },
      },
    }),
  );
  return client;
};

const postgresTest=process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD?test:test.skip;
postgresTest('production MCP auth binds signed adapter evidence to the authenticated bearer owner',async()=>{
  const schema=`mcp_auth_attribution_${randomBytes(12).toString('hex')}`;
  const config={host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST??'127.0.0.1',port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT??5432),
    user:process.env.MCPHUB_ATTRIBUTION_TEST_USER,password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,
    database:process.env.MCPHUB_ATTRIBUTION_TEST_DB??'postgres',connectionTimeoutMillis:5000};
  const admin=new PgClient(config);let pool:Pool|undefined;
  const oldMode=process.env.MCPHUB_ATTRIBUTION_MODE,oldKeys=process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;
  const secret='synthetic-production-route-adapter-key-32-characters';
  const ownedClients:Client[]=[];
  try{
    await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({...config,options:`-c search_path=${schema}`});
    await ensureAttributionContextSchema(pool);
    mockAttributionDb={query:async(sql,parameters)=>(await pool!.query(sql,parameters)).rows};
    process.env.MCPHUB_ATTRIBUTION_MODE='compatible';
    process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=JSON.stringify({routeFixture:secret});
    for(const username of [alice,bob]){
      const client=new Client({name:'attribution-auth-route',version:'1'});
      ownedClients.push(client);
      const transport=new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${username}-bearer`}}});
      const send=transport.send.bind(transport);
      transport.send=async(message,options)=>{
        if('method' in message&&message.method==='tools/call'){
          const params=message.params as any;
          const provider={id:`response-${username}`,model:'synthetic-observed-model',choices:[{message:{tool_calls:[{
            id:'route-tool-call',type:'function',function:{name:params.name,arguments:JSON.stringify(params.arguments)},
          }]}}]};
          // Both adapters claim Alice: only her authenticated key may verify it.
          const proof=createGatewayProof(provider,'route-tool-call',message as any,
            {adapterId:'routeFixture',principal:JSON.stringify([alice,'apps-personal-0']),secret});
          message={...message,params:{...params,_meta:{...params._meta,'dev.mcphub/provenance':proof}}};
        }
        return send(message,options);
      };
      await client.connect(transport);
    }
    const results:any[]=await Promise.all(ownedClients.map(client=>client.callTool({name:`shared${getNameSeparator()}identity`,arguments:{}})));
    expect(results.every(result=>!result.isError)).toBe(true);
    expect(results[0]._meta?.['dev.mcphub/provenance']).toMatchObject({modelId:'synthetic-observed-model',identity_source:'gateway_observed',verified:true,causalCorrelationVerified:true});
    expect(results[1]._meta?.['dev.mcphub/provenance']).toBeUndefined();
    expect((await pool.query("SELECT count(*)::int AS n FROM attribution_gateway_nonces WHERE adapter_id='routeFixture'")).rows[0].n).toBe(1);
  }finally{
    await Promise.all(ownedClients.map(client=>client.close()));
    mockAttributionDb=undefined;
    if(oldMode===undefined)delete process.env.MCPHUB_ATTRIBUTION_MODE;else process.env.MCPHUB_ATTRIBUTION_MODE=oldMode;
    if(oldKeys===undefined)delete process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;else process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=oldKeys;
    if(pool)await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);
    await admin.end();
  }
});

postgresTest('History HTTP returns exact RAW bytes and enforces administrator access on PostgreSQL',async()=>{
  const schema=`history_http_${randomBytes(12).toString('hex')}`;
  const config={host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST??'127.0.0.1',port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT??5432),
    user:process.env.MCPHUB_ATTRIBUTION_TEST_USER,password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,
    database:process.env.MCPHUB_ATTRIBUTION_TEST_DB??'postgres',connectionTimeoutMillis:5000};
  const admin=new PgClient(config);let pool:Pool|undefined;
  try{
    await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({...config,options:`-c search_path=${schema},public`});
    const db={isInitialized:true,query:async(sql:string,parameters?:unknown[])=>(await pool!.query(sql,parameters)).rows};
    await ensureAttributionContextSchema(db);await ensureToolResultHistorySchema(db);
    mockAttributionDb=db;
    const repository=new ToolResultRepositoryDb(db);
    const history=new ToolResultHistoryService(repository);
    const saved=(await history.capture({server:'http-fixture',tool:'read',durationMs:1,status:'success',username:alice,
      result:{content:[{type:'text',text:'immutable 😀\r\nXid 79'}],structuredContent:{counter:'9007199254740993'}}}))!;
    const metadata=(await history.capture({server:'http-fixture',tool:'read',durationMs:1,status:'success',username:alice,
      result:{content:[{type:'text',text:'omitted'}]},capturePayload:false,payloadOmissionReason:'fixture-disabled'}))!;
    await history.capture({server:'http-fixture',tool:'read',durationMs:1,status:'success',username:bob,result:{content:[]}});
    const token=createUserToken('admin',true);
    const url=`/api/tool-results/${saved.resultId}`;
    expect(await repository.hasChunkEmbeddings(saved.resultId)).toBe(false);
    await pool.query('INSERT INTO tool_result_chunks(result_id,chunk_index,chunk_version,content) VALUES($1,0,2,$2)',[saved.resultId,'immutable Xid 79']);
    expect(await repository.hasChunkEmbeddings(saved.resultId)).toBe(false);
    const searched=await request(app).get(`${url}/search`).set('x-auth-token',token).query({q:'Xid 79'}).expect(200);
    expect(searched.body.data).toHaveLength(1);
    expect(searched.body.meta.mode).toBe('lexical');
    expect(generateEmbedding).not.toHaveBeenCalled();
    await pool.query("UPDATE tool_result_chunks SET embedding='[1,0,0]'::vector WHERE result_id=$1",[saved.resultId]);
    expect(await repository.hasChunkEmbeddings(saved.resultId)).toBe(true);
    expect(await repository.hasChunkEmbeddings(metadata.resultId)).toBe(false);
    const chunks=await request(app).get(`${url}/chunks`).set('x-auth-token',token).expect(200);
    expect(chunks.body.data).toHaveLength(1);
    expect(chunks.body.data[0]).toMatchObject({chunkVersion:2,hasEmbedding:true,embeddingDimensions:3});
    await request(app).get(`${url}/raw`).expect(401);
    await request(app).get(`${url}/raw`).set('x-auth-token',createUserToken(alice,false)).expect(403);
    await request(app).patch(`${url}/pin`).set('x-auth-token',createUserToken(alice,false)).send({pinned:true}).expect(403);
    const listed=await request(app).get('/api/tool-results').set('x-auth-token',token).query({username:alice}).expect(200);
    expect(listed.body.pagination.total).toBe(2);
    expect(listed.body.data.every((value:any)=>value.raw===undefined&&value.rawText===undefined)).toBe(true);
    const detail=await request(app).get(url).set('x-auth-token',token).expect(200);
    expect(detail.body.data).toMatchObject({resultId:saved.resultId,rawSha256:saved.rawSha256,payloadAvailable:true});
    expect(detail.body.data.raw).toBeUndefined();
    const raw=await request(app).get(`${url}/raw`).set('x-auth-token',token).expect(200);
    expect(raw.text).toBe(saved.raw);
    const bytes=Buffer.from(saved.raw!,'utf8'),start=bytes.indexOf(Buffer.from('😀'))+1,end=start+2;
    expect(start).toBeGreaterThan(0);
    const range=await request(app).get(`${url}/range`).set('x-auth-token',token).query({start,end}).expect(206);
    expect(range.headers['content-range']).toBe(`bytes ${start}-${end-1}/${bytes.length}`);
    expect(range.body).toEqual(bytes.subarray(start,end));
    await request(app).get(`${url}/range`).set('x-auth-token',token).query({start:0,end:bytes.length+1}).expect(400);
    await request(app).get(`/api/tool-results/${metadata.resultId}/raw`).set('x-auth-token',token).expect(409);
    await request(app).get(`/api/tool-results/${metadata.resultId}/range`).set('x-auth-token',token).query({start:0,end:1}).expect(409);
    const pin=await request(app).patch(`${url}/pin`).set('x-auth-token',token).send({pinned:true}).expect(200);
    expect(pin.body.data.pinned).toBe(true);
    const reopened=await repository.findById(saved.resultId);
    expect(reopened).toMatchObject({raw:saved.raw,rawSha256:saved.rawSha256,pinned:true});
    expect(reopened!.useCount).toBeGreaterThanOrEqual(3);
    await request(app).get('/api/tool-results/00000000-0000-0000-0000-000000000000/raw').set('x-auth-token',token).expect(404);
  }finally{
    mockAttributionDb=undefined;
    if(pool)await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);
    await admin.end();
  }
});

test.each(['', '/mixed'])(
  'Apps clients can call a qualified private OpenAPI tool after listing mixed personal children (%s)',
  async (route) => {
    const client = await connect(alice, route);
    const acquire = jest.spyOn(PrincipalRuntimeService.prototype, 'acquire');
    try {
      const qualifiedName = `rest${getNameSeparator()}identity`;
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual([
        `shared${getNameSeparator()}identity`,
        `regular${getNameSeparator()}identity`,
        qualifiedName,
      ]);
      expect(acquire.mock.calls.map(([name]) => name).sort()).toEqual(['regular', 'rest']);

      // A target-only call has just the OpenAPI child in its request scope. The
      // route must retain the qualified name advertised by the preceding list.
      acquire.mockClear();
      const result = await client.callTool({
        name: qualifiedName,
        arguments: { 'x-personal-key': 'parameter-must-not-win' },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        {
          type: 'text',
          text: expect.stringContaining('alice-rest-credential'),
        },
      ]);
      expect(acquire.mock.calls.map(([name]) => name)).toEqual(['rest']);
      expect(restCalls.at(-1)).toBe('alice-rest-credential');
    } finally {
      acquire.mockRestore();
    }
  },
);

test("Apps capability does not expose or invoke another user's private OpenAPI child", async () => {
  const client = await connect(bob);
  const callsBefore = restCalls.length;
  const acquire = jest.spyOn(PrincipalRuntimeService.prototype, 'acquire');
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['identity']);
    const result = await client.callTool({ name: `rest${getNameSeparator()}identity` });
    expect(result.isError).toBe(true);
    expect(restCalls).toHaveLength(callsBefore);
    expect(acquire).not.toHaveBeenCalled();
  } finally {
    acquire.mockRestore();
  }
});
