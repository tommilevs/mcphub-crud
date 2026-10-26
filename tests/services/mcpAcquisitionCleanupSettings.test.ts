import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AsyncResource} from 'node:async_hooks';
import {withJsonCleanupSettings,withPostgresCleanupSettings} from '../../src/services/mcpAcquisitionCleanupSettings.js';
import {withJsonSettingsFileLock} from '../../src/services/jsonSettingsFileLock.js';
const id='00000000-0000-4000-8000-000000000001',secret='acq-'+'a'.repeat(64);
const target={operationId:id,directory:`C:\\data\\acquisitions\\${id}`,secretIds:[secret]};
const absent=async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});};

test('JSON adoption prevents work and the lock survives until asynchronous work settles',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcphub-cleanup-settings-'));
  const file=path.join(root,'settings.json'),work=jest.fn();
  const foreign=new AsyncResource('independent-cleanup-settings-writer');
  try{
    fs.writeFileSync(file,JSON.stringify({mcpServers:{renamed:{enabled:false,nativeSecretRefs:{TOKEN:secret}}}}));
    await expect(withJsonCleanupSettings(file,target,work,absent)).rejects.toThrow('references');
    expect(work).not.toHaveBeenCalled();
    fs.writeFileSync(file,'{"mcpServers":{"synthetic-private-value":');
    await expect(withJsonCleanupSettings(file,target,work,absent)).rejects.toThrow('identity is unconfirmed');
    fs.writeFileSync(file,JSON.stringify({mcpServers:{}}));
    let release!:()=>void,entered!:()=>void;
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const inside=new Promise<void>(resolve=>{entered=resolve;});
    const operation=withJsonCleanupSettings(file,target,async()=>{entered();await waiting;return 'done';},absent);
    await inside;
    expect(()=>foreign.runInAsyncScope(()=>withJsonSettingsFileLock(file,()=>true))).toThrow('busy');
    release();expect(await operation).toBe('done');
    expect(foreign.runInAsyncScope(()=>withJsonSettingsFileLock(file,()=>true))).toBe(true);
  }finally{
    foreign.emitDestroy();
    expect(root.startsWith(path.join(os.tmpdir(),'mcphub-cleanup-settings-'))).toBe(true);
    fs.rmSync(root,{recursive:true});expect(fs.existsSync(root)).toBe(false);
  }
});

test('PostgreSQL locks settings before checking disabled or renamed adoption',async()=>{
  const query=jest.fn().mockResolvedValue([]),work=jest.fn();
  const manager={query,getRepository:()=>({find:async()=>[{name:'renamed',enabled:false,nativeSecretRefs:{TOKEN:secret}}]})};
  const db={transaction:jest.fn(async(_isolation:string,run:any)=>run(manager))};
  await expect(withPostgresCleanupSettings(db as any,target,work,absent)).rejects.toThrow('references');
  expect(query).toHaveBeenCalledWith('LOCK TABLE "servers" IN SHARE ROW EXCLUSIVE MODE');
  expect(work).not.toHaveBeenCalled();
});
