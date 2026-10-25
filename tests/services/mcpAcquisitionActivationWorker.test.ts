import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateJsonAcquisition } from '../../src/services/mcpAcquisitionActivationWorker.js';
import { prepareAcquisitionPublication } from '../../src/services/mcpAcquisitionPublicationSettings.js';
import type { AcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';

describe('JSON acquisition activation continuation',()=>{
  let root:string,target:string,publication:any;
  const manifest:AcquisitionManifest={schemaVersion:1,serverName:'fixture',targetGroup:'target',transport:'stdio',
    package:{ecosystem:'npm',name:'fixture',version:'1.0.0'},source:{type:'local_catalog',repository:null},requiredInputs:[]};
  beforeEach(()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'mcphub-activation-worker-'));target=path.join(root,'settings.json');
    const prepared=prepareAcquisitionPublication({mcpServers:{},groups:[{id:'target',name:'Target',servers:[]}]},
      manifest,'operation','alice',{command:'node.exe',args:['fixture.js'],cwd:'owned'},['ping']);
    publication={storage:'json',settingsPath:target,baseDigest:'a'.repeat(64),receipt:prepared.receipt};
    fs.writeFileSync(target,JSON.stringify(prepared.settings));
  });
  afterEach(()=>{
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-activation-worker-')).toBe(true);
    fs.rmSync(root,{recursive:true});expect(fs.existsSync(root)).toBe(false);
  });
  const dependencies=()=>({repository:{
    claimActivation:jest.fn().mockImplementation(async()=>({claim_id:'original',activation_claim_id:'activation',publication})),
    completeActivation:jest.fn().mockResolvedValue(true),requireReconciliation:jest.fn().mockResolvedValue(true),
  },observe:jest.fn().mockResolvedValue({serverName:'fixture',tools:['ping'],indexStatus:'verified' as const})});
  test('commits readiness only after observation and preserves unrelated edits',async()=>{
    const deps=dependencies();
    deps.observe.mockImplementation(async()=>{
      const current=JSON.parse(fs.readFileSync(target,'utf8'));current.mcpServers.unrelated={command:'keep.exe'};
      fs.writeFileSync(target,JSON.stringify(current));
      return {serverName:'fixture',tools:['ping'],indexStatus:'verified'};
    });
    expect((await activateJsonAcquisition('alice','operation',target,deps)).status).toBe('ready');
    expect(deps.repository.completeActivation).toHaveBeenCalledWith('alice','operation','activation',expect.objectContaining({tools:['ping']}));
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.unrelated.command).toBe('keep.exe');
  });
  test('a user edit during activation is preserved and prevents readiness',async()=>{
    const deps=dependencies();deps.observe.mockImplementation(async()=>{
      const current=JSON.parse(fs.readFileSync(target,'utf8'));current.mcpServers.fixture.enabled=false;
      fs.writeFileSync(target,JSON.stringify(current));return {serverName:'fixture',tools:['ping'],indexStatus:'verified'};
    });
    expect((await activateJsonAcquisition('alice','operation',target,deps)).status).toBe('reconciliation_required');
    expect(deps.repository.completeActivation).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.fixture.enabled).toBe(false);
  });
  test('failed observation retains published settings for reconciliation',async()=>{
    const deps=dependencies();deps.observe.mockRejectedValue(new Error('index unavailable'));
    const before=fs.readFileSync(target,'utf8');
    expect(await activateJsonAcquisition('alice','operation',target,deps)).toMatchObject({status:'reconciliation_required',checkpointSaved:true});
    expect(fs.readFileSync(target,'utf8')).toBe(before);expect(deps.repository.completeActivation).not.toHaveBeenCalled();
  });
  test('an already claimed activation cannot start another runtime pass',async()=>{
    const deps=dependencies();deps.repository.claimActivation.mockResolvedValue(null);
    expect((await activateJsonAcquisition('alice','operation',target,deps)).status).toBe('not_claimed');
    expect(deps.observe).not.toHaveBeenCalled();
  });
});
