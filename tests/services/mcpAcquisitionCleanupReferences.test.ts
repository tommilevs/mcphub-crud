import {assertNoCleanupReferences} from '../../src/services/mcpAcquisitionCleanupReferences.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const id='00000000-0000-4000-8000-000000000001';
const secret='acq-'+'a'.repeat(64);
const target={operationId:id,directory:`C:\\data\\acquisitions\\${id}`,secretIds:[secret]};
const absent=async()=>{throw Object.assign(new Error('absent'),{code:'ENOENT'});};

test('renamed disabled servers still block package or secret cleanup',async()=>{
  for(const config of [
    {enabled:false,command:'node.exe',args:[`C:/data/acquisitions/${id}/index.js`]},
    {enabled:false,nativeSecretRefs:{TOKEN:secret}},
    {enabled:false,options:{acquisitionOperationId:id}},
  ])await expect(assertNoCleanupReferences([{name:'renamed',config}],target,absent)).rejects.toThrow('references');
});

test('a filesystem alias to an owned package blocks cleanup',async()=>{
  const resolve=jest.fn(async(value:string)=>value==='C:\\alias\\entry.js'?`${target.directory}\\index.js`:value);
  await expect(assertNoCleanupReferences([{name:'alias',config:{command:'C:\\alias\\entry.js'}}],target,resolve)).rejects.toThrow('references');
});

test('relative arguments are resolved against the configured working directory',async()=>{
  const resolve=async(value:string)=>value==='C:\\other\\alias\\entry.js'?`${target.directory}\\index.js`:value;
  await expect(assertNoCleanupReferences([{name:'relative',config:{args:['alias/entry.js'],
    options:{nativeWorkingDirectory:'C:\\other'}}}],target,resolve)).rejects.toThrow('references');
});

test('unrelated configs pass without returning or logging their secret values',async()=>{
  await expect(assertNoCleanupReferences([{name:'other',config:{command:'C:\\other\\server.exe',env:{TOKEN:'synthetic-private-value'}}}],target,absent)).resolves.toBeUndefined();
});

test('an unreadable path cannot be treated as proof of absence',async()=>{
  const denied=async()=>{throw Object.assign(new Error('synthetic-private-value'),{code:'EACCES'});};
  await expect(assertNoCleanupReferences([{name:'other',config:{command:'C:\\other\\server.exe'}}],target,denied)).rejects.toThrow('unconfirmed');
});

test('a stalled filesystem lookup refuses cleanup after the bounded timeout',async()=>{
  jest.useFakeTimers();
  try{
    const pending=assertNoCleanupReferences([{name:'unavailable',config:{command:'C:\\unavailable\\server.exe'}}],target,
      ()=>new Promise<string>(()=>{}));
    const rejected=expect(pending).rejects.toThrow('unconfirmed');
    await jest.advanceTimersByTimeAsync(2500);await rejected;
  }finally{jest.useRealTimers();}
});

test('a directory outside the exact operation identity is rejected before inspection',async()=>{
  const resolve=jest.fn();
  await expect(assertNoCleanupReferences([],{...target,directory:'C:\\Windows'},resolve)).rejects.toThrow('identity');
  await expect(assertNoCleanupReferences([],{...target,secretIds:['unrelated-secret']},resolve)).rejects.toThrow('identity');
  expect(resolve).not.toHaveBeenCalled();
});

(process.platform==='win32'?test:test.skip)('real Windows junction aliases cannot hide adopted package usage',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcphub-cleanup-alias-'));
  const directory=path.join(root,id),alias=path.join(root,'alias');
  try{
    fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'index.js'),'synthetic');
    fs.symlinkSync(directory,alias,'junction');
    await expect(assertNoCleanupReferences([{name:'alias',config:{command:path.join(alias,'index.js')}}],
      {...target,directory})).rejects.toThrow('references');
    expect(fs.readFileSync(path.join(directory,'index.js'),'utf8')).toBe('synthetic');
  }finally{
    if(fs.existsSync(alias))fs.unlinkSync(alias);
    expect(root.startsWith(path.join(os.tmpdir(),'mcphub-cleanup-alias-'))).toBe(true);
    fs.rmSync(root,{recursive:true});expect(fs.existsSync(root)).toBe(false);
  }
});
