import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { withJsonDaoTransaction } from '../../src/services/jsonDaoTransaction.js';
import { rollbackPublishedJsonAcquisition } from '../../src/services/mcpAcquisitionRollback.js';
import { publishJsonAcquisition } from '../../src/services/mcpAcquisitionJsonPublication.js';

describe('publication rollback continuation',()=>{
  let root:string,target:string,publication:any;
  beforeEach(async()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'mcphub-rollback-worker-'));target=path.join(root,'settings.json');
    fs.writeFileSync(target,JSON.stringify({mcpServers:{existing:{command:'keep.exe'}},groups:[{id:'target',name:'Target',servers:['existing']}]}));
    await publishJsonAcquisition(target,{operationId:'operation',owner:'alice',verifiedTools:['ping'],
      launch:{command:'node.exe',args:['fixture.js'],cwd:'owned'},manifest:{schemaVersion:1,serverName:'fixture',targetGroup:'target',transport:'stdio',
        package:{ecosystem:'npm',name:'fixture',version:'1.0.0'},source:{type:'local_catalog',repository:null},requiredInputs:[]}},
    async value=>{publication=value;return true;});
  });
  afterEach(()=>{
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-rollback-worker-')).toBe(true);
    fs.rmSync(root,{recursive:true});expect(fs.existsSync(root)).toBe(false);
  });
  const dependencies=()=>({repository:{claimPublicationRollback:jest.fn().mockImplementation(async()=>({claim_id:'original',rollback_claim_id:'rollback',publication})),
    completePublicationRollback:jest.fn().mockResolvedValue(true),requireReconciliation:jest.fn().mockResolvedValue(true)},
    cleanup:jest.fn().mockResolvedValue(undefined)});
  test('removes only owned configuration before cleanup and committing the rollback',async()=>{
    const deps=dependencies();deps.cleanup.mockImplementation(async()=>{
      expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.fixture).toBeUndefined();
    });
    expect((await rollbackPublishedJsonAcquisition('alice','operation',target,deps)).status).toBe('rolled_back');
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.existing.command).toBe('keep.exe');
    expect(deps.repository.completePublicationRollback).toHaveBeenCalledWith('alice','operation','rollback',expect.stringMatching(/^[a-f0-9]{64}$/));
  });
  test('refuses user changes without stopping or deleting the edited server',async()=>{
    const deps=dependencies(),edited=JSON.parse(fs.readFileSync(target,'utf8'));
    edited.mcpServers.fixture.command='user.exe';fs.writeFileSync(target,JSON.stringify(edited));
    const before=fs.readFileSync(target,'utf8');
    expect((await rollbackPublishedJsonAcquisition('alice','operation',target,deps)).status).toBe('reconciliation_required');
    expect(fs.readFileSync(target,'utf8')).toBe(before);expect(deps.cleanup).not.toHaveBeenCalled();
    expect(deps.repository.completePublicationRollback).not.toHaveBeenCalled();
  });
  test('cleanup failure cannot claim a completed rollback',async()=>{
    const deps=dependencies();deps.cleanup.mockRejectedValue(new Error('native stop unavailable'));
    expect((await rollbackPublishedJsonAcquisition('alice','operation',target,deps)).status).toBe('reconciliation_required');
    expect(deps.repository.completePublicationRollback).not.toHaveBeenCalled();
  });
  test('cleanup can drain DAO work created outside the rollback context',async()=>{
    const deps=dependencies(),background=new AsyncResource('existing-embedding-task');
    deps.cleanup.mockImplementation(async()=>{
      let timer:NodeJS.Timeout|undefined;
      try{
        await Promise.race([background.runInAsyncScope(()=>withJsonDaoTransaction(async()=>undefined)),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DAO queue deadlocked')),300);})]);
      }finally{if(timer)clearTimeout(timer);}
    });
    try{expect((await rollbackPublishedJsonAcquisition('alice','operation',target,deps)).status).toBe('rolled_back');}
    finally{background.emitDestroy();}
  });
});
