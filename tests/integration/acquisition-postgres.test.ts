import { randomUUID, createHash } from 'node:crypto';
import { Client, Pool } from 'pg';
import { ensureMcpAcquisitionSchema } from '../../src/db/mcpAcquisitionSchema.js';
import { AcquisitionPlanRepository, buildAcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';
import type { MarketServer } from '../../src/types/index.js';
import { AcquisitionOperationRepository } from '../../src/services/mcpAcquisitionOperation.js';
import { ensureToolResultHistorySchema } from '../../src/db/toolResultHistorySchema.js';
import { prepareAcquisitionPublication } from '../../src/services/mcpAcquisitionPublicationSettings.js';
import { DataSource } from 'typeorm';
import { Server as StoredServer } from '../../src/db/entities/Server.js';
import { Group as StoredGroup } from '../../src/db/entities/Group.js';
import { publishPostgresAcquisition, rollbackPostgresAcquisition } from '../../src/services/mcpAcquisitionPostgresPublication.js';

const postgresDescribe = process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD ? describe : describe.skip;
postgresDescribe('immutable MCP acquisition plans in PostgreSQL', () => {
  const schema = `acquisition_${randomUUID().replace(/-/g, '')}`;
  let admin: Client;
  let pool: Pool;
  let repository: AcquisitionPlanRepository;
  let settingsDb: DataSource;
  beforeAll(async () => {
    const config = {
      host: process.env.MCPHUB_ATTRIBUTION_TEST_HOST ?? '127.0.0.1',
      port: Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT ?? 5432),
      user: process.env.MCPHUB_ATTRIBUTION_TEST_USER ?? 'postgres',
      password: process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,
      database: process.env.MCPHUB_ATTRIBUTION_TEST_DB ?? 'mcphub_history_test',
    };
    admin = new Client(config);
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...config, options: `-c search_path=${schema},public` });
    const db = { query: async (sql: string, args?: any[]) => (await pool.query(sql, args)).rows };
    await ensureMcpAcquisitionSchema(db);
    await ensureMcpAcquisitionSchema(db); // startup/restart must preserve existing schema
    await ensureToolResultHistorySchema(db);
    repository = new AcquisitionPlanRepository(db);
    settingsDb=new DataSource({type:'postgres',...config,schema,entities:[StoredServer,StoredGroup],synchronize:true,
      extra:{options:`-c search_path=${schema},public`}});
    await settingsDb.initialize();
  });
  afterAll(async () => {
    if (settingsDb?.isInitialized) await settingsDb.destroy();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount).toBe(0);
      await admin.end();
    }
  });

  test('persists exact plan across repository instances and isolates owners', async () => {
    const manifest = buildAcquisitionManifest({ name: 'synthetic', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', '@fixture/mcp'] },
    }, arguments: {} } as unknown as MarketServer, '1.2.3', 'fixture-group');
    const created = await repository.create('alice', manifest);
    const restarted = new AcquisitionPlanRepository({ query: async (sql, args) => (await pool.query(sql, args)).rows });
    expect((await restarted.get('alice', created.plan_id))?.manifest).toEqual(manifest);
    expect(await restarted.get('bob', created.plan_id)).toBeNull();
    await expect(pool.query('UPDATE mcp_acquisition_plans SET owner=$1 WHERE plan_id=$2', ['bob', created.plan_id]))
      .rejects.toThrow('immutable');
    await expect(pool.query('UPDATE mcp_acquisition_plans SET manifest=$1 WHERE plan_id=$2', ['{}', created.plan_id]))
      .rejects.toThrow('immutable');
    expect((await restarted.get('alice', created.plan_id))?.manifest_digest).toBe(created.manifest_digest);
  });

  test('expired plans are unavailable without changing immutable data', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO mcp_acquisition_plans(plan_id,owner,manifest,manifest_digest,created_at,expires_at)
      VALUES($1,'alice','{}',$2,NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour')`, [id, 'a'.repeat(64)]);
    expect(await repository.get('alice', id)).toBeNull();
  });

  test('refuses a persisted payload whose digest does not match', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO mcp_acquisition_plans(plan_id,owner,manifest,manifest_digest,expires_at)
      VALUES($1,'alice','{}',$2,NOW()+INTERVAL '1 hour')`, [id, 'a'.repeat(64)]);
    await expect(repository.get('alice', id)).rejects.toThrow('integrity');
    expect(await repository.get('bob', id)).toBeNull();
  });

  test('concurrent authorization creates one operation and rejects wrong owner/digest or reused key', async () => {
    const manifest = buildAcquisitionManifest({ name: 'synthetic', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', '@fixture/mcp'] },
    }, arguments: {} } as unknown as MarketServer, '1.2.3', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const key = randomUUID();
    expect(await repository.authorize('bob', plan.plan_id, plan.manifest_digest, key)).toBeNull();
    expect(await repository.authorize('alice', plan.plan_id, 'b'.repeat(64), key)).toBeNull();
    const operations = await Promise.all(Array.from({ length: 5 }, () =>
      repository.authorize('alice', plan.plan_id, plan.manifest_digest, key)));
    expect(new Set(operations.map(operation => operation.operation_id)).size).toBe(1);
    expect(operations[0].state).toBe('authorized');
    expect((await repository.get('alice', plan.plan_id))?.operation_state).toBe('authorized');
    const other = await repository.create('alice', manifest);
    expect(await repository.authorize('alice', other.plan_id, other.manifest_digest, key)).toBeNull();
    const otherOperation = await repository.authorize('alice', other.plan_id, other.manifest_digest, randomUUID());
    expect(otherOperation.state).toBe('authorized');
    // A plan that already has its own operation must not swallow another plan's key.
    expect(await repository.authorize('alice', other.plan_id, other.manifest_digest, key)).toBeNull();
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM mcp_acquisition_operations WHERE plan_id=$1', [plan.plan_id])).rows[0].count).toBe(1);
  });

  test('only one worker claims execution, cancellation blocks progress and stale claims cannot write', async () => {
    const db = { query: async (sql: string, args?: any[]) => (await pool.query(sql, args)).rows };
    const operations = new AcquisitionOperationRepository(db);
    const manifest = buildAcquisitionManifest({ name: 'fixture', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'] },
    } } as unknown as MarketServer, '1.0.0', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const operation = await repository.authorize('alice', plan.plan_id, plan.manifest_digest, randomUUID());
    expect(await operations.claim('bob', operation.operation_id)).toBeNull();
    const claims = (await Promise.all(Array.from({ length: 5 }, () => operations.claim('alice', operation.operation_id)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    expect(await operations.transition('alice', operation.operation_id, randomUUID(), 'staging', 'starting')).toBeNull();
    expect((await operations.cancel('alice', operation.operation_id)).state).toBe('staging');
    expect(await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'starting')).toBeNull();
    expect((await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'rolled_back')).state).toBe('rolled_back');
    expect((await operations.cancel('alice', operation.operation_id)).state).toBe('rolled_back');
    expect(await operations.claim('alice', operation.operation_id)).toBeNull();
  });

  test('uncertain native outcomes block forward progress until cleanup is reconciled', async () => {
    const operations = new AcquisitionOperationRepository({ query: async (sql, args) => (await pool.query(sql, args)).rows });
    const manifest = buildAcquisitionManifest({ name: 'fixture', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'] },
    } } as unknown as MarketServer, '1.0.0', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const operation = await repository.authorize('alice', plan.plan_id, plan.manifest_digest, randomUUID());
    const claim = await operations.claim('alice', operation.operation_id);
    expect(await operations.requireReconciliation('bob', operation.operation_id, claim.claim_id)).toBe(false);
    expect(await operations.requireReconciliation('alice', operation.operation_id, claim.claim_id)).toBe(true);
    expect((await operations.get('alice', operation.operation_id)).requires_reconciliation).toBe(true);
    expect(await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'starting')).toBeNull();
    await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'failed', 'native_state_unknown');
    expect((await operations.get('alice', operation.operation_id)).failure_code).toBe('native_state_unknown');
    await operations.transition('alice', operation.operation_id, claim.claim_id, 'failed', 'rolled_back');
    expect((await operations.get('alice', operation.operation_id)).requires_reconciliation).toBe(false);
  });

  test('publication reservation is single-owner, immutable and survives a repository restart', async () => {
    const db = { query: async (sql: string, args?: any[]) => (await pool.query(sql, args)).rows };
    const operations = new AcquisitionOperationRepository(db);
    const manifest = buildAcquisitionManifest({ name: 'fixture', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'] },
    } } as unknown as MarketServer, '1.0.0', 'fixture-group');
    const plan = await repository.create('alice', manifest);
    const operation = await repository.authorize('alice', plan.plan_id, plan.manifest_digest, randomUUID());
    const id=operation.operation_id;
    const claim = await operations.claim('alice', id);
    await operations.transition('alice', id, claim.claim_id, 'staging', 'starting');
    await operations.beginVerification('alice', id);
    const prepared=prepareAcquisitionPublication({mcpServers:{},groups:[{id:'fixture-group',name:'Fixture',servers:[]}]},
      manifest,id,'alice',{command:'node.exe',args:['fixture.js'],cwd:'owned'},['ping']);
    const reservation={storage:'json' as const,settingsPath:'/synthetic/settings.json',baseDigest:'a'.repeat(64),receipt:prepared.receipt};
    expect(await operations.reservePublication('alice',id,claim.claim_id,reservation)).toBe(false);
    expect(await operations.recordInspection('alice',id,claim.claim_id,{verification:'discovery_only',tools:['ping']})).toBe(true);
    expect(await operations.publicationCandidate('bob',id)).toBeNull();
    expect((await operations.publicationCandidate('alice',id)).manifest).toEqual(manifest);
    await expect(operations.reservePublication('bob',id,claim.claim_id,reservation)).rejects.toThrow('Invalid publication');
    expect(await operations.reservePublication('alice',id,randomUUID(),reservation)).toBe(false);
    const altered=structuredClone(reservation); altered.receipt.entry.tools=['unverified'];
    expect(await operations.reservePublication('alice',id,claim.claim_id,altered)).toBe(false);
    const claims=await Promise.all(Array.from({length:5},()=>operations.reservePublication('alice',id,claim.claim_id,reservation)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await operations.publicationCandidate('alice',id)).toBeNull();
    const restarted=new AcquisitionOperationRepository(db);
    expect((await restarted.getPublication('alice',id)).publication).toEqual(reservation);
    expect(await restarted.getPublication('bob',id)).toBeNull();
    expect(await restarted.reservePublication('alice',id,claim.claim_id,reservation)).toBe(false);
    await expect(pool.query('UPDATE mcp_acquisition_operations SET publication=NULL WHERE operation_id=$1',[id])).rejects.toThrow('immutable');
    await operations.cancel('alice',id);
    expect(await operations.recordPublicationApplied('alice',id,claim.claim_id,'b'.repeat(64))).toBe(true);
    expect(await operations.recordPublicationApplied('alice',id,claim.claim_id,'c'.repeat(64))).toBe(false);
    expect((await restarted.getPublication('alice',id)).publication_applied_digest).toBe('b'.repeat(64));
    await expect(pool.query('UPDATE mcp_acquisition_operations SET publication_applied_digest=NULL WHERE operation_id=$1',[id])).rejects.toThrow('immutable');
    expect(await operations.transition('alice',id,claim.claim_id,'verifying','rolled_back')).toBeNull();
    expect(await operations.claimPublicationRollback('bob',id)).toBeNull();
    const rollbacks=(await Promise.all(Array.from({length:5},()=>operations.claimPublicationRollback('alice',id)))).filter(Boolean);
    expect(rollbacks).toHaveLength(1);
    expect(await operations.completePublicationRollback('alice',id,randomUUID(),'c'.repeat(64))).toBe(false);
    expect(await operations.completePublicationRollback('alice',id,rollbacks[0].rollback_claim_id,'c'.repeat(64))).toBe(true);
    expect((await operations.get('alice',id)).state).toBe('rolled_back');
    expect(await operations.claimPublicationRollback('alice',id)).toBeNull();
  });

  test('ready requires one activation claim after publication and verified tool coverage', async () => {
    const operations=new AcquisitionOperationRepository({query:async(sql,args)=>(await pool.query(sql,args)).rows});
    const manifest=buildAcquisitionManifest({name:'fixture',installations:{npm:{type:'npm',command:'npx',args:['-y','fixture']}}} as unknown as MarketServer,'1.0.0','fixture-group');
    const plan=await repository.create('alice',manifest);
    const operation=await repository.authorize('alice',plan.plan_id,plan.manifest_digest,randomUUID());
    const id=operation.operation_id,claim=await operations.claim('alice',id);
    await operations.transition('alice',id,claim.claim_id,'staging','starting');
    await operations.beginVerification('alice',id);
    await operations.recordInspection('alice',id,claim.claim_id,{verification:'discovery_only',tools:['ping']});
    expect(await operations.claimActivation('alice',id)).toBeNull();
    await expect(operations.transition('alice',id,claim.claim_id,'verifying','ready')).rejects.toThrow('activation');
    const prepared=prepareAcquisitionPublication({mcpServers:{},groups:[{id:'fixture-group',name:'Fixture',servers:[]}]},
      manifest,id,'alice',{command:'node.exe',args:['fixture.js'],cwd:'owned'},['ping']);
    expect(await operations.reservePublication('alice',id,claim.claim_id,{storage:'json',settingsPath:'/synthetic/settings.json',baseDigest:'a'.repeat(64),receipt:prepared.receipt})).toBe(true);
    expect(await operations.claimActivation('alice',id)).toBeNull();
    await operations.recordPublicationApplied('alice',id,claim.claim_id,'b'.repeat(64));
    expect(await operations.claimActivation('bob',id)).toBeNull();
    const claims=(await Promise.all(Array.from({length:5},()=>operations.claimActivation('alice',id)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    const token=claims[0].activation_claim_id;
    const evidence={serverName:'fixture',tools:['ping'],indexStatus:'verified' as const};
    expect(await operations.completeActivation('alice',id,randomUUID(),evidence)).toBe(false);
    expect(await operations.completeActivation('alice',id,token,{...evidence,tools:['wrong']})).toBe(false);
    expect(await operations.completeActivation('alice',id,token,evidence)).toBe(true);
    expect((await operations.get('alice',id)).state).toBe('ready');
    expect(await operations.completeActivation('alice',id,token,evidence)).toBe(false);
  });

  test('database publication commits settings and journal together and rolls back a rejected journal',async()=>{
    const operations=new AcquisitionOperationRepository({query:async(sql,args)=>(await pool.query(sql,args)).rows});
    const group=await settingsDb.getRepository(StoredGroup).save({name:'Database target',servers:[],owner:'alice'});
    const manifest=buildAcquisitionManifest({name:'database-fixture',installations:{npm:{type:'npm',command:'npx',args:['-y','fixture']}}} as unknown as MarketServer,'1.0.0',group.id);
    const plan=await repository.create('alice',manifest);
    const operation=await repository.authorize('alice',plan.plan_id,plan.manifest_digest,randomUUID());
    const id=operation.operation_id,claim=await operations.claim('alice',id);
    await operations.transition('alice',id,claim.claim_id,'staging','starting');await operations.beginVerification('alice',id);
    await operations.recordInspection('alice',id,claim.claim_id,{verification:'discovery_only',tools:['ping']});
    const input={manifest,operationId:id,owner:'alice',launch:{command:'node.exe',args:['fixture.js'],cwd:'owned'},verifiedTools:['ping']};
    const applied=await publishPostgresAcquisition(settingsDb,input,claim.claim_id);
    const stored=await settingsDb.getRepository(StoredServer).findOneByOrFail({name:manifest.serverName});
    expect(stored.owner).toBe('alice');expect(stored.options?.startOnDemand).toBe(true);
    expect((await settingsDb.getRepository(StoredGroup).findOneByOrFail({id:group.id})).servers).toEqual([{name:manifest.serverName,tools:['ping'],prompts:[],resources:[]}]);
    expect((await operations.getPublication('alice',id)).publication).toMatchObject({storage:'postgres',serverId:stored.id});
    expect((await operations.getPublication('alice',id)).publication_applied_digest).toBe(applied.digest);
    const rejected={...input,manifest:{...manifest,serverName:'rejected-fixture'},operationId:randomUUID()};
    await expect(publishPostgresAcquisition(settingsDb,rejected,randomUUID())).rejects.toThrow('reservation');
    expect(await settingsDb.getRepository(StoredServer).findOneBy({name:'rejected-fixture'})).toBeNull();
    expect((await settingsDb.getRepository(StoredGroup).findOneByOrFail({id:group.id})).servers).toHaveLength(1);
    await settingsDb.getRepository(StoredServer).update({id:stored.id},{enabled:false});
    await expect(rollbackPostgresAcquisition(settingsDb,applied.reservation)).rejects.toThrow('reconciliation');
    expect((await settingsDb.getRepository(StoredServer).findOneByOrFail({id:stored.id})).enabled).toBe(false);
    await settingsDb.getRepository(StoredServer).update({id:stored.id},{enabled:true});
    const unrelated=await settingsDb.getRepository(StoredServer).save({name:'unrelated-database',command:'keep.exe',enabled:true,owner:'alice'});
    const currentGroup=await settingsDb.getRepository(StoredGroup).findOneByOrFail({id:group.id});
    await settingsDb.getRepository(StoredGroup).update({id:group.id},{servers:[...currentGroup.servers,{name:unrelated.name,tools:['read']}]});
    await rollbackPostgresAcquisition(settingsDb,applied.reservation);
    expect(await settingsDb.getRepository(StoredServer).findOneBy({id:stored.id})).toBeNull();
    expect(await settingsDb.getRepository(StoredServer).findOneBy({id:unrelated.id})).not.toBeNull();
    expect((await settingsDb.getRepository(StoredGroup).findOneByOrFail({id:group.id})).servers).toEqual([{name:unrelated.name,tools:['read']}]);
  });

  test('one exact authorized probe attaches only its owner-scoped RAW evidence', async () => {
    const db = { query: async (sql: string, args?: any[]) => (await pool.query(sql, args)).rows };
    const operations = new AcquisitionOperationRepository(db);
    const manifest = buildAcquisitionManifest({ name: 'fixture', installations: {
      npm: { type: 'npm', command: 'npx', args: ['-y', 'fixture'] },
    } } as unknown as MarketServer, '1.0.0', 'fixture-group', 'fixture_ping');
    const plan = await repository.create('alice', manifest);
    const operation = await repository.authorize('alice', plan.plan_id, plan.manifest_digest, randomUUID());
    const claim = await operations.claim('alice', operation.operation_id);
    await operations.transition('alice', operation.operation_id, claim.claim_id, 'staging', 'starting');
    expect(await operations.beginVerification('bob', operation.operation_id)).toBeNull();
    const continuations = (await Promise.all(Array.from({ length: 5 }, () => operations.beginVerification('alice', operation.operation_id)))).filter(Boolean);
    expect(continuations).toHaveLength(1);
    expect(await operations.claimProbe('bob', operation.operation_id, plan.manifest_digest)).toBeNull();
    const claims = (await Promise.all(Array.from({ length: 5 }, () => operations.claimProbe('alice', operation.operation_id, plan.manifest_digest)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    const raw = JSON.stringify({ content: [{ type: 'text', text: 'synthetic-probe' }] });
    const save = async (owner: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO tool_results(result_id,server,tool,duration_ms,status,username,objective,arguments,raw,raw_bytes,raw_sha256)
        VALUES($1,'fixture','fixture_ping',0,'success',$2,$3,'{}',$4,$5,$6)`,
      [id, owner, `acquisition:${operation.operation_id}`, raw, Buffer.byteLength(raw), createHash('sha256').update(raw).digest('hex')]);
      return id;
    };
    expect(await operations.completeProbe('alice', operation.operation_id, claims[0], await save('bob'))).toBe(false);
    const resultId = await save('alice');
    expect(await operations.recordInspection('alice', operation.operation_id, claim.claim_id, {
      verification: 'functional', tools: ['fixture_ping'], resultId,
    })).toBe(false);
    expect(await operations.completeProbe('alice', operation.operation_id, claims[0], resultId)).toBe(true);
    expect(await operations.completeProbe('alice', operation.operation_id, claims[0], resultId)).toBe(true);
    expect(await operations.completeProbe('alice', operation.operation_id, claims[0], await save('alice'))).toBe(false);
    expect((await operations.get('alice', operation.operation_id)).probe_result_id).toBe(resultId);
    expect(await operations.claimProbe('alice', operation.operation_id, plan.manifest_digest)).toBeNull();
    expect(await operations.recordInspection('alice', operation.operation_id, claim.claim_id, {
      verification: 'functional', tools: ['fixture_ping'], resultId,
    })).toBe(true);
    const recorded = await operations.get('alice', operation.operation_id);
    expect(recorded.verification).toBe('functional');
    expect(recorded.inspection.resultId).toBe(resultId);
    expect(await operations.recordInspection('alice', operation.operation_id, claim.claim_id, {
      verification: 'discovery_only', tools: ['fixture_ping'],
    })).toBe(false);
    const prepared=prepareAcquisitionPublication({mcpServers:{},groups:[{id:'fixture-group',name:'Fixture',servers:[]}]},
      manifest,operation.operation_id,'alice',{command:'node.exe',args:['fixture.js'],cwd:'owned'},['fixture_ping']);
    const reservation={storage:'json' as const,settingsPath:'/synthetic/settings.json',baseDigest:'a'.repeat(64),receipt:prepared.receipt};
    await pool.query('DELETE FROM tool_results WHERE result_id=$1',[resultId]);
    expect(await operations.reservePublication('alice',operation.operation_id,claim.claim_id,reservation)).toBe(false);
  });
});
