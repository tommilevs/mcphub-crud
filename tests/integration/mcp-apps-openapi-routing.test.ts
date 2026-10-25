jest.mock('openid-client', () => ({}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes,randomUUID,createHash } from 'node:crypto';
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
import { getToolResults,getToolResultById,getToolResultRaw,getToolResultRange,pinToolResult,getToolResultChunks,searchToolResultChunks,compareToolResults,getToolResultStats,getToolResultTimeline,getToolResultConversationTimeline,getToolResultLineage } from '../../src/controllers/toolResultController.js';
import { generateEmbedding } from '../../src/services/vectorSearchService.js';
import { previewDataset,exportDataset } from '../../src/controllers/datasetController.js';
import { saveTaskReview } from '../../src/controllers/taskReviewController.js';
import { saveToolResultReview } from '../../src/controllers/toolResultReviewController.js';

let mockAttributionDb: {isInitialized?:boolean;query:(sql:string,parameters?:unknown[])=>Promise<any>;transaction?:(work:(db:any)=>Promise<any>)=>Promise<any>} | undefined;
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
  app.get('/api/tool-results/stats',getToolResultStats);
  app.post('/api/tool-results/compare',compareToolResults);
  app.get('/api/tool-results/timeline/:sessionId',getToolResultTimeline);
  app.get('/api/tool-results/conversation-timeline/:conversationId',getToolResultConversationTimeline);
  app.get('/api/tool-results/:id/lineage',getToolResultLineage);
  app.get('/api/tool-results/:id',getToolResultById);
  app.get('/api/tool-results/:id/raw',getToolResultRaw);
  app.get('/api/tool-results/:id/range',getToolResultRange);
  app.patch('/api/tool-results/:id/pin',pinToolResult);
  app.get('/api/tool-results/:id/chunks',getToolResultChunks);
  app.get('/api/tool-results/:id/search',searchToolResultChunks);
  app.put('/api/tool-results/:id/review',saveToolResultReview);
  app.put('/api/attribution/tasks/:taskId/review',saveTaskReview);
  app.post('/api/datasets/preview',previewDataset);
  app.post('/api/datasets/export',exportDataset);
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
    const saved=(await history.capture({server:'http-fixture',tool:'read',durationMs:1,status:'success',username:alice,sessionId:'http-session',conversationId:'http-conversation',
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
    const duplicate=(await history.capture({server:'http-fixture',tool:'read',durationMs:1,status:'success',username:alice,
      sessionId:'http-session',conversationId:'http-conversation',parentResultId:saved.resultId,result:JSON.parse(saved.raw!)}))!;
    const comparison=await request(app).post('/api/tool-results/compare').set('x-auth-token',token).send({resultIds:[saved.resultId,duplicate.resultId]}).expect(200);
    expect(comparison.body.data).toMatchObject({sameRaw:true,totalBytes:saved.rawBytes*2});
    expect(comparison.body.data.results.every((value:any)=>value.raw===undefined&&value.rawText===undefined)).toBe(true);
    const omittedComparison=await request(app).post('/api/tool-results/compare').set('x-auth-token',token).send({resultIds:[saved.resultId,metadata.resultId]}).expect(200);
    expect(omittedComparison.body.data.sameRaw).toBe(false);
    await request(app).post('/api/tool-results/compare').set('x-auth-token',token).send({resultIds:[saved.resultId]}).expect(400);
    await request(app).post('/api/tool-results/compare').set('x-auth-token',createUserToken(alice,false)).send({resultIds:[saved.resultId,duplicate.resultId]}).expect(403);
    const stats=await request(app).get('/api/tool-results/stats').set('x-auth-token',token).query({username:alice}).expect(200);
    expect(stats.body.data).toMatchObject({total:3,pinned:1,payloadAvailable:2,totalRawBytes:saved.rawBytes*2});
    expect(stats.body.data.retrieval.searches).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.retrieval.lexicalFallbacks).toBeGreaterThanOrEqual(1);
    await request(app).get('/api/tool-results/stats').set('x-auth-token',createUserToken(alice,false)).expect(403);
    for(const timelineUrl of ['/api/tool-results/timeline/http-session','/api/tool-results/conversation-timeline/http-conversation']){
      const timeline=await request(app).get(timelineUrl).set('x-auth-token',token).expect(200);
      expect(timeline.body.data.map((value:any)=>value.resultId).sort()).toEqual([saved.resultId,duplicate.resultId].sort());
      expect(timeline.body.data.every((value:any)=>value.raw===undefined)).toBe(true);
    }
    const lineage=await request(app).get(`/api/tool-results/${duplicate.resultId}/lineage`).set('x-auth-token',token).expect(200);
    expect(lineage.body.data.ancestors.map((value:any)=>value.resultId)).toEqual([saved.resultId]);
    expect(lineage.body.data.ancestors[0].raw).toBeUndefined();
    await request(app).get('/api/tool-results/00000000-0000-0000-0000-000000000000/raw').set('x-auth-token',token).expect(404);
  }finally{
    mockAttributionDb=undefined;
    if(pool)await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);
    await admin.end();
  }
});

