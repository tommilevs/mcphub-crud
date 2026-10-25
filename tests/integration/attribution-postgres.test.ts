import { randomUUID,createHash } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ensureAttributionContextSchema } from '../../src/db/attributionContextSchema.js';
import { AttributionContextRepository } from '../../src/db/repositories/AttributionContextRepository.js';
import { AttributionContextService } from '../../src/services/attributionContextService.js';
import type { Request, Response } from 'express';
import express from 'express';
import { Client as McpClient, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server as McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
let mockSummaryDb: { query: (sql: string, parameters?: unknown[]) => Promise<any>;transaction?:(work:(db:any)=>Promise<any>)=>Promise<any> };
jest.mock('../../src/db/connection.js', () => ({ getAppDataSource: () => mockSummaryDb }));
import { getAttributionSummary } from '../../src/controllers/attributionController.js';
import { saveTaskReview } from '../../src/controllers/taskReviewController.js';
import { saveToolResultReview } from '../../src/controllers/toolResultReviewController.js';
import { ensureToolResultReviewSchema } from '../../src/db/toolResultReviewSchema.js';
import { createGatewayProof } from '../../src/services/gatewayProvenance.js';
import { runWithAttribution } from '../../src/services/attributionRuntime.js';
import { getCallAttribution } from '../../src/services/callAttribution.js';
import { RequestContextService } from '../../src/services/requestContextService.js';
import { saveTrainingContext, getTrainingContext } from '../../src/controllers/trainingContextController.js';
import { extractDiscoveryEvidence } from '../../src/services/discoveryEvidence.js';
import { previewDataset,exportDataset } from '../../src/controllers/datasetController.js';
import {ensureExperienceSchema} from '../../src/db/experienceSchema.js';
import {createExperience,searchExperiences,listExperienceEntries} from '../../src/services/experienceMemory.js';
import {reviewExperience,readExperience} from '../../src/controllers/experienceController.js';
import {getExperienceAdvice} from '../../src/services/experienceAdvice.js';
import {previewSkillFromExperience} from '../../src/services/skillProposalService.js';
import {ensureSkillProposalSchema} from '../../src/db/skillProposalSchema.js';
import {ensureDatasetExportSchema} from '../../src/db/datasetExportSchema.js';
import {ensureDatasetPreferenceSchema} from '../../src/db/datasetPreferenceSchema.js';
import {createPreference,reviewPreference} from '../../src/services/datasetPreference.js';
import {createSkillProposal,reviseSkillProposal,exportSkillProposal,listSkillProposals,readSkillVersions} from '../../src/services/storedSkillProposals.js';
import { ToolResultRepositoryDb } from '../../src/db/repositories/ToolResultRepository.js';
import { observeLoopGuard } from '../../src/services/loopGuardCoordinator.js';
import { ensureLoopGuardFeedbackSchema } from '../../src/db/loopGuardFeedbackSchema.js';
import { submitLoopGuardFeedback, getLoopGuardSummary } from '../../src/controllers/loopGuardFeedbackController.js';

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
    mockSummaryDb.transaction=async work=>{
      const client=await pool.connect();
      try{await client.query('BEGIN');const value=await work({query:async(sql:string,args:any[]) => (await client.query(sql,args)).rows});
        await client.query('COMMIT');return value;
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
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
  test('durable gateway nonce has exactly one winner across concurrent requests', async () => {
    const repo = new AttributionContextRepository(mockSummaryDb);
    const nonce = randomUUID();
    expect((await Promise.all([repo.consumeGatewayNonce('gateway',nonce,new Date(Date.now()+60000)),
      repo.consumeGatewayNonce('gateway',nonce,new Date(Date.now()+60000))])).sort()).toEqual([false,true]);
  });
  test('runtime verifies gateway proof per call without upgrading unsigned continuation', async () => {
    const oldMode=process.env.MCPHUB_ATTRIBUTION_MODE, oldKeys=process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;
    const secret='integration-only-gateway-key-32-characters';
    process.env.MCPHUB_ATTRIBUTION_MODE='compatible';
    process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=JSON.stringify({integration:secret});
    const request={id:19,params:{name:'call_tool',arguments:{toolName:'demo',hub_context:{action:'start',model_claim:'observed'}},_meta:{} as any}};
    const provider={id:'response-integration',model:'observed',choices:[{message:{tool_calls:[{id:'tool-call-integration',type:'function',
      function:{name:'call_tool',arguments:JSON.stringify(request.params.arguments)}}]}}]};
    request.params._meta['dev.mcphub/provenance']=createGatewayProof(provider,'tool-call-integration',request,
      {adapterId:'integration',principal:JSON.stringify(['gateway-user',null]),secret});
    try {
      await RequestContextService.getInstance().runWithCustomRequestContext({headers:{},username:'gateway-user'},async()=>{
        let verifiedCallId: string | undefined;
        const result=await runWithAttribution({params:request.params},async(cleaned)=>{
          expect(cleaned.params._meta['dev.mcphub/provenance']).toBeUndefined();
          expect(getCallAttribution()?.identity).toMatchObject({source:'gateway_observed',verified:true,modelId:'observed'});
          expect(getCallAttribution()?.invokedToolName).toBe('demo');
          verifiedCallId=getCallAttribution()?.callId; return {content:[]};
        },request.id);
        expect(result._meta['dev.mcphub/provenance'].causalCorrelationVerified).toBe(true);
        const key=result._meta['dev.mcphub/context'].trace_key;
        await runWithAttribution({params:{name:'call_tool',arguments:{toolName:'demo',hub_context:{trace_key:key}}}},async()=>{
          expect(getCallAttribution()?.identity).toMatchObject({source:'self_reported',verified:false});
          expect(getCallAttribution()?.callId).not.toBe(verifiedCallId); return {};
        });
        await runWithAttribution(request,async()=>{
          expect(getCallAttribution()?.identity.verified).toBe(false); return {};
        });
      });
    } finally {
      if(oldMode===undefined)delete process.env.MCPHUB_ATTRIBUTION_MODE;else process.env.MCPHUB_ATTRIBUTION_MODE=oldMode;
      if(oldKeys===undefined)delete process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;else process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=oldKeys;
    }
  });
  test('isolates concurrent loopback HTTP clients and consumes signed replay proof once', async () => {
    const oldMode=process.env.MCPHUB_ATTRIBUTION_MODE,oldKeys=process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;
    const secret='synthetic-http-adapter-key-at-least-32-characters';
    process.env.MCPHUB_ATTRIBUTION_MODE='compatible';
    process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=JSON.stringify({httpFixture:secret});
    // Fixture authentication assigns trusted identities. Request payload claims
    // never choose the owner. This tests HTTP/runtime/PG, not production auth.
    const identities:Record<string,{username:string;keyId:string}>={
      'fixture-a':{username:'http-alice',keyId:'key-a'},
      'fixture-b':{username:'http-alice',keyId:'key-b'},
      'fixture-c':{username:'http-bob',keyId:'key-c'},
    };
    const app=express();app.use(express.json());
    app.post('/invoke',async(req,res)=>{
      const owner=identities[req.headers.authorization?.replace(/^Bearer /,'')??''];
      if(!owner){res.sendStatus(401);return;}
      try{
        const response=await RequestContextService.getInstance().runWithCustomRequestContext({headers:{},...owner,remoteAddress:req.socket.remoteAddress},()=>
          runWithAttribution({params:req.body.params},async(cleaned)=>{
            const before=getCallAttribution();
            await new Promise(resolve=>setTimeout(resolve,req.body.id%3*5));
            return {before,after:getCallAttribution(),forwarded:cleaned.params.arguments};
          },req.body.id));
        res.json(response);
      }catch{res.sendStatus(500);}
    });
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();
      if(!address||typeof address==='string')throw new Error('HTTP fixture did not bind');
      const base=`http://127.0.0.1:${address.port}`;
      const invoke=async(token:string,request:any)=>{
        const response=await fetch(`${base}/invoke`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(request)});
        expect(response.status).toBe(200);return response.json();
      };
      const request=(id:number,hub_context:any)=>({id,params:{name:'call_tool',arguments:{toolName:'demo',hub_context}}});
      const starts=await Promise.all(['fixture-a','fixture-a','fixture-b','fixture-c'].map((token,index)=>
        invoke(token,request(index+1,{action:'start',model_claim:'shared-model',client_name_claim:index%2?'Codex':'other-client',task_hint:`task-${index}`}))));
      expect(new Set(starts.map(value=>value.before.taskId)).size).toBe(4);
      expect(new Set(starts.map(value=>value.before.callId)).size).toBe(4);
      for(const result of starts){
        expect(result.before).toEqual(result.after);
        expect(result.before.identity).toMatchObject({modelId:'shared-model',source:'self_reported',verified:false});
        expect(result.forwarded).toEqual({toolName:'demo'});
      }
      const key=starts[0]._meta['dev.mcphub/context'].trace_key;
      const continued=await Promise.all([invoke('fixture-a',request(11,{trace_key:key})),invoke('fixture-a',request(12,{trace_key:key}))]);
      expect(continued.map(value=>value.before.contextId)).toEqual([starts[0].before.contextId,starts[0].before.contextId]);
      expect(continued[0].before.callId).not.toBe(continued[1].before.callId);
      const foreign=await Promise.all(['fixture-b','fixture-c'].map(token=>invoke(token,request(13,{trace_key:key}))));
      expect(foreign.every(value=>value.before.contextId===null&&value.before.identity.source==='unknown')).toBe(true);
      const forked=await invoke('fixture-a',request(14,{action:'fork',trace_key:key}));
      expect(forked.before.traceId).toBe(starts[0].before.traceId);
      expect(forked.before.taskId).toBe(starts[0].before.taskId);
      expect(forked.before.branchId).not.toBe(starts[0].before.branchId);

      const signed:any=request(21,{action:'start',model_claim:'shared-model'});
      const provider={id:'http-response',model:'shared-model',choices:[{message:{tool_calls:[{id:'http-tool-call',type:'function',function:{name:'call_tool',arguments:JSON.stringify(signed.params.arguments)}}]}}]};
      signed.params._meta={'dev.mcphub/provenance':createGatewayProof(provider,'http-tool-call',signed,
        {adapterId:'httpFixture',principal:JSON.stringify(['http-alice','key-a']),secret})};
      const replayed=await Promise.all([invoke('fixture-a',signed),invoke('fixture-a',signed)]);
      expect(replayed.filter(value=>value.before.identity.verified)).toHaveLength(1);
      const winner=replayed.find(value=>value.before.identity.verified)!;
      expect(winner.before.identity.source).toBe('gateway_observed');
      expect(winner.before).toEqual(winner.after);
      const unsigned=await invoke('fixture-a',request(22,{trace_key:winner._meta['dev.mcphub/context'].trace_key}));
      expect(unsigned.before.identity).toMatchObject({source:'self_reported',verified:false});
    }finally{
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      if(oldMode===undefined)delete process.env.MCPHUB_ATTRIBUTION_MODE;else process.env.MCPHUB_ATTRIBUTION_MODE=oldMode;
      if(oldKeys===undefined)delete process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;else process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=oldKeys;
    }
  });

  test('preserves attribution and signed invocation IDs through SDK Streamable HTTP', async () => {
    const oldMode=process.env.MCPHUB_ATTRIBUTION_MODE,oldKeys=process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;
    const secret='synthetic-sdk-http-adapter-key-at-least-32-characters';
    process.env.MCPHUB_ATTRIBUTION_MODE='compatible';
    process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=JSON.stringify({sdkHttp:secret});
    const app=express();app.use(express.json());
    const clients:McpClient[]=[];
    app.post('/mcp',async(req,res)=>{
      const keyId=req.headers.authorization==='Bearer fixture-sdk-a'?'sdk-a':req.headers.authorization==='Bearer fixture-sdk-b'?'sdk-b':undefined;
      if(!keyId){res.sendStatus(401);return;}
      const mcp=new McpServer({name:'attribution-sdk-fixture',version:'1'},{capabilities:{tools:{}}});
      const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined});
      res.on('close',()=>{void transport.close();void mcp.close();});
      mcp.setRequestHandler('tools/call',async(request,extra)=>
        RequestContextService.getInstance().runWithCustomRequestContext({headers:{},username:'sdk-user',keyId},()=>
          runWithAttribution(request,async(cleaned)=>{
            const before=getCallAttribution();
            await new Promise(resolve=>setTimeout(resolve,5));
            return {content:[{type:'text' as const,text:JSON.stringify({before,after:getCallAttribution(),forwarded:cleaned.params.arguments})}]};
          },extra?.mcpReq?.id??extra?.requestId)));
      try{await mcp.connect(transport);await transport.handleRequest(req,res,req.body);}
      catch{if(!res.headersSent)res.sendStatus(500);}
    });
    const server=app.listen(0,'127.0.0.1');
    try{
      await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
      const address=server.address();if(!address||typeof address==='string')throw new Error('SDK fixture did not bind');
      let signNext=false;
      const transports=['a','b'].map(suffix=>new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{authorization:`Bearer fixture-sdk-${suffix}`}}}));
      const send=transports[0].send.bind(transports[0]);
      transports[0].send=async(message,options)=>{
        if(signNext&&'method' in message&&message.method==='tools/call'){
          signNext=false;
          const provider={id:'sdk-http-response',model:'sdk-observed',choices:[{message:{tool_calls:[{id:'sdk-http-call',type:'function',function:{name:(message.params as any).name,arguments:JSON.stringify((message.params as any).arguments)}}]}}]};
          const proof=createGatewayProof(provider,'sdk-http-call',message as any,{adapterId:'sdkHttp',principal:JSON.stringify(['sdk-user','sdk-a']),secret});
          message={...message,params:{...message.params,_meta:{...(message.params as any)?._meta,'dev.mcphub/provenance':proof}}};
        }
        return send(message,options);
      };
      for(let i=0;i<2;i++)clients.push(new McpClient({name:`sdk-client-${i}`,version:'1'}));
      await Promise.all(clients.map((client,index)=>client.connect(transports[index])));
      const call=async(index:number,hub_context:any)=>{
        const result:any=await clients[index].callTool({name:'call_tool',arguments:{toolName:'demo',hub_context}});
        expect(result.isError).not.toBe(true);
        return {...JSON.parse(result.content[0].text),meta:result._meta};
      };
      const started=await Promise.all([call(0,{action:'start',model_claim:'shared-model'}),call(1,{action:'start',model_claim:'shared-model'})]);
      expect(started[0].before.taskId).not.toBe(started[1].before.taskId);
      expect(started[0].before.callId).not.toBe(started[1].before.callId);
      for(const result of started){expect(result.before).toEqual(result.after);expect(result.forwarded).toEqual({toolName:'demo'});}
      const key=started[0].meta['dev.mcphub/context'].trace_key;
      const foreign=await call(1,{trace_key:key});expect(foreign.before.contextId).toBeNull();
      const own=await call(0,{trace_key:key});expect(own.before.contextId).toBe(started[0].before.contextId);
      signNext=true;
      const signed=await call(0,{action:'start',model_claim:'sdk-observed'});
      expect(signed.before.identity).toMatchObject({source:'gateway_observed',verified:true,modelId:'sdk-observed'});
      expect(signed.before).toEqual(signed.after);
      expect(signed.meta['dev.mcphub/provenance'].causalCorrelationVerified).toBe(true);
      const unsigned=await call(0,{trace_key:signed.meta['dev.mcphub/context'].trace_key});
      expect(unsigned.before.identity).toMatchObject({source:'self_reported',verified:false});
    }finally{
      await Promise.all(clients.map(client=>client.close()));
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      if(oldMode===undefined)delete process.env.MCPHUB_ATTRIBUTION_MODE;else process.env.MCPHUB_ATTRIBUTION_MODE=oldMode;
      if(oldKeys===undefined)delete process.env.MCPHUB_GATEWAY_ADAPTER_KEYS;else process.env.MCPHUB_GATEWAY_ADAPTER_KEYS=oldKeys;
    }
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
    await pool.query(`ALTER TABLE tool_results ADD COLUMN result_id uuid UNIQUE;
      ALTER TABLE tool_results ADD COLUMN raw text;
      CREATE TABLE tool_result_state (result_id uuid PRIMARY KEY, pinned boolean DEFAULT false,
        use_count integer DEFAULT 0, last_referenced_at timestamptz, loop_guard_advice jsonb, loop_guard_feedback jsonb)`);
    await pool.query('INSERT INTO tool_results (result_id, status, attribution, raw) VALUES ($1,$2,$3,$4)',
      [resultId, 'success', JSON.stringify({ taskId: task.taskId }), raw]);
    await pool.query('INSERT INTO tool_result_state (result_id) VALUES ($1)', [resultId]);
    await pool.query(`INSERT INTO attribution_task_reviews (task_id, revision, outcome, training_consent, reviewed_by)
      VALUES ($1,1,'success',true,'reviewer'),($1,2,'partial',false,'reviewer')`, [task.taskId]);
    await ensureToolResultReviewSchema(pool);
    await ensureToolResultReviewSchema(pool);
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
  test('LoopGuard feedback appends observations and preserves original result data', async () => {
    await ensureLoopGuardFeedbackSchema(pool);
    const resultId = (await pool.query('SELECT result_id FROM tool_result_state WHERE loop_guard_advice IS NOT NULL LIMIT 1')).rows[0].result_id;
    const before = (await pool.query('SELECT raw FROM tool_results WHERE result_id=$1', [resultId])).rows[0].raw;
    for (const verdict of ['helpful', 'false_positive']) {
      let payload: any;
      await submitLoopGuardFeedback({ user: { isAdmin: true, username: 'reviewer' }, params: { id: resultId }, body: { verdict } } as unknown as Request,
        { json: (value: any) => { payload = value; }, status: () => { throw new Error('Feedback save failed'); } } as unknown as Response);
      expect(payload.data.verdict).toBe(verdict);
    }
    expect((await pool.query('SELECT count(*) FROM tool_result_loop_feedback WHERE result_id=$1', [resultId])).rows[0].count).toBe('2');
    expect((await pool.query('SELECT raw FROM tool_results WHERE result_id=$1', [resultId])).rows[0].raw).toBe(before);
    let summary: any;
    await getLoopGuardSummary({ user: { isAdmin: true }, query: { days: '30' } } as unknown as Request,
      { json: (value: any) => { summary = value.data; }, status: () => { throw new Error('Summary failed'); } } as unknown as Response);
    expect(summary).toMatchObject({ reviewed: 1, helpful: 0, falsePositive: 1, assessed: 1, reportedFalsePositiveRate: 1 });
    expect(summary.unreviewed).toBe(summary.advice - 1);
    await pool.query(`UPDATE tool_result_state SET loop_guard_feedback='{"verdict":"ignored"}'::jsonb WHERE result_id=$1`, [resultId]);
    await getLoopGuardSummary({ user: { isAdmin: true }, query: {} } as unknown as Request,
      { json: (value: any) => { summary = value.data; }, status: () => { throw new Error('Summary failed'); } } as unknown as Response);
    expect(summary).toMatchObject({ reviewed: 1, helpful: 0, falsePositive: 0, ignored: 1, assessed: 0, reportedFalsePositiveRate: null });
  });
  test('agent reactions require a warning in the resolved branch, deduplicate and expire with the result', async () => {
    const context = await service.start('reaction-user');
    const other = await service.start('other-user');
    const resultId = randomUUID();
    await pool.query(`INSERT INTO tool_results (result_id,timestamp,raw,attribution) VALUES ($1,NOW(),'untouched',$2)`,
      [resultId, JSON.stringify({ traceId: context.traceId, branchId: context.branchId })]);
    await pool.query(`INSERT INTO tool_result_state (result_id,loop_guard_advice) VALUES ($1,'{"trigger":"repeated_identical_failure"}')`, [resultId]);
    const repo = new AttributionContextRepository({ query: async (sql, args) => (await pool.query(sql, args)).rows });
    const reaction = { result_id: resultId, action: 'changed_strategy' as const };
    await repo.recordLoopGuardReaction(other, randomUUID(), reaction);
    await repo.recordLoopGuardReaction({ ...context, branchId: randomUUID() }, randomUUID(), reaction);
    expect((await pool.query('SELECT count(*) FROM tool_result_loop_reactions')).rows[0].count).toBe('0');
    const callId = randomUUID();
    await repo.recordLoopGuardReaction(context, callId, reaction);
    await repo.recordLoopGuardReaction(context, callId, reaction);
    expect((await pool.query('SELECT action,source FROM tool_result_loop_reactions')).rows).toEqual([{ action: 'changed_strategy', source: 'self_reported' }]);
    let summary: any;
    await getLoopGuardSummary({ user: { isAdmin: true }, query: {} } as unknown as Request,
      { json: (value: any) => { summary = value.data; }, status: () => { throw new Error('Summary failed'); } } as unknown as Response);
    expect(summary.agentReactions).toMatchObject({ reported: 1, warnings: 1, changedStrategy: 1, accepted: 0, source: 'self_reported' });
    expect((await pool.query('SELECT raw FROM tool_results WHERE result_id=$1', [resultId])).rows[0].raw).toBe('untouched');
    await pool.query('DELETE FROM tool_results WHERE result_id=$1', [resultId]);
    expect((await pool.query('SELECT count(*) FROM tool_result_loop_reactions')).rows[0].count).toBe('0');
  });
  test('result reviews bind RAW digest, preserve audit and reject concurrent stale revisions', async () => {
    await pool.query('ALTER TABLE tool_results ADD COLUMN payload_available boolean DEFAULT true');
    const id = randomUUID(), digest = 'a'.repeat(64);
    await pool.query(`INSERT INTO tool_results(result_id,raw,raw_sha256) VALUES ($1,'original',$2)`, [id,digest]);
    await pool.query('INSERT INTO tool_result_state(result_id) VALUES ($1)', [id]);
    const save = async (revision: number, privacy = 'approved', rawSha256 = digest) => {
      let status = 200;
      await saveToolResultReview({ user: { isAdmin: true, username: 'reviewer' }, params: { id },
        body: { revision, privacy, quality: 'correct', rawSha256 } } as unknown as Request,
      { json: () => {}, status: (value: number) => { status=value; return { json: () => {} }; } } as unknown as Response);
      return status;
    };
    expect(await save(0,'approved','b'.repeat(64))).toBe(409);
    expect((await Promise.all([save(0),save(0)])).sort()).toEqual([200,409]);
    expect(await save(1,'rejected')).toBe(200);
    const record = await new ToolResultRepositoryDb(mockSummaryDb as never).findById(id);
    expect(record?.resultReview).toMatchObject({ revision: 2, privacy: 'rejected', rawSha256: digest });
    expect(record?.raw).toBe('original');
    expect((await pool.query('SELECT count(*) FROM tool_result_reviews WHERE result_id=$1',[id])).rows[0].count).toBe('2');
    await pool.query('DELETE FROM tool_results WHERE result_id=$1',[id]);
    expect((await pool.query('SELECT count(*) FROM tool_result_reviews WHERE result_id=$1',[id])).rows[0].count).toBe('0');
  });
  test('training context must match complete prior discovery and can be revoked after source retention',async()=>{
    await pool.query('ALTER TABLE tool_results ADD COLUMN objective text');
    const context=await service.start('training-context-user'), id=randomUUID(), callId=randomUUID();
    const tools=[{name:'demo-read',description:'Read a record',inputSchema:{type:'object',properties:{}}}];
    const evidence=extractDiscoveryEvidence('search_tools',{content:[{type:'text',text:JSON.stringify({tools})}]},true)!;
    await service.recordDiscovery(context,callId,evidence);
    expect((await pool.query('SELECT evidence FROM attribution_discovery_events WHERE call_id=$1',[callId])).rows[0].evidence.toolCatalogue).toEqual(tools);
    await pool.query(`INSERT INTO tool_results(result_id,timestamp,objective,attribution) VALUES($1,NOW()+INTERVAL '1 second','actual objective',$2)`,
      [id,JSON.stringify({traceId:context.traceId,branchId:context.branchId,invokedToolName:'demo-read'})]);
    await pool.query('INSERT INTO tool_result_state(result_id) VALUES($1)',[id]);
    const save=async(revision:number, supplied=tools, privacyApproved=true)=>{
      let status=200;
      await saveTrainingContext({user:{isAdmin:true,username:'reviewer'},params:{id},body:{revision,tools:supplied,discoveryCallId:callId,privacyApproved}} as unknown as Request,
        {json:()=>{},status:(value:number)=>{status=value;return {json:()=>{}};}} as unknown as Response);
      return status;
    };
    expect(await save(0,[{...tools[0],description:'fabricated description'}])).toBe(409);
    await pool.query('UPDATE attribution_discovery_events SET branch_id=$2 WHERE call_id=$1',[callId,randomUUID()]);
    expect(await save(0)).toBe(409);
    await pool.query('UPDATE attribution_discovery_events SET branch_id=$2,occurred_at=NOW()+INTERVAL \'1 hour\' WHERE call_id=$1',[callId,context.branchId]);
    expect(await save(0)).toBe(409);
    await pool.query('UPDATE attribution_discovery_events SET occurred_at=NOW() WHERE call_id=$1',[callId]);
    expect((await Promise.all([save(0),save(0)])).sort()).toEqual([200,409]);
    const repo=new ToolResultRepositoryDb(mockSummaryDb as never);
    expect((await repo.findById(id))?.trainingContext).toMatchObject({revision:1,privacyApproved:true});
    let editor: any;
    const loadEditor=()=>getTrainingContext({user:{isAdmin:true},params:{id}} as unknown as Request,
      {json:(value:any)=>{editor=value.data;},status:()=>{throw new Error('Context load failed');}} as unknown as Response);
    await loadEditor();
    expect(editor).toMatchObject({objective:'actual objective',invokedToolName:'demo-read',current:{revision:1,tools,privacyApproved:true}});
    expect(editor.sources.map((source:any)=>source.callId)).toEqual([callId]);
    expect(editor.sources[0].evidence.toolCatalogue).toEqual(tools);
    await pool.query('DELETE FROM attribution_discovery_events WHERE call_id=$1',[callId]);
    expect(await save(1,[],false)).toBe(200);
    expect((await repo.findById(id))?.trainingContext).toMatchObject({revision:2,privacyApproved:false});
    await loadEditor();
    expect(editor.current).toMatchObject({revision:2,tools,privacyApproved:false});
    expect(editor.sources).toEqual([]);
    expect((await pool.query('SELECT count(*) FROM tool_result_training_contexts WHERE result_id=$1',[id])).rows[0].count).toBe('2');
    await pool.query('DELETE FROM tool_results WHERE result_id=$1',[id]);
    expect((await pool.query('SELECT count(*) FROM tool_result_training_contexts WHERE result_id=$1',[id])).rows[0].count).toBe('0');
  });
  test('dataset preview/export enforces tenant and latest consent without exporting RAW',async()=>{
    await ensureDatasetExportSchema(pool);await ensureDatasetExportSchema(pool);
    const oldFlag=process.env.MCPHUB_DATASET_BUILDER_ENABLED;process.env.MCPHUB_DATASET_BUILDER_ENABLED='true';
    const context=await service.start('dataset-owner'),id=randomUUID(),digest='d'.repeat(64);
    const tools=[{name:'demo-read',inputSchema:{type:'object'}}];
    await pool.query(`INSERT INTO tool_results(result_id,username,key_id,status,raw,raw_sha256,objective,arguments,attribution)
      VALUES($1,'dataset-owner',NULL,'success','do not export RAW',$2,'read a record','{}',$3)`,[id,digest,JSON.stringify({
      taskId:context.taskId,traceId:context.traceId,branchId:context.branchId,modelSegmentId:context.modelSegmentId,
      invokedToolName:'demo-read',identity:{modelId:'observed',source:'gateway_observed',verified:true},provenance:{causalCorrelationVerified:true}})]);
    await pool.query(`INSERT INTO attribution_task_reviews(task_id,revision,outcome,training_consent,reviewed_by) VALUES($1,1,'success',true,'reviewer')`,[context.taskId]);
    await pool.query(`INSERT INTO tool_result_reviews(result_id,revision,raw_sha256,quality,privacy,reviewed_by) VALUES($1,1,$2,'correct','approved','reviewer')`,[id,digest]);
    await pool.query(`INSERT INTO tool_result_training_contexts(result_id,revision,discovery_call_id,objective,tool_catalogue,privacy_approved,reviewed_by)
      VALUES($1,1,$2,'read a record',$3,true,'reviewer')`,[id,randomUUID(),JSON.stringify(tools)]);
    const invoke=async(download:boolean,username='dataset-owner',split='train',seed='mcphub-v1',format='tool-selection-sft',selection=[id])=>{
      let payload:any,body='';
      const res={json:(value:any)=>{payload=value;},setHeader:()=>{},send:(value:string)=>{body=value;},status:()=>{throw new Error('Dataset request failed');}};
      await (download?exportDataset:previewDataset)({user:{isAdmin:true,username},body:{resultIds:selection,split,seed,format}} as unknown as Request,res as unknown as Response);
      return {payload,body};
    };
    try{
      const preview=(await invoke(false)).payload.data;
      expect(preview.exported).toBe(1);
      const split=Object.keys(preview.splits).find(key=>preview.splits[key]===1)!;
      const downloaded=(await invoke(true,'dataset-owner',split)).body;
      expect(JSON.parse(downloaded).metadata).toMatchObject({resultId:id,identityTrust:'trusted',split});
      expect(downloaded).not.toContain('do not export RAW');
      expect((await invoke(false,'dataset-owner','train','another-seed')).payload.data.splits[split]).toBe(1);
      const ledger=(await pool.query('SELECT * FROM dataset_exports WHERE username=$1',['dataset-owner'])).rows;
      expect(ledger).toHaveLength(1);expect(ledger[0].exported_ids).toEqual([id]);
      expect(ledger[0].byte_length).toBe(Buffer.byteLength(downloaded));
      expect(ledger[0].file_sha256.trim()).toBe(createHash('sha256').update(downloaded).digest('hex'));
      expect((await pool.query('SELECT count(*) FROM dataset_split_registry')).rows[0].count).toBe('3');
      await Promise.all([invoke(true,'dataset-owner',split,'new-seed'),invoke(true,'dataset-owner',split,'other-seed')]);
      expect((await pool.query('SELECT count(*) FROM dataset_split_registry')).rows[0].count).toBe('3');
      const traceToken=createHash('sha256').update(`trace:${context.traceId}`).digest('hex');
      await pool.query('UPDATE dataset_split_registry SET split=$1 WHERE token_hash=$2',[split==='train'?'test':'train',traceToken]);
      const beforeConflict=(await pool.query('SELECT count(*) FROM dataset_exports')).rows[0].count;
      for(const handler of [previewDataset,exportDataset]){
        let status=200,sent=false;
        await handler({user:{isAdmin:true,username:'dataset-owner'},body:{resultIds:[id],split}} as unknown as Request,
          {status:(value:number)=>{status=value;return {json:()=>{}};},setHeader:()=>{},json:()=>{},send:()=>{sent=true;}} as unknown as Response);
        expect(status).toBe(409);expect(sent).toBe(false);
      }
      expect((await pool.query('SELECT count(*) FROM dataset_exports')).rows[0].count).toBe(beforeConflict);
      await pool.query('UPDATE dataset_split_registry SET split=$1 WHERE token_hash=$2',[split,traceToken]);
      const second=randomUUID();
      await pool.query(`INSERT INTO tool_results(result_id,username,key_id,status,raw,raw_sha256,objective,arguments,attribution,timestamp)
        SELECT $2,username,key_id,'error',raw,raw_sha256,objective,'{"attempt":2}',attribution,timestamp+INTERVAL '1 second' FROM tool_results WHERE result_id=$1`,[id,second]);
      await pool.query(`INSERT INTO tool_result_reviews(result_id,revision,raw_sha256,quality,privacy,reviewed_by) VALUES($1,1,$2,'incorrect','approved','reviewer')`,[second,digest]);
      await pool.query(`INSERT INTO tool_result_training_contexts(result_id,revision,discovery_call_id,objective,tool_catalogue,privacy_approved,reviewed_by)
        VALUES($1,1,$2,'read a record',$3,true,'reviewer')`,[second,randomUUID(),JSON.stringify(tools)]);
      const incomplete=(await invoke(false,'dataset-owner',split,'seed','recorded-tool-trajectory')).payload.data;
      expect(incomplete.exported).toBe(0);expect(incomplete.excluded.trajectory_segment_incomplete).toBe(1);
      const trajectory=JSON.parse((await invoke(true,'dataset-owner',split,'seed','recorded-tool-trajectory',[id,second])).body);
      expect(trajectory.events.map((event:any)=>event.resultId)).toEqual([id,second]);
      expect(trajectory.events[1]).toMatchObject({executionStatus:'error',quality:'incorrect'});
      expect(trajectory.metadata).toMatchObject({split,originalConversationComplete:false,representation:'recorded-tool-trajectory'});
      expect(trajectory).not.toHaveProperty('messages');expect(JSON.stringify(trajectory)).not.toContain('do not export RAW');
      await ensureDatasetPreferenceSchema(pool);await ensureDatasetPreferenceSchema(pool);
      const dpoFlag=process.env.MCPHUB_DPO_ENABLED;process.env.MCPHUB_DPO_ENABLED='true';
      try{
        const owner={username:'dataset-owner',keyId:null};
        const preference=await createPreference(mockSummaryDb,owner,{chosenId:id,rejectedId:second,rationale:'Explicit comparable-context review'});
        expect(preference).toMatchObject({status:'draft',privacy_approved:false,revision:1});
        expect(await createPreference(mockSummaryDb,owner,{chosenId:id,rejectedId:second,rationale:'Duplicate'})).toBeNull();
        const equivalent=randomUUID();
        await pool.query(`INSERT INTO tool_results(result_id,username,key_id,status,raw,raw_sha256,objective,arguments,attribution,timestamp)
          SELECT $2,username,key_id,status,raw,raw_sha256,objective,arguments,attribution,timestamp+INTERVAL '2 seconds' FROM tool_results WHERE result_id=$1`,[id,equivalent]);
        await pool.query(`INSERT INTO tool_result_reviews(result_id,revision,raw_sha256,quality,privacy,reviewed_by) VALUES($1,1,$2,'correct','approved','reviewer')`,[equivalent,digest]);
        await pool.query(`INSERT INTO tool_result_training_contexts(result_id,revision,discovery_call_id,objective,tool_catalogue,privacy_approved,reviewed_by)
          VALUES($1,1,$2,'read a record',$3,true,'reviewer')`,[equivalent,randomUUID(),JSON.stringify(tools)]);
        expect(await createPreference(mockSummaryDb,owner,{chosenId:equivalent,rejectedId:second,rationale:'Same canonical comparison from another source'})).toBeNull();
        expect((await invoke(false,'dataset-owner',split,'seed','tool-preference-dpo',[id,second])).payload.data.exported).toBe(0);
        const approve=()=>reviewPreference(mockSummaryDb,owner,preference.preference_id,{revision:1,status:'approved'});
        expect((await Promise.all([approve(),approve()])).filter(Boolean)).toHaveLength(1);
        const pair=JSON.parse((await invoke(true,'dataset-owner',split,'seed','tool-preference-dpo',[id,second])).body);
        expect(pair.metadata).toMatchObject({labelSource:'user_confirmed',preferenceRevision:2,resultIds:[id,second],originalConversationComplete:false,split});
        expect(pair.chosen[0].tool_calls[0].function.arguments).toBe('{}');
        expect(pair.rejected[0].tool_calls[0].function.arguments).toBe('{"attempt":2}');
        expect(JSON.stringify(pair)).not.toMatch(/do not export RAW|Explicit comparable-context review/);
        expect((await invoke(false,'other-owner',split,'seed','tool-preference-dpo',[id,second])).payload.data.exported).toBe(0);
        await pool.query(`INSERT INTO tool_result_reviews(result_id,revision,raw_sha256,quality,privacy,reviewed_by) VALUES($1,2,$2,'correct','approved','reviewer')`,[id,digest]);
        expect((await invoke(false,'dataset-owner',split,'seed','tool-preference-dpo',[id,second])).payload.data.exported).toBe(0);
        expect(await reviewPreference(mockSummaryDb,owner,preference.preference_id,{revision:2,status:'approved'})).toBeNull();
        expect(await reviewPreference(mockSummaryDb,owner,preference.preference_id,{revision:2,status:'draft'})).toMatchObject({revision:3,privacy_approved:false});
        expect(await reviewPreference(mockSummaryDb,owner,preference.preference_id,{revision:3,status:'approved'})).toMatchObject({revision:4});
        expect((await invoke(false,'dataset-owner',split,'seed','tool-preference-dpo',[id,second])).payload.data.exported).toBe(1);
        expect(await reviewPreference(mockSummaryDb,owner,preference.preference_id,{revision:4,status:'retired'})).toMatchObject({revision:5});
        expect(await createPreference(mockSummaryDb,owner,{chosenId:id,rejectedId:second,rationale:'Replacement after retirement'})).toMatchObject({status:'draft'});
      }finally{if(dpoFlag===undefined)delete process.env.MCPHUB_DPO_ENABLED;else process.env.MCPHUB_DPO_ENABLED=dpoFlag;}
      expect((await invoke(false,'other-owner')).payload.data.exported).toBe(0);
      await pool.query(`INSERT INTO attribution_task_reviews(task_id,revision,outcome,training_consent,reviewed_by) VALUES($1,2,'success',false,'reviewer')`,[context.taskId]);
      expect((await invoke(false)).payload.data.excluded.training_consent_missing).toBe(1);
      expect((await invoke(true,'dataset-owner',split)).body).toBe('');
    }finally{if(oldFlag===undefined)delete process.env.MCPHUB_DATASET_BUILDER_ENABLED;else process.env.MCPHUB_DATASET_BUILDER_ENABLED=oldFlag;}
  });
  test('experience retrieval requires current independent evidence and isolates owners',async()=>{
    await ensureExperienceSchema(pool);await ensureExperienceSchema(pool);
    const ids:string[]=[],digest='e'.repeat(64);
    for(let index=0;index<2;index++){
      const task=await service.start('experience-owner');
      await pool.query(`INSERT INTO attribution_task_reviews(task_id,revision,outcome,training_consent,reviewed_by) VALUES($1,1,'success',false,'reviewer')`,[task.taskId]);
      for(let step=0;step<2;step++){
        const id=randomUUID();ids.push(id);
        await pool.query(`INSERT INTO tool_results(result_id,timestamp,server,tool,username,key_id,raw_sha256,attribution)
          VALUES($1,$2,'demo',$3,'experience-owner',NULL,$4,$5)`,[id,new Date(Date.now()-2000+step*1000),step?'verify':'inspect',digest,
          JSON.stringify({taskId:task.taskId,traceId:task.traceId,branchId:task.branchId,modelSegmentId:task.modelSegmentId})]);
        await pool.query(`INSERT INTO tool_result_reviews(result_id,revision,raw_sha256,quality,privacy,reviewed_by) VALUES($1,1,$2,'correct','approved','reviewer')`,[id,digest]);
      }
    }
    const entry=await createExperience({username:'experience-owner',keyId:null,title:'GPU diagnostic strategy',summary:'Inspect errors before retrying',
      taskType:'diagnostic',scope:{servers:['demo']},toolVersions:{},evidenceIds:ids,approved:true});
    expect(entry?.assessment).toMatchObject({usable:true,confidence:'supported',independentTasks:2});
    expect((await previewSkillFromExperience(entry!.experience_id,'experience-owner',null))?.candidate).toMatchObject({
      independentTasks:2,confidence:'proposal',steps:[{server:'demo',tool:'inspect'},{server:'demo',tool:'verify'}]});
    expect(await previewSkillFromExperience(entry!.experience_id,'other-owner',null)).toBeNull();
    await ensureSkillProposalSchema(pool);await ensureSkillProposalSchema(pool);
    const skillOwner={username:'experience-owner',keyId:null};
    const skill=await createSkillProposal(entry!.experience_id,skillOwner);
    expect(skill).toMatchObject({status:'draft',revision:1,source_revision:1});
    expect(await exportSkillProposal(skill.proposal_id,skillOwner)).toBeNull();
    expect(await listSkillProposals({username:'other-owner',keyId:null})).toHaveLength(0);
    const approve=()=>reviseSkillProposal(skill.proposal_id,skillOwner,{revision:1,status:'approved'});
    expect((await Promise.all([approve(),approve()])).filter(Boolean)).toHaveLength(1);
    expect((await exportSkillProposal(skill.proposal_id,skillOwner))?.markdown).toContain('## Evidence');
    expect(await reviseSkillProposal(skill.proposal_id,skillOwner,{revision:2,status:'draft',markdown:'Edited draft'})).toMatchObject({status:'draft',revision:3});
    expect(await exportSkillProposal(skill.proposal_id,skillOwner)).toBeNull();
    expect(await reviseSkillProposal(skill.proposal_id,skillOwner,{revision:3,status:'approved'})).toMatchObject({status:'approved',revision:4});
    expect((await pool.query('SELECT count(*) FROM skill_proposal_versions WHERE proposal_id=$1',[skill.proposal_id])).rows[0].count).toBe('4');
    const history=await readSkillVersions(skill.proposal_id,skillOwner);
    expect(history?.versions.map(version=>version.revision)).toEqual([4,3,2,1]);
    expect(history?.versions[1]).toMatchObject({markdown:'Edited draft',status:'draft'});
    expect(history?.versions[3].markdown).toContain('## Evidence');
    expect(history?.versions[0]).not.toHaveProperty('source_snapshot');
    expect((await readSkillVersions(skill.proposal_id,skillOwner,3))?.versions.map(version=>version.revision)).toEqual([2,1]);
    expect(await readSkillVersions(skill.proposal_id,{username:'other-owner',keyId:null})).toBeNull();
    expect(await readSkillVersions(skill.proposal_id,{...skillOwner,keyId:'other-key'})).toBeNull();
    const search=(username='experience-owner')=>searchExperiences({username,keyId:null,query:'diagnostic',limit:10});
    expect(await search()).toHaveLength(1);expect(await search('other-owner')).toHaveLength(0);
    const readCurrent=async(username='experience-owner')=>{
      const previous=process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED='true';let status=200;
      try{await readExperience({user:{isAdmin:true,username},params:{id:entry!.experience_id},query:{}} as unknown as Request,
        {json:()=>{},status:(value:number)=>{status=value;return {json:()=>{}};}} as unknown as Response);return status;}
      finally{if(previous===undefined)delete process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;else process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED=previous;}
    };
    expect(await readCurrent()).toBe(200);expect(await readCurrent('other-owner')).toBe(404);
    expect(await searchExperiences({username:'experience-owner',keyId:null,query:'diagnostic',server:'other-server',tool:'inspect',limit:10})).toHaveLength(0);
    const memoryFlag=process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED,adviceFlag=process.env.MCPHUB_EXPERIENCE_ADVICE_ENABLED;
    process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED='true';process.env.MCPHUB_EXPERIENCE_ADVICE_ENABLED='true';
    try{
      const target={username:'experience-owner',server:'demo',tool:'inspect',taskType:'diagnostic'};
      expect(await getExperienceAdvice(target)).toHaveLength(1);
      expect(await getExperienceAdvice({...target,taskType:undefined})).toHaveLength(0);
      expect(await getExperienceAdvice({...target,server:'other-server'})).toHaveLength(0);
    }finally{
      if(memoryFlag===undefined)delete process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;else process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED=memoryFlag;
      if(adviceFlag===undefined)delete process.env.MCPHUB_EXPERIENCE_ADVICE_ENABLED;else process.env.MCPHUB_EXPERIENCE_ADVICE_ENABLED=adviceFlag;
    }
    await pool.query(`INSERT INTO tool_result_reviews(result_id,revision,raw_sha256,quality,privacy,reviewed_by) VALUES($1,2,$2,'correct','rejected','reviewer')`,[ids[0],digest]);
    expect(await search()).toHaveLength(0);
    expect(await previewSkillFromExperience(entry!.experience_id,'experience-owner',null)).toBeNull();
    expect(await exportSkillProposal(skill.proposal_id,skillOwner)).toBeNull();
    expect(await readCurrent()).toBe(404);
    expect((await listExperienceEntries({username:'experience-owner',keyId:null,limit:20}))[0].assessment.usable).toBe(false);
    const old=process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED='true';
    try{
      const retire=async()=>{let status=200;await reviewExperience({user:{isAdmin:true,username:'experience-owner'},params:{id:entry!.experience_id},
        body:{revision:1,status:'retired'}} as unknown as Request,{json:()=>{},status:(value:number)=>{status=value;return {json:()=>{}};}} as unknown as Response);return status;};
      expect((await Promise.all([retire(),retire()])).sort()).toEqual([200,409]);
      expect((await pool.query('SELECT count(*) FROM experience_entry_audit WHERE experience_id=$1',[entry!.experience_id])).rows[0].count).toBe('2');
    }finally{if(old===undefined)delete process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED;else process.env.MCPHUB_EXPERIENCE_MEMORY_ENABLED=old;}
  });
});
