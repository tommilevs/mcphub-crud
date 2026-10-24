import {readStoredToolResult,searchStoredToolResults} from '../../src/services/toolResultMemoryMcp.js';
const repository=()=>({findById:jest.fn(),incrementUseCount:jest.fn().mockResolvedValue(undefined),setPinned:jest.fn(),search:jest.fn().mockResolvedValue([]),hybridSearch:jest.fn(),searchChunks:jest.fn()});
const raw=JSON.stringify({content:[{type:'text',text:'A😀B'}]});
const record={resultId:'id',username:'alice',keyId:'key-a',raw,rawBytes:Buffer.byteLength(raw),rawSha256:'digest',payloadAvailable:true,server:'fixture',tool:'read'};
const scope={username:'alice',keyId:'key-a',isAllowed:async()=>true};
it('returns exact stored RAW without invoking a tool',async()=>{
 const db=repository();db.findById.mockResolvedValue(record);
 const result=await readStoredToolResult(db as never,scope,'get_tool_result',{result_id:'id'});
 expect(result.content[0].text).toBe(raw);
 expect(db.incrementUseCount).toHaveBeenCalledWith('id');
});
it.each([{...scope,username:'bob'},{...scope,keyId:'foreign'},{isAllowed:async()=>true},{...scope,isAllowed:async()=>false}])('denies foreign, unknown or unavailable scopes',async access=>{
 const db=repository();db.findById.mockResolvedValue(record);
 const result=await readStoredToolResult(db as never,access,'get_tool_result',{result_id:'id'});
 expect(result.isError).toBe(true);expect(JSON.stringify(result)).not.toContain(raw);expect(db.incrementUseCount).not.toHaveBeenCalled();
});
it('returns exact bytes even when a range cuts a Unicode sequence',async()=>{
 const db=repository();db.findById.mockResolvedValue(record);
 const start=Buffer.from(raw).indexOf(Buffer.from('😀'))+1;
 const result=await readStoredToolResult(db as never,scope,'get_tool_result_range',{result_id:'id',start,end:start+2});
 const body=JSON.parse(result.content[0].text);
 expect(Buffer.from(body.data,'base64')).toEqual(Buffer.from(raw).subarray(start,start+2));
});
it('refuses metadata-only payloads without incrementing usage',async()=>{
 const db=repository();db.findById.mockResolvedValue({...record,payloadAvailable:false,raw:null});
 const result=await readStoredToolResult(db as never,scope,'get_tool_result',{result_id:'id'});
 expect(result.isError).toBe(true);expect(db.incrementUseCount).not.toHaveBeenCalled();
});

it('bounds full reads and points large results to range retrieval',async()=>{
 const db=repository();db.findById.mockResolvedValue({...record,raw:'x'.repeat(65537)});
 const result=await readStoredToolResult(db as never,scope,'get_tool_result',{result_id:'id'});
 expect(result.isError).toBe(true);expect(JSON.parse(result.content[0].text).next_tool).toBe('get_tool_result_range');
 expect(db.incrementUseCount).not.toHaveBeenCalled();
});
it.each(['pin_tool_result','unpin_tool_result'] as const)('updates only pin state for %s',async name=>{
 const db=repository();db.findById.mockResolvedValue(record);db.setPinned.mockResolvedValue(record);
 const result=await readStoredToolResult(db as never,scope,name,{result_id:'id'});
 expect(db.setPinned).toHaveBeenCalledWith('id',name==='pin_tool_result');
 expect(JSON.stringify(result)).not.toContain(raw);expect(db.incrementUseCount).not.toHaveBeenCalled();
});
it('returns RAW even if the optional use counter cannot be updated',async()=>{
 const db=repository();db.findById.mockResolvedValue(record);db.incrementUseCount.mockRejectedValue(new Error('counter failure'));
 expect((await readStoredToolResult(db as never,scope,'get_tool_result',{result_id:'id'})).content[0].text).toBe(raw);
});

it('scopes history search to the authenticated owner and key and omits RAW',async()=>{
 const db=repository();db.hybridSearch.mockResolvedValue([record,{...record,resultId:'foreign',username:'bob'}]);
 const response=await searchStoredToolResults(db as never,{...scope,servers:['fixture']},'search_tool_results',{query:'evidence',filters:{server:'fixture'}},async()=>[1,0]);
 expect(db.hybridSearch).toHaveBeenCalledWith('evidence',[1,0],10,{username:'alice',keyId:'key-a',servers:['fixture'],server:'fixture'});
 const data=JSON.parse(response.content[0].text);
 expect(data.results.map((row:{result_id:string})=>row.result_id)).toEqual(['id']);
 expect(JSON.stringify(data)).not.toContain('foreign');expect(JSON.stringify(data)).not.toContain(raw);
});
it('searches authorized chunks with lexical fallback when embeddings fail',async()=>{
 const db=repository();db.findById.mockResolvedValue(record);db.searchChunks.mockResolvedValue([{resultId:'id',chunkIndex:0,content:'needle'}]);
 const response=await searchStoredToolResults(db as never,scope,'search_tool_result',{result_id:'id',query:'needle'},async()=>{throw Error('provider unavailable');});
 expect(db.searchChunks).toHaveBeenCalledWith('id','needle',null,10);
 expect(JSON.parse(response.content[0].text).results[0].content).toBe('needle');
 expect(db.incrementUseCount).toHaveBeenCalledWith('id');
});
it('does not search a foreign result or accept owner filters from arguments',async()=>{
 const db=repository();db.findById.mockResolvedValue({...record,username:'bob'});
 expect((await searchStoredToolResults(db as never,scope,'search_tool_result',{result_id:'id',query:'needle'},async()=>[1])).isError).toBe(true);
 expect((await searchStoredToolResults(db as never,scope,'search_tool_results',{query:'needle',filters:{username:'bob'}},async()=>[1])).isError).toBe(true);
 expect(db.searchChunks).not.toHaveBeenCalled();expect(db.hybridSearch).not.toHaveBeenCalled();
});