postgresTest('Dataset HTTP export honors current review, consent and authenticated owner',async()=>{
  const schema=`dataset_http_${randomBytes(12).toString('hex')}`;
  const config={host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST??'127.0.0.1',port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT??5432),
    user:process.env.MCPHUB_ATTRIBUTION_TEST_USER,password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,
    database:process.env.MCPHUB_ATTRIBUTION_TEST_DB??'postgres',connectionTimeoutMillis:5000};
  const admin=new PgClient(config);let pool:Pool|undefined;
  const oldFlag=process.env.MCPHUB_DATASET_BUILDER_ENABLED;
  try{
    await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({...config,options:`-c search_path=${schema},public`});
    const db={query:async(sql:string,parameters?:unknown[])=>(await pool!.query(sql,parameters)).rows,
      transaction:async(work:(manager:any)=>Promise<any>)=>{
        const client=await pool!.connect();
        try{await client.query('BEGIN');const result=await work({query:async(sql:string,parameters?:unknown[])=>(await client.query(sql,parameters)).rows});await client.query('COMMIT');return result;}
        catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      }};
    await ensureAttributionContextSchema(db);await ensureToolResultHistorySchema(db);mockAttributionDb=db;
    process.env.MCPHUB_DATASET_BUILDER_ENABLED='true';
    const id=randomUUID(),foreignId=randomUUID(),taskId=randomUUID(),raw='{"content":[{"type":"text","text":"private-fixture-raw"}]}';
    const digest=createHash('sha256').update(raw).digest('hex');
    const attribution={taskId,traceId:randomUUID(),branchId:randomUUID(),modelSegmentId:randomUUID(),invokedToolName:'demo-read',
      identity:{modelId:'synthetic-observed',source:'gateway_observed',verified:true},provenance:{causalCorrelationVerified:true}};
    await pool.query(`INSERT INTO tool_results(result_id,username,status,raw,raw_sha256,objective,arguments,attribution)
      VALUES($1,'admin','success',$2,$3,'read a record','{}',$4),($5,$6,'success',$2,$3,'read a record','{}',$4)`,
      [id,raw,digest,JSON.stringify(attribution),foreignId,alice]);
    await pool.query(`INSERT INTO tool_result_training_contexts(result_id,revision,discovery_call_id,objective,tool_catalogue,privacy_approved,reviewed_by)
      VALUES($1,1,$2,'read a record',$3,true,'fixture-reviewer')`,[id,randomUUID(),JSON.stringify([{name:'demo-read',inputSchema:{type:'object'}}])]);
    const token=createUserToken('admin',true),selection={resultIds:[id,foreignId]};
    const preview=()=>request(app).post('/api/datasets/preview').set('x-auth-token',token).send(selection);
    await request(app).post('/api/datasets/preview').send(selection).expect(401);
    await request(app).post('/api/datasets/preview').set('x-auth-token',createUserToken(alice,false)).send(selection).expect(403);
    expect((await preview().expect(200)).body.data.exported).toBe(0);
    const taskReview=(revision:number,trainingConsent:boolean)=>request(app).put(`/api/attribution/tasks/${taskId}/review`).set('x-auth-token',token).send({revision,outcome:'success',trainingConsent});
    await taskReview(0,true).expect(200);
    expect((await preview().expect(200)).body.data.exported).toBe(0);
    const resultReview=(revision:number,privacy:string,rawSha256=digest)=>request(app).put(`/api/tool-results/${id}/review`).set('x-auth-token',token).send({revision,privacy,quality:'correct',rawSha256});
    await resultReview(0,'approved','0'.repeat(64)).expect(409);
    await resultReview(0,'approved').expect(200);
    const ready=await preview().expect(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.body.data.exported).toBe(1);
    expect(ready.body.data.excluded.unavailable_or_out_of_scope).toBe(1);
    const split=Object.keys(ready.body.data.splits).find(key=>ready.body.data.splits[key]===1)!;
    const exported=await request(app).post('/api/datasets/export').set('x-auth-token',token).send({...selection,split}).expect(200);
    expect(JSON.parse(exported.text).metadata).toMatchObject({resultId:id,identityTrust:'trusted',split});
    expect(exported.text).not.toContain('private-fixture-raw');
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.headers['x-dataset-file-digest']).toBe(createHash('sha256').update(exported.text).digest('hex'));
    expect(exported.headers['x-dataset-export-id']).toBeTruthy();
    await resultReview(1,'rejected').expect(200);
    expect((await preview().expect(200)).body.data.exported).toBe(0);
    await resultReview(2,'approved').expect(200);
    expect((await preview().expect(200)).body.data.exported).toBe(1);
    await taskReview(1,false).expect(200);
    await taskReview(0,true).expect(409);
    expect((await preview().expect(200)).body.data.exported).toBe(0);
    const revoked=await request(app).post('/api/datasets/export').set('x-auth-token',token).send({...selection,split}).expect(200);
    expect(revoked.text).toBe('');
    expect((await pool.query('SELECT raw,raw_sha256 FROM tool_results WHERE result_id=$1',[id])).rows[0]).toMatchObject({raw,raw_sha256:digest});
  }finally{
    mockAttributionDb=undefined;
    if(oldFlag===undefined)delete process.env.MCPHUB_DATASET_BUILDER_ENABLED;else process.env.MCPHUB_DATASET_BUILDER_ENABLED=oldFlag;
    if(pool)await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);await admin.end();
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
