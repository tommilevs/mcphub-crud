import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {ToolResultRepositoryDb} from '../../src/db/repositories/ToolResultRepository.js';
const suite=process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD?describe:describe.skip;
suite('history retrieval PostgreSQL isolation',()=>{
 const schema='history_search_'+randomUUID().replaceAll('-','');
 let db:Client;
 let schemaCreated=false;
 let repository:ToolResultRepositoryDb;
 beforeAll(async()=>{
  db=new Client({host:process.env.MCPHUB_ATTRIBUTION_TEST_HOST,port:Number(process.env.MCPHUB_ATTRIBUTION_TEST_PORT||5432),user:process.env.MCPHUB_ATTRIBUTION_TEST_USER,password:process.env.MCPHUB_ATTRIBUTION_TEST_PASSWORD,database:process.env.MCPHUB_ATTRIBUTION_TEST_DB||'postgres',connectionTimeoutMillis:5000});
  await db.connect();await db.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;await db.query(`SET search_path TO ${schema},public`);
  await db.query(`CREATE TABLE tool_results(result_id uuid PRIMARY KEY,timestamp timestamptz DEFAULT now(),username text,server text DEFAULT 'fixture',tool text DEFAULT 'read',status text DEFAULT 'success');CREATE TABLE tool_result_state(result_id uuid PRIMARY KEY,pinned boolean DEFAULT false,use_count integer DEFAULT 0,last_referenced_at timestamptz);CREATE TABLE tool_result_chunks(result_id uuid,chunk_index integer DEFAULT 0,chunk_version integer DEFAULT 1,content text,embedding vector(3),PRIMARY KEY(result_id,chunk_index,chunk_version))`);
  repository=new ToolResultRepositoryDb({query:async(sql,args)=>(await db.query(sql,args)).rows} as never);
 });
 afterAll(async()=>{if(db){try{if(schemaCreated){await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);}}finally{await db.end();}}});
 beforeEach(async()=>{await db.query('TRUNCATE tool_result_chunks,tool_result_state,tool_results');});
 async function add(owner:string,chunks:string[],vector='[1,0,0]'){
  const id=randomUUID();await db.query('INSERT INTO tool_results(result_id,username) VALUES($1,$2)',[id,owner]);await db.query('INSERT INTO tool_result_state(result_id) VALUES($1)',[id]);for(const [index,content] of chunks.entries())await db.query('INSERT INTO tool_result_chunks(result_id,chunk_index,content,embedding) VALUES($1,$2,$3,$4::vector)',[id,index,content,vector]);return id;
 }
 it('returns each result once despite multiple matching chunks',async()=>{
  const first=await add('alice',['needle','needle']);const second=await add('alice',['needle']);
  const hits=await repository.hybridSearch('needle',[1,0,0],10,{username:'alice'});
  expect(hits.map(h=>h.resultId).sort()).toEqual([first,second].sort());
 });
 it('applies owner filters before candidate limits',async()=>{
  await db.query("WITH created AS (INSERT INTO tool_results(result_id,username) SELECT md5('foreign-'||i)::uuid,'bob' FROM generate_series(1,105) i RETURNING result_id), states AS (INSERT INTO tool_result_state(result_id) SELECT result_id FROM created) INSERT INTO tool_result_chunks(result_id,content,embedding) SELECT result_id,'needle needle needle','[1,0,0]'::vector FROM created");
  const own=await add('alice',['needle '+Array(100).fill('padding').join(' ')],'[0,1,0]');
  const hits=await repository.hybridSearch('needle',[1,0,0],10,{username:'alice'});
  expect(hits.map(h=>h.resultId)).toEqual([own]);
 });
 it('preserves the previous complete index when a replacement chunk is invalid',async()=>{
  const id=await add('alice',['old-first','old-second']);
  await expect(repository.indexChunks(id,[
   {chunkIndex:0,chunkVersion:1,content:'new-first',embedding:[1,0,0]},
   {chunkIndex:1,chunkVersion:1,content:'invalid',embedding:[1,0]},
  ])).rejects.toThrow();
  expect((await db.query('SELECT content FROM tool_result_chunks WHERE result_id=$1 ORDER BY chunk_index',[id])).rows.map(row=>row.content)).toEqual(['old-first','old-second']);
 });

});
