import {readStoredToolResult} from '../../src/services/toolResultMemoryMcp.js';
const repository=()=>({findById:jest.fn(),incrementUseCount:jest.fn().mockResolvedValue(undefined),setPinned:jest.fn()});
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
