import {runAcquisitionCleanup} from '../../src/services/mcpAcquisitionCleanup.js';
import {acquisitionManifestDigest} from '../../src/services/mcpAcquisitionPlan.js';
import {acquisitionSecretId} from '../../src/services/mcpAcquisitionSecretIdentity.js';

const id='00000000-0000-4000-8000-000000000001';
const token='00000000-0000-4000-8000-000000000002';
function fixture(){
  const manifest:any={schemaVersion:1,serverName:'fixture',targetGroup:'group',transport:'stdio',
    package:{ecosystem:'npm',name:'@fixture/mcp',version:'1.0.0'},
    source:{type:'local_catalog',repository:null},requiredInputs:['FIRST_KEY','SECOND_KEY']};
  const active=new Set<string>(),events:string[]=[];
  const guard=(name:string)=>jest.fn(async(_target:any,work:()=>Promise<void>)=>{
    active.add(name);try{return await work();}finally{active.delete(name);}
  });
  const assertGuarded=()=>expect([...active].sort()).toEqual(['index','native','runtime','settings']);
  const deps={journal:{claim:jest.fn().mockResolvedValue({cleanup_claim_id:token,manifest,manifest_digest:acquisitionManifestDigest(manifest)}),
    get:jest.fn().mockResolvedValue(null),requireReview:jest.fn().mockResolvedValue(true),
    recordStep:jest.fn(async(_owner:any,_id:any,_token:any,step:string)=>{events.push(step);return true;}),
    recordSecret:jest.fn(async()=>{assertGuarded();return true;})},
    inspect:jest.fn().mockResolvedValue({id,verification:'cleanup_preflight',directory:`C:\\data\\acquisitions\\${id}`}),
    drain:jest.fn(async()=>{expect(active.size).toBe(0);}),
    withSettings:guard('settings'),withRuntime:guard('runtime'),withIndex:guard('index'),withNative:guard('native'),
    removePackage:jest.fn(async()=>{assertGuarded();events.push('delete-files');
      return {id,package:'@fixture/mcp',version:'1.0.0',verification:'cleanup_complete'};}),
    deleteSecret:jest.fn(async(_secret:string)=>{assertGuarded();events.push('delete-secret');return {ok:true};}),
  };
  return {deps,events,manifest,active};
}
test('holds all reservations through exact-owned deletions and journals each credential',async()=>{
  const {deps,events,active}=fixture();
  expect(await runAcquisitionCleanup('alice',id,deps)).toEqual({status:'complete'});
  expect(events).toEqual(['delete-files','files','delete-secret','delete-secret','secrets']);
  expect(deps.deleteSecret.mock.calls.map(call=>call[0])).toEqual(['FIRST_KEY','SECOND_KEY'].map(name=>acquisitionSecretId('alice',id,name)));
  expect(deps.journal.recordSecret).toHaveBeenCalledWith('alice',id,token,'FIRST_KEY');
  expect(active.size).toBe(0);
});
test('an existing or foreign claim never replays destructive work',async()=>{
  const {deps}=fixture();deps.journal.claim.mockResolvedValue(null);
  expect(await runAcquisitionCleanup('alice',id,deps)).toEqual({status:'not_claimed',cleanup:null});
  expect(deps.inspect).not.toHaveBeenCalled();expect(deps.removePackage).not.toHaveBeenCalled();
});
test.each(['withSettings','withRuntime','withIndex','withNative'] as const)('%s failure prevents deletion',async name=>{
  const {deps}=fixture();deps[name].mockRejectedValue(new Error('private diagnostic'));
  const result=await runAcquisitionCleanup('alice',id,deps);
  expect(result.status).toBe('review_required');expect(JSON.stringify(result)).not.toContain('private');
  expect(deps.removePackage).not.toHaveBeenCalled();expect(deps.deleteSecret).not.toHaveBeenCalled();
});
test('a changed manifest never reaches inspection or deletion',async()=>{
  const {deps,manifest}=fixture();manifest.package.version='2.0.0';
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.inspect).not.toHaveBeenCalled();expect(deps.removePackage).not.toHaveBeenCalled();
});
test('a foreign file receipt never permits credential removal',async()=>{
  const {deps}=fixture();deps.removePackage.mockResolvedValue({id:token,package:'@fixture/mcp',version:'1.0.0',verification:'cleanup_complete'});
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.deleteSecret).not.toHaveBeenCalled();expect(deps.journal.recordStep).not.toHaveBeenCalled();
});
test('partial credential deletion preserves evidence without claiming completion',async()=>{
  const {deps}=fixture();deps.deleteSecret.mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(new Error('lost response'));
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.journal.recordSecret).toHaveBeenCalledTimes(1);
  expect(deps.journal.recordStep.mock.calls.map(call=>call[3])).toEqual(['files']);
});
test('a lost file journal claim prevents further side effects',async()=>{
  const {deps}=fixture();deps.journal.recordStep.mockResolvedValue(false);
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.deleteSecret).not.toHaveBeenCalled();
});
test('reservation release failure preserves partial receipts without reporting completion',async()=>{
  const {deps}=fixture();const reserve=deps.withNative.getMockImplementation()!;
  deps.withNative.mockImplementation(async(target,work)=>{await reserve(target,work);throw new Error('release failed');});
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.journal.recordSecret).toHaveBeenCalledTimes(2);
  expect(deps.journal.recordStep.mock.calls.map(call=>call[3])).toEqual(['files']);
});
test('a missing credential acknowledgement cannot become a receipt',async()=>{
  const {deps}=fixture();deps.deleteSecret.mockResolvedValue({ok:false});
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.journal.recordSecret).not.toHaveBeenCalled();
});
test('an invalid preflight path prevents entry into reservations and native effects',async()=>{
  const {deps}=fixture();deps.inspect.mockResolvedValue({id,verification:'cleanup_preflight',directory:'C:\\unrelated'});
  expect((await runAcquisitionCleanup('alice',id,deps)).status).toBe('review_required');
  expect(deps.withSettings).not.toHaveBeenCalled();expect(deps.removePackage).not.toHaveBeenCalled();
});
