import { runAcquisitionExecution, prepareAcquisitionExecution } from '../../src/services/mcpAcquisitionExecution.js';
import { acquisitionManifestDigest } from '../../src/services/mcpAcquisitionPlan.js';

describe('claimed acquisition execution pipeline',()=>{
  const manifest:any={schemaVersion:1,serverName:'fixture',targetGroup:'target',transport:'stdio',
    package:{ecosystem:'npm',name:'fixture',version:'1.0.0'},source:{type:'local_catalog',repository:null},requiredInputs:['API_KEY']};
  const dependencies=()=>({enabled:()=>true,repository:{
    executionCandidate:jest.fn().mockResolvedValue({manifest,manifest_digest:acquisitionManifestDigest(manifest)}),
    claimExecution:jest.fn().mockResolvedValue({execution_claim_id:'execution'}),
    requireExecutionReconciliation:jest.fn().mockResolvedValue(true),get:jest.fn().mockResolvedValue({cancel_requested:false}),
  },putSecret:jest.fn().mockResolvedValue({}),stage:jest.fn().mockResolvedValue({status:'package_staged'}),
    verify:jest.fn().mockResolvedValue({status:'inspected'}),publish:jest.fn().mockResolvedValue({status:'published'}),
    activate:jest.fn().mockResolvedValue({status:'ready'}),rollback:jest.fn().mockResolvedValue({status:'rolled_back'})});
  test('stores reviewed credentials after claim and passes only references through every phase',async()=>{
    const deps=dependencies();
    expect((await runAcquisitionExecution('alice','operation',{API_KEY:'private-fixture-value'},deps)).status).toBe('ready');
    const [reference,value]=deps.putSecret.mock.calls[0];
    expect(reference).toMatch(/^acq-/);expect(value).toBe('private-fixture-value');
    expect(deps.verify).toHaveBeenCalledWith('alice','operation',{API_KEY:reference});
    expect(deps.publish).toHaveBeenCalledWith('alice','operation',{API_KEY:reference});
    expect(deps.stage).toHaveBeenCalledWith('alice','operation','execution');
    expect(JSON.stringify(deps.verify.mock.calls)).not.toContain('private-fixture-value');
    expect(deps.repository.claimExecution.mock.invocationCallOrder[0]).toBeLessThan(deps.putSecret.mock.invocationCallOrder[0]);
  });
  test('rejects missing or unreviewed credentials before claiming or launching',async()=>{
    const deps=dependencies();
    await expect(runAcquisitionExecution('alice','operation',{EXTRA:'secret'},deps)).rejects.toThrow('credentials');
    expect(deps.repository.claimExecution).not.toHaveBeenCalled();expect(deps.putSecret).not.toHaveBeenCalled();
  });
  test('a duplicate execution cannot change credentials or launch installation',async()=>{
    const deps=dependencies();deps.repository.claimExecution.mockResolvedValue(null);
    expect((await runAcquisitionExecution('alice','operation',{API_KEY:'secret'},deps)).status).toBe('not_claimed');
    expect(deps.putSecret).not.toHaveBeenCalled();expect(deps.stage).not.toHaveBeenCalled();
  });
  test('an uncertain credential write stops the pipeline and saves reconciliation state',async()=>{
    const deps=dependencies();deps.putSecret.mockRejectedValue(new Error('secret response lost'));
    expect(await runAcquisitionExecution('alice','operation',{API_KEY:'secret'},deps)).toMatchObject({status:'reconciliation_required',checkpointSaved:true});
    expect(deps.stage).not.toHaveBeenCalled();expect(deps.repository.requireExecutionReconciliation).toHaveBeenCalled();
  });
  test('unknown publication outcome never starts activation or automatic rollback',async()=>{
    const deps=dependencies();deps.publish.mockResolvedValue({status:'reconciliation_required'});
    expect((await runAcquisitionExecution('alice','operation',{API_KEY:'secret'},deps)).status).toBe('reconciliation_required');
    expect(deps.activate).not.toHaveBeenCalled();expect(deps.rollback).not.toHaveBeenCalled();
  });
  test('cancellation after publication uses owned rollback instead of activation replay',async()=>{
    const deps=dependencies();deps.activate.mockResolvedValue({status:'not_claimed'});
    deps.repository.get.mockResolvedValueOnce({cancel_requested:false}).mockResolvedValue({cancel_requested:true,requires_reconciliation:false});
    expect((await runAcquisitionExecution('alice','operation',{API_KEY:'secret'},deps)).status).toBe('rolled_back');
    expect(deps.rollback).toHaveBeenCalledWith('alice','operation');
  });
  test('a cancelled queued job never writes credentials or starts a package',async()=>{
    const deps=dependencies();deps.repository.get.mockResolvedValue({cancel_requested:true});
    expect((await runAcquisitionExecution('alice','operation',{API_KEY:'secret'},deps)).status).toBe('cancelled');
    expect(deps.putSecret).not.toHaveBeenCalled();expect(deps.stage).not.toHaveBeenCalled();
  });
  test('prepared execution closure can run only once',async()=>{
    const deps=dependencies(),execute=await prepareAcquisitionExecution('alice','operation',{API_KEY:'secret'},deps);
    expect((await execute!()).status).toBe('ready');expect((await execute!()).status).toBe('not_claimed');
    expect(deps.putSecret).toHaveBeenCalledTimes(1);expect(deps.stage).toHaveBeenCalledTimes(1);
  });
});
