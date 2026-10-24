const mockIndexChunks=jest.fn().mockResolvedValue(undefined);
const mockEmbedding=jest.fn().mockResolvedValue(null);
const mockRecord={resultId:'fixture',server:'server',tool:'read',rawText:'x'.repeat(100000)+' UNIQUE_TAIL_EVIDENCE'};
jest.mock('../../src/services/toolResultHistoryRegistry.js',()=>({getToolResultRepository:()=>({findForReindex:async()=>[mockRecord],countForReindex:async()=>0,indexChunks:mockIndexChunks})}));
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
