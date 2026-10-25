import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishVerifiedJsonAcquisition, publishVerifiedAcquisitionToStore } from '../../src/services/mcpAcquisitionPublication.js';
import { acquisitionManifestDigest, type AcquisitionManifest } from '../../src/services/mcpAcquisitionPlan.js';
import { AcquisitionPublicationCommitUnknown } from '../../src/services/mcpAcquisitionPostgresPublication.js';

describe('verified acquisition publication continuation', () => {
  let root: string; let target: string;
  const operationId=randomUUID(),claimId=randomUUID();
  const manifest:AcquisitionManifest={schemaVersion:1,serverName:'fixture',targetGroup:'target',transport:'stdio',
    package:{ecosystem:'npm',name:'fixture',version:'1.0.0'},source:{type:'local_catalog',repository:null},requiredInputs:[]};
  beforeEach(()=>{
    root=fs.mkdtempSync(path.join(os.tmpdir(),'mcphub-publication-worker-')); target=path.join(root,'settings.json');
    fs.writeFileSync(target,JSON.stringify({mcpServers:{},groups:[{id:'target',name:'Target',servers:[]}]}));
  });
  afterEach(()=>{
    expect(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)).toBe(true);
    expect(path.basename(root).startsWith('mcphub-publication-worker-')).toBe(true);
    fs.rmSync(root,{recursive:true}); expect(fs.existsSync(root)).toBe(false);
  });
  const dependencies=()=>({
    repository:{
      publicationCandidate:jest.fn().mockResolvedValue({claim_id:claimId,manifest,manifest_digest:acquisitionManifestDigest(manifest),inspection:{tools:['ping']}}),
      reservePublication:jest.fn().mockResolvedValue(true),recordPublicationApplied:jest.fn().mockResolvedValue(true),
      requireReconciliation:jest.fn().mockResolvedValue(true),
    },
    resolve:jest.fn().mockResolvedValue({verification:'package_metadata',package:manifest.package,
      spec:{command:'node.exe',args:['fixture.js'],cwd:'owned'}}),
  });
  test('binds persisted evidence and native package to the durable receipt before actual write',async()=>{
    const deps=dependencies();
    deps.repository.reservePublication.mockImplementation(async()=>{
      expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.fixture).toBeUndefined(); return true;
    });
    const result=await publishVerifiedJsonAcquisition('alice',operationId,target,{},deps);
    expect(result.status).toBe('published');
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.fixture.owner).toBe('alice');
    expect(deps.repository.reservePublication).toHaveBeenCalledWith('alice',operationId,claimId,expect.objectContaining({storage:'json'}));
    expect(deps.repository.recordPublicationApplied).toHaveBeenCalledWith('alice',operationId,claimId,expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(deps.repository.requireReconciliation).not.toHaveBeenCalled();
  });
  test('lost reservation cannot change settings or invalidate another worker',async()=>{
    const deps=dependencies();deps.repository.reservePublication.mockResolvedValue(false);
    const before=fs.readFileSync(target,'utf8');
    expect((await publishVerifiedJsonAcquisition('alice',operationId,target,{},deps)).status).toBe('not_published');
    expect(fs.readFileSync(target,'utf8')).toBe(before);
    expect(deps.repository.requireReconciliation).not.toHaveBeenCalled();
  });
  test('unknown outcome after application retains resources and requires reconciliation',async()=>{
    const deps=dependencies();deps.repository.recordPublicationApplied.mockRejectedValue(new Error('database disconnected'));
    const result=await publishVerifiedJsonAcquisition('alice',operationId,target,{},deps);
    expect(result).toMatchObject({status:'reconciliation_required',checkpointSaved:true});
    expect(JSON.parse(fs.readFileSync(target,'utf8')).mcpServers.fixture).toBeDefined();
    expect(deps.repository.requireReconciliation).toHaveBeenCalledWith('alice',operationId,claimId);
  });
  test('lost reservation response requires reconciliation without applying settings',async()=>{
    const deps=dependencies();deps.repository.reservePublication.mockRejectedValue(new Error('response lost'));
    const before=fs.readFileSync(target,'utf8');
    expect((await publishVerifiedJsonAcquisition('alice',operationId,target,{},deps)).status).toBe('reconciliation_required');
    expect(fs.readFileSync(target,'utf8')).toBe(before);
    expect(deps.repository.recordPublicationApplied).not.toHaveBeenCalled();
  });
  test('corrupt plan cannot resolve or publish a package',async()=>{
    const deps=dependencies();
    deps.repository.publicationCandidate.mockResolvedValue({claim_id:claimId,manifest,manifest_digest:'bad',inspection:{tools:['ping']}});
    expect((await publishVerifiedJsonAcquisition('alice',operationId,target,{},deps)).status).toBe('not_published');
    expect(deps.resolve).not.toHaveBeenCalled();
    expect(deps.repository.reservePublication).not.toHaveBeenCalled();
  });
  test('PostgreSQL uses its atomic adapter without a second journal write or JSON mutation',async()=>{
    const deps={...dependencies(),publishPostgres:jest.fn().mockResolvedValue({digest:'a'.repeat(64)})};
    const before=fs.readFileSync(target,'utf8'),db={} as any;
    expect((await publishVerifiedAcquisitionToStore('alice',operationId,{kind:'postgres',db},{},deps)).status).toBe('published');
    expect(deps.publishPostgres).toHaveBeenCalledWith(db,expect.objectContaining({owner:'alice',operationId}),claimId);
    expect(deps.repository.recordPublicationApplied).not.toHaveBeenCalled();
    expect(deps.repository.reservePublication).not.toHaveBeenCalled();
    expect(fs.readFileSync(target,'utf8')).toBe(before);
  });
  test('an uncertain PostgreSQL commit blocks replay and requires reconciliation',async()=>{
    const deps={...dependencies(),publishPostgres:jest.fn().mockRejectedValue(new AcquisitionPublicationCommitUnknown('lost commit reply'))};
    expect((await publishVerifiedAcquisitionToStore('alice',operationId,{kind:'postgres',db:{} as any},{},deps)).status).toBe('reconciliation_required');
    expect(deps.repository.requireReconciliation).toHaveBeenCalledWith('alice',operationId,claimId);
  });
  test('a rejected PostgreSQL transaction cannot invalidate a competing successful worker',async()=>{
    const deps={...dependencies(),publishPostgres:jest.fn().mockRejectedValue(new Error('existing server'))};
    expect((await publishVerifiedAcquisitionToStore('alice',operationId,{kind:'postgres',db:{} as any},{},deps)).status).toBe('not_published');
    expect(deps.repository.requireReconciliation).not.toHaveBeenCalled();
  });
});
