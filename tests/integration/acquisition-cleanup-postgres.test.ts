import {randomUUID} from 'node:crypto';
import {Client,Pool} from 'pg';
import {ensureMcpAcquisitionSchema} from '../../src/db/mcpAcquisitionSchema.js';
import {AcquisitionPlanRepository,buildAcquisitionManifest} from '../../src/services/mcpAcquisitionPlan.js';
import {AcquisitionCleanupJournal} from '../../src/services/mcpAcquisitionCleanupJournal.js';
import type {MarketServer} from '../../src/types/index.js';

const suite=process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD?describe:describe.skip;
suite('owned acquisition cleanup journal in PostgreSQL',()=>{
  const schema=`cleanup_${randomUUID().replace(/-/g,'')}`;
  let admin:Client,pool:Pool,journal:AcquisitionCleanupJournal,plans:AcquisitionPlanRepository;
  beforeAll(async()=>{
    const config={host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST??'127.0.0.1',
      port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT??5432),user:process.env.MCPHUB_ATTRIBUTION_TEST_USER??'postgres',
      password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,database:process.env.MCPHUB_ATTRIBUTION_TEST_DB??'mcphub_history_test'};
    admin=new Client(config);await admin.connect();await admin.query(`CREATE SCHEMA ${schema}`);
    pool=new Pool({...config,options:`-c search_path=${schema},public`});
    const db={query:async(sql:string,args?:any[])=>(await pool.query(sql,args)).rows};
    await ensureMcpAcquisitionSchema(db);await ensureMcpAcquisitionSchema(db);
    journal=new AcquisitionCleanupJournal(db);plans=new AcquisitionPlanRepository(db);
  });
  afterAll(async()=>{
    if(pool)await pool.end();
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
  });
  const operation=async(state='failed',reconciliation=false)=>{
    const manifest=buildAcquisitionManifest({name:'cleanup-fixture',installations:{npm:{type:'npm',command:'npx',
      args:['-y','@fixture/mcp']}},arguments:{}} as unknown as MarketServer,'1.0.0','fixture-group');
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
});
