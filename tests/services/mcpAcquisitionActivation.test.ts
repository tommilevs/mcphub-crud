import { observeAcquisitionRuntime } from '../../src/services/mcpAcquisitionActivation.js';

describe('acquisition runtime observation',()=>{
  const receipt:any={operationId:'operation',serverName:'fixture',server:{owner:'alice'},entry:{tools:['ping']}};
  const dependencies=()=>{
    const info:any={name:'fixture',status:'disconnected',config:{owner:'alice',options:{acquisitionOperationId:'operation'}},tools:[],
      client:{listTools:jest.fn().mockResolvedValue({tools:[{name:'ping',inputSchema:{type:'object'}}]})}};
    return {info,refresh:jest.fn().mockResolvedValue(undefined),getServer:()=>info,
      wake:jest.fn().mockImplementation(async()=>{info.status='connected';}),
      updateTools:jest.fn().mockImplementation((_info,tools)=>{info.tools=tools.map((tool:any)=>({...tool,name:`fixture__${tool.name}`}));}),
      sync:jest.fn().mockResolvedValue(undefined),indexEnabled:jest.fn().mockResolvedValue(true),
      indexedNames:jest.fn().mockResolvedValue(['fixture__ping']),separator:()=> '__'};
  };
  test('wakes the server, actually lists tools and verifies index coverage',async()=>{
    const deps=dependencies();
    expect(await observeAcquisitionRuntime(receipt,deps)).toEqual({serverName:'fixture',tools:['ping'],indexStatus:'verified'});
    expect(deps.wake).toHaveBeenCalled();expect(deps.info.client.listTools).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledWith('fixture',deps.info.tools);
  });
  test('connection status alone cannot substitute for missing advertised tools',async()=>{
    const deps=dependencies();deps.info.client.listTools.mockResolvedValue({tools:[]});
    await expect(observeAcquisitionRuntime(receipt,deps)).rejects.toThrow('advertise');
    expect(deps.sync).not.toHaveBeenCalled();
  });
  test('a successful sync call without persisted index rows is not accepted',async()=>{
    const deps=dependencies();deps.indexedNames.mockResolvedValue([]);
    await expect(observeAcquisitionRuntime(receipt,deps)).rejects.toThrow('index');
  });
  test('disabled Smart Routing does not require or generate embeddings',async()=>{
    const deps=dependencies();deps.indexEnabled.mockResolvedValue(false);
    expect((await observeAcquisitionRuntime(receipt,deps)).indexStatus).toBe('disabled');
    expect(deps.sync).not.toHaveBeenCalled();expect(deps.indexedNames).not.toHaveBeenCalled();
  });
  test('rejects cyclic pagination without treating a partial list as complete',async()=>{
    const deps=dependencies();deps.info.client.listTools.mockResolvedValue({tools:[{name:'ping',inputSchema:{type:'object'}}],nextCursor:'again'});
    await expect(observeAcquisitionRuntime(receipt,deps)).rejects.toThrow('pagination');
  });
});
