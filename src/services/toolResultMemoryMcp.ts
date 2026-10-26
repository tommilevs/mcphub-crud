import type {ToolResultRepository} from './toolResultHistoryService.js';
import type {ToolResultRecord,ToolResultFilter} from '../types/toolResult.js';
export interface ResultMemoryScope {
  servers?:string[];
  username?:string;
  keyId?:string;
  /** Verified stateful MCP transport session; never taken from tool arguments. */
  sessionId?:string;
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
  if(!scope.username&&!scope.keyId&&!scope.sessionId)return failure('Authenticated history scope required');
  const id=typeof args.result_id==='string'?args.result_id.trim():'';
  if(!id||id.length>128)return failure('result_id is required');
  try {
    const record=await repository.findById(id);
    if(!record||!withinOwner(record,scope)||!await scope.isAllowed(record))return failure('Stored result not found');
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

export type ResultMemorySearchName='search_tool_result'|'search_tool_results';
export const RESULT_MEMORY_SEARCH_NAMES=new Set<string>(['search_tool_result','search_tool_results']);
const withinOwner=(record:ToolResultRecord,scope:ResultMemoryScope)=>
  (scope.username||scope.keyId
    ? (!scope.username||record.username===scope.username)&&(!scope.keyId||record.keyId===scope.keyId)
    : !!scope.sessionId&&!record.username&&!record.keyId&&record.sessionId===scope.sessionId)
  &&(!scope.servers||scope.servers.includes(record.server));
const boundedSearchResult=(values:unknown[],extra:Record<string,unknown>)=>{
  const results:unknown[]=[];
  for(const value of values){
    if(Buffer.byteLength(JSON.stringify({...extra,results:[...results,value],partial:true}))>MAX_READ_BYTES)break;
    results.push(value);
  }
  return text(JSON.stringify({...extra,results,partial:results.length<values.length}));
};
export async function searchStoredToolResults(
  repository:ToolResultRepository,scope:ResultMemoryScope,name:ResultMemorySearchName,
  args:Record<string,unknown>,embed:(query:string)=>Promise<number[]|null>,
){
  if(!scope.username&&!scope.keyId&&!scope.sessionId)return failure('Authenticated history scope required');
  const query=typeof args.query==='string'?args.query.trim():'';
  const limit=args.limit===undefined?10:args.limit;
  if(!query||query.length>2000||typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>20)return failure('query is required (maximum 2000 characters); limit must be 1 through 20');
  try {
    let embedding:number[]|null=null;
    const generate=async()=>{try{embedding=await embed(query);}catch{embedding=null;}};
    if(name==='search_tool_result'){
      const id=typeof args.result_id==='string'?args.result_id.trim():'';
      if(!id||id.length>128||!repository.searchChunks)return failure('Stored result chunk search is unavailable');
      const record=await repository.findById(id);
      if(!record||!withinOwner(record,scope)||!await scope.isAllowed(record))return failure('Stored result not found');
      if(!record.payloadAvailable)return failure('RAW payload is unavailable under its capture policy');
      await generate();
      const hits=await repository.searchChunks(id,query,embedding,limit);
      await repository.incrementUseCount(id).catch(()=>undefined);
      return boundedSearchResult(hits.map(hit=>({result_id:id,chunk_index:hit.chunkIndex,chunk_version:hit.chunkVersion,content:hit.content,score:hit.retrievalScore})),{result_id:id,mode:embedding?'hybrid':'lexical'});
    }
    const rawFilters=args.filters;
    if(rawFilters!==undefined&&(!rawFilters||typeof rawFilters!=='object'||Array.isArray(rawFilters)))return failure('Invalid history filters');
    const sessionScoped=!scope.username&&!scope.keyId;
    const filter:ToolResultFilter={...(scope.username?{username:scope.username}:{}),...(scope.keyId?{keyId:scope.keyId}:{}),...(scope.servers?{servers:scope.servers}:{}),...(sessionScoped?{sessionId:scope.sessionId}:{})};
    const permitted=new Set(['server','tool','status','sessionId','conversationId','modelId','taskId','traceId','branchId']);
    for(const [key,value] of Object.entries(rawFilters??{})){
      if(!permitted.has(key)||typeof value!=='string'||!value||value.length>255)return failure('Invalid history filter');
      if(key==='status'&&!['success','error'].includes(value))return failure('Invalid history status');
      if(sessionScoped&&key==='sessionId'&&value!==scope.sessionId)return failure('Invalid history session scope');
      Object.assign(filter,{[key]:value});
    }
    if(scope.servers&&(scope.servers.length===0||(filter.server&&!scope.servers.includes(filter.server))))return boundedSearchResult([],{mode:'lexical'});
    await generate();
    let rows:ToolResultRecord[]=[];
    let mode:'hybrid'|'lexical'='lexical';
    if(repository.hybridSearch){
      try{rows=await repository.hybridSearch(query,embedding,limit,filter);if(embedding)mode='hybrid';}catch{rows=[];}
    }
    if(!rows.length){rows=await repository.search(query,limit,filter);mode='lexical';}
    const values:unknown[]=[];const seen=new Set<string>();
    for(const record of rows){
      if(seen.has(record.resultId)||!withinOwner(record,scope)||!await scope.isAllowed(record))continue;
      seen.add(record.resultId);
      values.push({result_id:record.resultId,timestamp:record.timestamp,server:record.server,tool:record.tool,status:record.status,objective:record.objective?.slice(0,1000),raw_bytes:record.rawBytes,payload_available:record.payloadAvailable,pinned:record.pinned});
      if(values.length===limit)break;
    }
    return boundedSearchResult(values,{mode});
  }catch{return failure('Stored result search is temporarily unavailable');}
}
export const resultMemorySearchDefinitions=()=>[...RESULT_MEMORY_SEARCH_NAMES].map(name=>({
  name,
  description:name==='search_tool_result'?'Search existing chunks within one owned stored result by result_id and query, without rerunning its tool.':'Search your stored result history by query and optional filters. Returns bounded metadata, not RAW.',
  inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:2000},limit:{type:'integer',minimum:1,maximum:20},...(name==='search_tool_result'?{result_id:{type:'string',format:'uuid'}}:{filters:{type:'object',properties:Object.fromEntries(['server','tool','status','sessionId','conversationId','modelId','taskId','traceId','branchId'].map(key=>[key,{type:'string',maxLength:255}])),additionalProperties:false}})},required:name==='search_tool_result'?['result_id','query']:['query'],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false},
}));

export const RESULT_MEMORY_TOOL_NAMES=new Set<string>([...RESULT_MEMORY_READ_NAMES,...RESULT_MEMORY_SEARCH_NAMES]);
