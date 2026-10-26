import {randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {ensureMcpAcquisitionSchema} from '../../src/db/mcpAcquisitionSchema.js';
import {AcquisitionPlanRepository,buildAcquisitionManifest} from '../../src/services/mcpAcquisitionPlan.js';
import {AcquisitionCleanupJournal} from '../../src/services/mcpAcquisitionCleanupJournal.js';
import type {MarketServer} from '../../src/types/index.js';
import {DataSource} from 'typeorm';
import {Server} from '../../src/db/entities/Server.js';
import {withPostgresCleanupSettings} from '../../src/services/mcpAcquisitionCleanupSettings.js';
import {withCleanupIndexGuard} from '../../src/services/mcpAcquisitionCleanupIndex.js';
import {runAcquisitionCleanup} from '../../src/services/mcpAcquisitionCleanup.js';

const suite=process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD?describe:describe.skip;
suite('owned acquisition cleanup journal in PostgreSQL',()=>{
  const schema=`cleanup_${randomUUID().replace(/-/g,'')}`;
  let admin:Client,pool:Pool,journal:AcquisitionCleanupJournal,plans:AcquisitionPlanRepository,settingsDb:DataSource;
  beforeAll(async()=>{
    const config={host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST??'127.0.0.1',
      port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT??5432),user:process.env.MCPHUB_ATTRIBUTION_TEST_USER??'postgres',
      password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,database:process.env.MCPHUB_ATTRIBUTION_TEST_DB??'mcphub_history_test'};
    admin=new Client(config);await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({...config,options:`-c search_path=${schema},public`});
    const db={query:async(sql:string,args?:any[])=>(await pool.query(sql,args)).rows};
    await ensureMcpAcquisitionSchema(db);await ensureMcpAcquisitionSchema(db);
    journal=new AcquisitionCleanupJournal(db);plans=new AcquisitionPlanRepository(db);
    settingsDb=new DataSource({type:'postgres',...config,username:config.user,schema,entities:[Server],synchronize:true,
      extra:{options:`-c search_path=${schema},public`}});
    await settingsDb.initialize();
    await pool.query('CREATE TABLE vector_embeddings (content_type text,content_id text,metadata text)');
  });
  test('index adoption blocks work and concurrent embedding writes wait until guarded work completes',async()=>{
    await pool.query(`INSERT INTO vector_embeddings VALUES ('tool','adopted:ping','{"serverName":"adopted"}')`);
    const work=jest.fn();
    await expect(withCleanupIndexGuard(settingsDb,['adopted'],work)).rejects.toThrow('references remain');
    expect(work).not.toHaveBeenCalled();
    await pool.query('DELETE FROM vector_embeddings');
    await pool.query(`INSERT INTO vector_embeddings VALUES ('tool','adopted:legacy','{}')`);
    await expect(withCleanupIndexGuard(settingsDb,['adopted'],work)).rejects.toThrow('references remain');
    expect(work).not.toHaveBeenCalled();
    await pool.query('DELETE FROM vector_embeddings');
    const writer=await pool.connect();
    try{
      await withCleanupIndexGuard(settingsDb,['adopted'],async()=>{
        await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
        await expect(writer.query(`INSERT INTO vector_embeddings VALUES ('server','adopted','{}')`)).rejects.toMatchObject({code:'55P03'});
        await writer.query('ROLLBACK');
      });
      await writer.query(`INSERT INTO vector_embeddings VALUES ('server','adopted','{}')`);
      await expect(withCleanupIndexGuard(settingsDb,['adopted'],work)).rejects.toThrow('references remain');
      expect(work).not.toHaveBeenCalled();
      await writer.query('DELETE FROM vector_embeddings');
      await writer.query(`INSERT INTO vector_embeddings VALUES ('tool','malformed','not-json')`);
      await expect(withCleanupIndexGuard(settingsDb,['adopted'],work)).rejects.toThrow('unconfirmed');
      expect(work).not.toHaveBeenCalled();
    }finally{await writer.query('ROLLBACK');await writer.query('DELETE FROM vector_embeddings');writer.release();}
  });
  afterAll(async()=>{
    if(settingsDb?.isInitialized)await settingsDb.destroy();
    if(pool)await pool.end();
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      expect((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);
      await admin.end();}
  });
  const operation=async(state='failed',reconciliation=false,inputs:string[]=[])=>{
    const manifest=buildAcquisitionManifest({name:'cleanup-fixture',installations:{npm:{type:'npm',command:'npx',
      args:['-y','@fixture/mcp']}},arguments:Object.fromEntries(inputs.map(name=>[name,{required:true}]))} as unknown as MarketServer,'1.0.0','fixture-group');
    const plan=await plans.create('alice',manifest);
    const op=await plans.authorize('alice',plan.plan_id,plan.manifest_digest,randomUUID());
    await pool.query(`UPDATE mcp_acquisition_operations SET state=$2,requires_reconciliation=$3,
      failure_code='cancelled_requires_cleanup' WHERE operation_id=$1`,[op.operation_id,state,reconciliation]);
    return op.operation_id as string;
  };
  test('concurrent claims grant one worker and isolate owners and private tokens',async()=>{
    const id=await operation();
    expect(await journal.claim('bob',id)).toBeNull();
    const claims=await Promise.all(Array.from({length:8},()=>journal.claim('alice',id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim=claims.find(Boolean)!;
    await expect(pool.query('UPDATE mcp_acquisition_cleanup SET owner=$2 WHERE operation_id=$1',[id,'bob'])).rejects.toThrow();
    expect(claim.manifest.package.name).toBe('@fixture/mcp');
    expect(await journal.get('bob',id)).toBeNull();
    expect(await journal.get('alice',id)).not.toHaveProperty('cleanup_claim_id');
    expect(await journal.recordStep('bob',id,claim.cleanup_claim_id,'files')).toBe(false);
    expect(await journal.recordStep('alice',id,randomUUID(),'files')).toBe(false);
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets')).toBe(false);
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'files')).toBe(true);
    expect(await journal.get('alice',id)).toMatchObject({status:'running',secrets_removed_at:null});
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets')).toBe(true);
    expect(await journal.get('alice',id)).toMatchObject({status:'complete',review_code:null});
    expect(await journal.claim('alice',id)).toBeNull();
    expect(await journal.requireReview('alice',id,claim.cleanup_claim_id,'cleanup_outcome_unknown')).toBe(false);
    expect((await pool.query('SELECT state,failure_code FROM mcp_acquisition_operations WHERE operation_id=$1',[id])).rows[0])
      .toEqual({state:'failed',failure_code:'cancelled_requires_cleanup'});
  });
  test('cleanup completes only after each reviewed credential has an owner-bound receipt',async()=>{
    const id=await operation('failed',false,['FIRST_KEY','SECOND_KEY']);
    const claim=(await journal.claim('alice',id))!;
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'files')).toBe(true);
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets')).toBe(false);
    expect(await journal.recordSecret('alice',id,claim.cleanup_claim_id,'UNREVIEWED')).toBe(false);
    expect(await journal.recordSecret('bob',id,claim.cleanup_claim_id,'FIRST_KEY')).toBe(false);
    expect(await journal.recordSecret('alice',id,randomUUID(),'FIRST_KEY')).toBe(false);
    expect(await journal.recordSecret('alice',id,claim.cleanup_claim_id,'FIRST_KEY')).toBe(true);
    const firstReceipt=(await pool.query('SELECT secret_receipts FROM mcp_acquisition_cleanup WHERE operation_id=$1',[id])).rows[0].secret_receipts;
    expect(firstReceipt.FIRST_KEY.secret_id).toMatch(/^acq-[a-f0-9]{64}$/);
    expect(await journal.recordSecret('alice',id,claim.cleanup_claim_id,'FIRST_KEY')).toBe(true);
    expect((await pool.query('SELECT secret_receipts FROM mcp_acquisition_cleanup WHERE operation_id=$1',[id])).rows[0].secret_receipts)
      .toEqual(firstReceipt);
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets')).toBe(false);
    expect(await journal.recordSecret('alice',id,claim.cleanup_claim_id,'SECOND_KEY')).toBe(true);
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets')).toBe(true);
    expect(await journal.get('alice',id)).toMatchObject({status:'complete'});
    expect(await journal.get('alice',id)).not.toHaveProperty('secret_receipts');
    expect(await journal.recordSecret('alice',id,claim.cleanup_claim_id,'SECOND_KEY')).toBe(false);
  });
  test.each([false,true])('coordinator persists credential outcomes under real settings/index guards (partial=%s)',async partial=>{
    const id=await operation('failed',false,['FIRST_KEY','SECOND_KEY']);
    const pass=async(_identity:unknown,work:()=>Promise<void>)=>work();
    const deleted:string[]=[];
    const deps={journal,inspect:async()=>({id,verification:'cleanup_preflight',directory:`C:\\data\\acquisitions\\${id}`}),
      drain:async()=>{},withSettings:(target:any,work:()=>Promise<void>)=>withPostgresCleanupSettings(settingsDb,target,work),
      withRuntime:pass,withIndex:(names:readonly string[],work:()=>Promise<void>)=>withCleanupIndexGuard(settingsDb,names,work),withNative:pass,
      // Native effects are fixtures: this test proves coordination and database receipts, not deletion.
      removePackage:async(identity:any)=>({...identity,verification:'cleanup_complete'}),
      deleteSecret:async(secret:string)=>{if(partial&&deleted.length===1)throw new Error('unknown native outcome');deleted.push(secret);return {ok:true};}};
    expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe(partial?'review_required':'complete');
    const state=await journal.get('alice',id);
    expect(state.status).toBe(partial?'review_required':'complete');
    const receipts=(await pool.query('SELECT secret_receipts FROM mcp_acquisition_cleanup WHERE operation_id=$1',[id])).rows[0].secret_receipts;
    expect(Object.values(receipts).map((receipt:any)=>receipt.secret_id)).toEqual(deleted);
    expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('not_claimed');
    expect(deleted).toHaveLength(partial?1:2);
  });
  test('active, ready, uncertain and unrolled-back publications cannot claim cleanup',async()=>{
    for(const state of ['authorized','staging','starting','verifying','ready'])
      expect(await journal.claim('alice',await operation(state))).toBeNull();
    expect(await journal.claim('alice',await operation('failed',true))).toBeNull();
    const id=await operation();
    await pool.query(`UPDATE mcp_acquisition_operations SET publication='{}'::jsonb WHERE operation_id=$1`,[id]);
    expect(await journal.claim('alice',id)).toBeNull();
    await pool.query(`UPDATE mcp_acquisition_operations SET rollback_digest=$2,state='rolled_back' WHERE operation_id=$1`,[id,'a'.repeat(64)]);
    expect(await journal.claim('alice',id)).not.toBeNull();
  });
  test('uncertain cleanup retains partial evidence and permanently fences that worker',async()=>{
    const id=await operation();const claim=(await journal.claim('alice',id))!;
    await journal.recordStep('alice',id,claim.cleanup_claim_id,'files');
    expect(await journal.requireReview('alice',id,claim.cleanup_claim_id,'cleanup_outcome_unknown')).toBe(true);
    expect(await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets')).toBe(false);
    expect(await journal.claim('alice',id)).toBeNull();
    expect(await journal.get('alice',id)).toMatchObject({status:'review_required',review_code:'cleanup_outcome_unknown',
      files_removed_at:expect.any(Date),secrets_removed_at:null});
    await expect(pool.query(`UPDATE mcp_acquisition_cleanup SET status='complete',review_code=NULL WHERE operation_id=$1`,[id])).rejects.toThrow();
  });
  test('additive receipt migration preserves existing completed cleanup rows',async()=>{
    const id=await operation(); const claim=(await journal.claim('alice',id))!;
    await journal.recordStep('alice',id,claim.cleanup_claim_id,'files');
    await journal.recordStep('alice',id,claim.cleanup_claim_id,'secrets');
    // Only this suite's isolated owned schema is modified to emulate the older table.
    await pool.query('ALTER TABLE mcp_acquisition_cleanup DROP COLUMN secret_receipts');
    await ensureMcpAcquisitionSchema({query:async(sql:string,args?:any[])=>{const result=await pool.query(sql,args);return result.rows;}});
    expect(await journal.get('alice',id)).toMatchObject({status:'complete'});
    expect((await pool.query('SELECT secret_receipts FROM mcp_acquisition_cleanup WHERE operation_id=$1',[id])).rows[0].secret_receipts).toEqual({});
  });
  test('settings adoption is blocked and concurrent writes wait for the complete guarded operation',async()=>{
    const id=randomUUID(),secret='acq-'+'a'.repeat(64);
    const target={operationId:id,directory:`C:\\data\\acquisitions\\${id}`,secretIds:[secret]};
    const stored=settingsDb.getRepository(Server);
    const adopted=await stored.save(stored.create({name:'renamed-disabled',enabled:false,nativeSecretRefs:{TOKEN:secret}}));
    const work=jest.fn();
    await expect(withPostgresCleanupSettings(settingsDb,target,work)).rejects.toThrow('references');
    expect(work).not.toHaveBeenCalled();
    await stored.delete(adopted.id);
    await stored.save(stored.create({name:'unrelated',enabled:false}));
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const inside=new Promise<void>(resolve=>{entered=resolve;});
    const guarded=withPostgresCleanupSettings(settingsDb,target,async()=>{entered();await waiting;});
    const writer=await pool.connect();
    try{
      await inside;
      await writer.query("SET lock_timeout='100ms'");
      await expect(writer.query("UPDATE servers SET name=name WHERE name='unrelated'")).rejects.toMatchObject({code:'55P03'});
    }finally{release();await guarded;await writer.query("SET lock_timeout='0'");writer.release();}
    expect((await stored.find()).map(server=>server.name)).toEqual(['unrelated']);
  },10000);
});
