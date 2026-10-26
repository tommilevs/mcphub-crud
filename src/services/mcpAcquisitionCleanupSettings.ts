import fs from 'node:fs/promises';
import path from 'node:path';
import type {DataSource} from 'typeorm';
import {Server} from '../db/entities/Server.js';
import {withJsonSettingsFileLock} from './jsonSettingsFileLock.js';
import {assertNoCleanupReferences,type CleanupReferenceTarget} from './mcpAcquisitionCleanupReferences.js';

/** Hold the ordinary settings-writer lock across inspection and the caller's
 * native/journal work. Never use a read-only fallback for destructive work. */
export async function withJsonCleanupSettings<T>(settingsPath:string,target:CleanupReferenceTarget,work:()=>Promise<T>,
  resolvePath?: (value:string)=>Promise<string>):Promise<T>{
  const file=path.resolve(settingsPath);
  return withJsonSettingsFileLock(file,async()=>{
    let settings;
    try{settings=JSON.parse(await fs.readFile(file,'utf8'));}
    catch{throw new Error('Cleanup settings identity is unconfirmed');}
    if(!settings||!settings.mcpServers||typeof settings.mcpServers!=='object'||Array.isArray(settings.mcpServers))
      throw new Error('Cleanup settings identity is unconfirmed');
    await assertNoCleanupReferences(Object.entries(settings.mcpServers).map(([name,config])=>({name,config})),target,resolvePath);
    return work();
  });
}

/** Block INSERT/UPDATE/DELETE as well as renames while inspecting all stored
 * configurations. This settings guard does not replace live-runtime checks. */
export async function withPostgresCleanupSettings<T>(db:Pick<DataSource,'transaction'>,target:CleanupReferenceTarget,
  work:()=>Promise<T>,resolvePath?: (value:string)=>Promise<string>):Promise<T>{
  return db.transaction('SERIALIZABLE',async manager=>{
    await manager.query('LOCK TABLE "servers" IN SHARE ROW EXCLUSIVE MODE');
    const servers=await manager.getRepository(Server).find();
    await assertNoCleanupReferences(servers.map(server=>({name:server.name,config:server})),target,resolvePath);
    return work();
  });
}
