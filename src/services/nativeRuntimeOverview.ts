import {getServerDao} from '../dao/DaoFactory.js';
import type {NativeExecution} from '../types/index.js';
import {normalizeNativeExecution} from '../utils/nativeExecution.js';
import {getNativeRuntimeStatus} from './nativeRuntimeSecretService.js';

/** Only configured user sessions are queried; no session or pipe enumeration. */
export async function getNativeRuntimeOverview(){
 const machine=await getNativeRuntimeStatus();
 const processes:Array<Record<string,unknown>>=(Array.isArray(machine)?machine:machine.processes as Record<string,unknown>[]??[])
   .map(row=>({...row,executionContext:{kind:'service'}}));
 const contexts=new Map<string,NativeExecution>();
 let configurationAvailable=true;
 const servers=await getServerDao().findAll().catch(()=>{configurationAvailable=false;return [];});
 for(const server of servers){
  if(!server.command||(server.type&&server.type!=='stdio'))continue;
  try{
   const execution=normalizeNativeExecution(server.options?.nativeExecution);
   if(execution?.kind!=='interactive')continue;
   const key=`${execution.sessionId}:${execution.pipeName??`mcphub-user-session-${execution.sessionId}`}`;
   if(!contexts.has(key))contexts.set(key,execution);
  }catch{/* Invalid legacy configuration must not hide healthy processes. */}
 }
 const agents:Array<{executionContext:NativeExecution;available:boolean;error?:string}>=[];
 const targets=[...contexts.values()];
 // Bound concurrent pipe connections, while retaining every configured target.
 for(let offset=0;offset<targets.length;offset+=4){
  const batch=await Promise.all(targets.slice(offset,offset+4).map(async executionContext=>{
   try{
    const status=await getNativeRuntimeStatus(executionContext);
    if(!Array.isArray(status.processes))throw Error('Invalid agent status');
    return {executionContext,available:true,processes:status.processes as Record<string,unknown>[]};
   }catch{return {executionContext,available:false,processes:[]};}
  }));
  for(const agent of batch){
   agents.push({executionContext:agent.executionContext,available:agent.available,...(!agent.available?{error:'User agent unavailable'}:{})});
   processes.push(...agent.processes.map(row=>({...row,executionContext:agent.executionContext})));
  }
 }
 return {...(Array.isArray(machine)?{}:machine),processes,agents,configurationAvailable};
}
