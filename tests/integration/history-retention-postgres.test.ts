import {randomUUID,createHash} from 'node:crypto';
import {Client} from 'pg';
import {ensureAttributionContextSchema} from '../../src/db/attributionContextSchema.js';
import {ensureToolResultHistorySchema} from '../../src/db/toolResultHistorySchema.js';
import {ToolResultRepositoryDb} from '../../src/db/repositories/ToolResultRepository.js';
import {ToolResultHistoryService} from '../../src/services/toolResultHistoryService.js';
const suite=process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD?describe:describe.skip;
suite('production history schema on disposable PostgreSQL',()=>{
 const schema='history_retention_'+randomUUID().replaceAll('-','');
 let db:Client,repository:ToolResultRepositoryDb,history:ToolResultHistoryService,created=false;
 beforeAll(async()=>{
  db=new Client({host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST,port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT||5432),user:process.env.MCPHUB_ATTRIBUTION_TEST_USER,password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,database:process.env.MCPHUB_ATTRIBUTION_TEST_DB||'postgres',connectionTimeoutMillis:5000});
  await db.connect();await db.query(`CREATE SCHEMA ${schema}`);created=true;await db.query(`SET search_path TO ${schema},public`);
  const adapter={query:async(sql:string,args?:unknown[])=>(await db.query(sql,args)).rows};
  await ensureAttributionContextSchema(adapter);await ensureToolResultHistorySchema(adapter);await ensureToolResultHistorySchema(adapter);
  repository=new ToolResultRepositoryDb(adapter);history=new ToolResultHistoryService(repository);
 });
 afterAll(async()=>{if(db){try{if(created){await db.query(`DROP SCHEMA ${schema} CASCADE`);expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);}}finally{await db.end();}}});
 beforeEach(async()=>{await db.query('TRUNCATE tool_results CASCADE');});
 const capture=(username:string)=>history.capture({server:'fixture',tool:'read',durationMs:1,status:'success',username,result:{content:[{type:'text',text:'immutable 😀\r\nXid 79'}]}});
 it('enforces RAW immutability while permitting independent pin and usage state',async()=>{
  const saved=(await capture('alice'))!;
  expect(saved.rawSha256).toBe(createHash('sha256').update(saved.raw!).digest('hex'));
  await expect(db.query('UPDATE tool_results SET raw=$2 WHERE result_id=$1',[saved.resultId,'changed'])).rejects.toThrow('immutable');
  await repository.setPinned(saved.resultId,true);await repository.incrementUseCount(saved.resultId);
  const reopened=await repository.findById(saved.resultId);
  expect(reopened).toMatchObject({raw:saved.raw,rawSha256:saved.rawSha256,pinned:true,useCount:1});
 });
 it('keeps 10000 recent owner results plus pins and cascades expired indexes without affecting another owner',async()=>{
  const other=(await capture('bob'))!;
  const pinned=await repository.create({...other,resultId:randomUUID(),timestamp:new Date('2000-01-01T00:00:00Z'),username:'alice',pinned:false,useCount:0});
  await repository.setPinned(pinned.resultId,true);
  const raw='{"content":[{"type":"text","text":"evidence"}]}';
  await db.query(`WITH inserted AS (
   INSERT INTO tool_results(result_id,timestamp,server,tool,duration_ms,status,username,raw,raw_text,raw_bytes,raw_sha256)
   SELECT md5('history-alice-'||i)::uuid,'2026-10-24'::timestamptz+i*INTERVAL '1 second','fixture','read',1,'success','alice',$1,'evidence',$2,$3 FROM generate_series(1,10005) i RETURNING result_id
  ) INSERT INTO tool_result_state(result_id) SELECT result_id FROM inserted`,[raw,Buffer.byteLength(raw),createHash('sha256').update(raw).digest('hex')]);
  const oldest=(await db.query("SELECT md5('history-alice-1')::uuid AS id")).rows[0].id;
  await db.query(`INSERT INTO tool_result_chunks(result_id,chunk_index,chunk_version,content,embedding)
    SELECT result_id,0,1,raw_text,'[1,0,0]'::vector FROM tool_results WHERE username='alice' AND raw_text='evidence'`);
  const start=Date.now();expect(await repository.enforceRetention(10000,'alice')).toBe(5);
  expect((await db.query("SELECT count(*)::int AS count FROM tool_results result JOIN tool_result_state state USING(result_id) WHERE username='alice' AND NOT pinned")).rows[0].count).toBe(10000);
  expect((await repository.findById(pinned.resultId))?.pinned).toBe(true);expect(await repository.findById(other.resultId)).not.toBeNull();
  expect((await db.query('SELECT 1 FROM tool_result_chunks WHERE result_id=$1',[oldest])).rowCount).toBe(0);
  console.info('10k retention elapsed milliseconds:',Date.now()-start);
  const queryStart=Date.now();
  const hits=await repository.hybridSearch('evidence',[1,0,0],20,{username:'alice'});
  expect(hits).toHaveLength(20);expect(new Set(hits.map(hit=>hit.resultId)).size).toBe(20);
  expect(hits.every(hit=>hit.username==='alice'&&hit.raw===raw)).toBe(true);
  console.info('10k indexed hybrid search elapsed milliseconds:',Date.now()-queryStart);
  const finalPage=await repository.findPaginated(501,20,{username:'alice'});
  expect(finalPage).toMatchObject({total:10001,totalPages:501});
  expect(finalPage.data.map(result=>result.resultId)).toEqual([pinned.resultId]);
 });
});
