const mockIndexChunks=jest.fn().mockResolvedValue(undefined);
const mockEmbedding=jest.fn().mockResolvedValue(null);
const mockRecord={raw:null as string|null,resultId:'fixture',server:'server',tool:'read',rawText:'x'.repeat(100000)+' UNIQUE_TAIL_EVIDENCE'};
const mockFindForReindex=jest.fn(async (_limit?:number,_missing?:boolean,_after?:string)=>[mockRecord]);
const mockCountForReindex=jest.fn(async (_missing?:boolean,_after?:string)=>0);
jest.mock('../../src/services/toolResultHistoryRegistry.js',()=>({getToolResultRepository:()=>({findForReindex:mockFindForReindex,countForReindex:mockCountForReindex,indexChunks:mockIndexChunks})}));
jest.mock('../../src/services/vectorSearchService.js',()=>({generateEmbedding:(...args:unknown[])=>mockEmbedding(...args)}));
import {reindexToolResultHistory,ToolResultHistoryCoordinator} from '../../src/services/toolResultHistoryCoordinator.js';
it.each(['reindex','capture'])('%s indexes the full result while keeping embedding input bounded',async mode=>{
 mockIndexChunks.mockClear();mockEmbedding.mockClear();
 if(mode==='reindex')await reindexToolResultHistory();
 else {
  const coordinator=new ToolResultHistoryCoordinator(()=>({capture:async()=>({...mockRecord,payloadAvailable:true})} as never));
  await coordinator.captureAndAnnotate({content:[]},{server:'server',tool:'read',durationMs:1,status:'success'});
  await new Promise(resolve=>setImmediate(resolve));
 }
 const chunks=mockIndexChunks.mock.calls[0][1];
 expect(chunks.map((chunk:{content:string})=>chunk.content).join('').includes('UNIQUE_TAIL_EVIDENCE')).toBe(true);
 expect(mockEmbedding.mock.calls.reduce((sum,args)=>sum+String(args[0]).length,0)).toBeLessThanOrEqual(64000);
});

it.each(['', 'legacy wrapper'])('reindexes legacy structured RAW without modifying stored text (%s)', async rawText=>{
 const previous={...mockRecord};
 try {
  mockRecord.rawText=rawText;
  mockRecord.raw=JSON.stringify({content:rawText?[{type:'text',text:rawText}]:[],structuredContent:{evidence:'legacy-structured-marker'}});
  const raw=mockRecord.raw;
  mockIndexChunks.mockClear();
  const summary=await reindexToolResultHistory();
  expect(summary.indexed).toBe(1);
  const chunks=mockIndexChunks.mock.calls[0][1];
  expect(chunks.map((chunk:{content:string})=>chunk.content).join('').includes('legacy-structured-marker')).toBe(true);
  expect(mockRecord.raw).toBe(raw);
  expect(mockRecord.rawText).toBe(rawText);
 }finally{Object.assign(mockRecord,previous);}
});

it('continues a full rebuild after its last processed result instead of repeating the first batch',async()=>{
 const rows=[1,2].map(i=>({...mockRecord,resultId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,rawText:'fixture'}));
 mockFindForReindex.mockImplementation(async(limit=1,_missing,after)=>rows.filter(row=>!after||row.resultId>after).slice(0,limit));
 mockCountForReindex.mockImplementation(async(_missing,after)=>rows.filter(row=>!after||row.resultId>after).length);
 mockIndexChunks.mockClear();
 try {
  const first=await reindexToolResultHistory(1,false);
  expect(first.nextCursor).toBe(rows[0].resultId);
  const second=await reindexToolResultHistory(1,false,first.nextCursor);
  expect(second.remaining).toBe(0);
  expect(second.nextCursor).toBeUndefined();
  expect(mockIndexChunks.mock.calls.map(call=>call[0])).toEqual(rows.map(row=>row.resultId));
 }finally{
  mockFindForReindex.mockImplementation(async()=>[mockRecord]);mockCountForReindex.mockImplementation(async()=>0);
 }
});

it('releases the rebuild lock after an index write fails and allows a retry',async()=>{
 const before={...mockRecord};
 mockIndexChunks.mockRejectedValueOnce(new Error('synthetic index write failure'));
 await expect(reindexToolResultHistory()).rejects.toThrow('synthetic index write failure');
 expect(mockRecord).toEqual(before);
 await expect(reindexToolResultHistory()).resolves.toMatchObject({indexed:1});
});
it('keeps all lexical chunks when an embedding request fails',async()=>{
 mockIndexChunks.mockClear();
 mockEmbedding.mockRejectedValueOnce(new Error('synthetic embedding failure'));
 const summary=await reindexToolResultHistory();
 expect(summary).toMatchObject({indexed:1,embeddingFailures:1});
 const chunks=mockIndexChunks.mock.calls[0][1];
 expect(chunks[0].embedding).toBeNull();
 expect(chunks.map((chunk:{content:string})=>chunk.content).join('').includes('UNIQUE_TAIL_EVIDENCE')).toBe(true);
});
it('releases the rebuild lock when candidate selection fails',async()=>{
 mockFindForReindex.mockRejectedValueOnce(new Error('synthetic selection failure'));
 await expect(reindexToolResultHistory()).rejects.toThrow('synthetic selection failure');
 await expect(reindexToolResultHistory()).resolves.toMatchObject({indexed:1});
});
it('rejects an overlapping rebuild while keeping the original pass usable',async()=>{
 let resolve!: (records:typeof mockRecord[])=>void;
 mockFindForReindex.mockImplementationOnce(()=>new Promise(result=>{resolve=result;}));
 const running=reindexToolResultHistory();
 try {await expect(reindexToolResultHistory()).rejects.toThrow('already running');}
 finally {resolve([mockRecord]);}
 await expect(running).resolves.toMatchObject({indexed:1});
});
