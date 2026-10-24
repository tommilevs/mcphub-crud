import type {ToolResultRepository} from './toolResultHistoryService.js';
import type {ToolResultRecord} from '../types/toolResult.js';
export interface ResultMemoryScope {
  username?:string;
  keyId?:string;
  isAllowed:(record:ToolResultRecord)=>Promise<boolean>;
}
export type ResultMemoryReadName='get_tool_result'|'get_tool_result_range'|'pin_tool_result'|'unpin_tool_result';
const MAX_READ_BYTES=65536;
const text=(value:string,isError=false)=>({content:[{type:'text' as const,text:value}],...(isError?{isError:true}:{})});
const failure=(message:string)=>text(message,true);
/** Caller identity and route visibility are injected by the MCP request handler, never tool arguments. */
export async function readStoredToolResult(
  repository:Pick<ToolResultRepository,'findById'|'incrementUseCount'|'setPinned'>,
  scope:ResultMemoryScope,
  name:ResultMemoryReadName,
  args:Record<string,unknown>,
){
  if(!scope.username&&!scope.keyId)return failure('Authenticated history scope required');
  const id=typeof args.result_id==='string'?args.result_id.trim():'';
  if(!id||id.length>128)return failure('result_id is required');
  try {
    const record=await repository.findById(id);
    if(!record||(scope.username&&record.username!==scope.username)||(scope.keyId&&record.keyId!==scope.keyId)||!await scope.isAllowed(record))return failure('Stored result not found');
    if(name==='pin_tool_result'||name==='unpin_tool_result'){
      const pinned=name==='pin_tool_result';
      const updated=await repository.setPinned(id,pinned);
      return updated?text(JSON.stringify({result_id:id,pinned})):failure('Stored result not found');
    }
    if(!record.payloadAvailable||typeof record.raw!=='string')return failure('RAW payload is unavailable under its capture policy');
    const bytes=Buffer.from(record.raw,'utf8');
    if(name==='get_tool_result'){
      if(bytes.length>MAX_READ_BYTES)return failure(JSON.stringify({result_id:id,raw_bytes:bytes.length,max_read_bytes:MAX_READ_BYTES,next_tool:'get_tool_result_range'}));
      await repository.incrementUseCount(id).catch(()=>undefined);
      return text(record.raw);
    }
    if(name!=='get_tool_result_range')return failure('Unknown result memory operation');
    const {start,end}=args;
    if(typeof start!=='number'||typeof end!=='number'||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>bytes.length||end-start>MAX_READ_BYTES)return failure('Invalid byte range; use an end-exclusive range of at most 65536 bytes');
    const data=bytes.subarray(start,end).toString('base64');
    await repository.incrementUseCount(id).catch(()=>undefined);
    return text(JSON.stringify({result_id:id,start,end,total_bytes:bytes.length,raw_sha256:record.rawSha256,encoding:'base64',data}));
  }catch{return failure('Stored result is temporarily unavailable');}
}

export const RESULT_MEMORY_READ_NAMES = new Set<ResultMemoryReadName>(['get_tool_result','get_tool_result_range','pin_tool_result','unpin_tool_result']);
export const resultMemoryReadDefinitions = () => [...RESULT_MEMORY_READ_NAMES].map(name=>({
  name,
  description: name==='get_tool_result'?'Read immutable stored RAW by result_id without executing the original tool; use byte ranges above 65536 bytes.':name==='get_tool_result_range'?'Read an end-exclusive byte range of stored RAW (maximum 65536 bytes), encoded as base64 for exact reconstruction.':name==='pin_tool_result'?'Pin an owned stored result against automatic retention.':'Remove the pin from an owned stored result.',
  inputSchema:{type:'object',properties:{result_id:{type:'string',format:'uuid'},...(name==='get_tool_result_range'?{start:{type:'integer',minimum:0},end:{type:'integer',minimum:1}}:{})},required:name==='get_tool_result_range'?['result_id','start','end']:['result_id'],additionalProperties:false},
  annotations:{readOnlyHint:name==='get_tool_result'||name==='get_tool_result_range',destructiveHint:false},
}));
