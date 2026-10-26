import fs from 'node:fs/promises';
import path from 'node:path';

export interface CleanupReferenceTarget {operationId:string;directory:string;secretIds:readonly string[]}
export interface CleanupReferenceServer {name:string;config:unknown}
type ResolvePath=(value:string)=>Promise<string>;
const normalize=(value:string)=>path.win32.normalize(value.replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'').replace(/\//g,'\\')).toLowerCase().replace(/\\+$/,'');
const absolute=(value:string)=>/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value);

/** Conservative reference check, including disabled/renamed configurations.
 * Call only inside the settings mutation guard, then separately check live
 * runtime/index ownership. This function does not authorize file deletion. */
export async function assertNoCleanupReferences(servers:readonly CleanupReferenceServer[],target:CleanupReferenceTarget,
  resolvePath:ResolvePath=fs.realpath):Promise<void>{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(target.operationId)||
    !absolute(target.directory)||path.win32.basename(normalize(target.directory))!==target.operationId.toLowerCase()||
    target.secretIds.some(id=>!/^acq-[a-f0-9]{64}$/.test(id)))throw new Error('Invalid cleanup reference identity');
  const directory=normalize(target.directory),operation=target.operationId.toLowerCase();
  const secrets=target.secretIds.map(id=>id.toLowerCase());
  for(const server of servers){
    const config=server.config as {cwd?:unknown;options?:{nativeWorkingDirectory?:unknown}}|undefined;
    const cwd=config?.options?.nativeWorkingDirectory??config?.cwd;
    const pending:unknown[]=[server.config];const seen=new Set<object>();
    while(pending.length){
      const value=pending.pop();
      if(value&&typeof value==='object'){
        if(seen.has(value))continue;seen.add(value);pending.push(...Object.values(value));continue;
      }
      if(typeof value!=='string')continue;
      const lower=value.toLowerCase();
      if(lower.includes(operation)||secrets.some(id=>lower.includes(id)))throw new Error('Cleanup references remain in server settings');
      let candidate=value.replace(/^--?[a-z0-9_-]+=/i,'');
      if(!absolute(candidate)&&typeof cwd==='string'&&absolute(cwd)&&!candidate.startsWith('-')&&
        !/^[a-z][a-z0-9+.-]*:/i.test(candidate)&&/[\\/.]/.test(candidate))candidate=path.win32.resolve(cwd,candidate);
      if(!absolute(candidate))continue;
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        const resolved=await Promise.race([resolvePath(candidate),new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('Cleanup reference identity is unconfirmed')),2500);
        })]);
        const canonical=normalize(resolved);
        if(canonical===directory||canonical.startsWith(directory+'\\'))throw new Error('Cleanup references remain through a filesystem alias');
      }catch(error){
        if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))continue;
        if(error instanceof Error&&error.message.startsWith('Cleanup references remain'))throw error;
        throw new Error('Cleanup reference identity is unconfirmed');
      }finally{clearTimeout(timer);}
    }
  }
}
