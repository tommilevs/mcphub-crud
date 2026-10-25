import { observeAcquisitionRuntime } from '../../src/services/mcpAcquisitionActivation.js';
import { Client } from '@modelcontextprotocol/client';
import { Server, InMemoryTransport } from '@modelcontextprotocol/server';

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
  test('uses a real paginated SDK exchange and never repeats a functional tool call',async()=>{
    const server=new Server({name:'activation-fixture',version:'1'},{capabilities:{tools:{}}});
    const list=jest.fn().mockImplementation(async request=>request.params?.cursor
      ? {tools:[{name:'ping',inputSchema:{type:'object'}}]}
      : {tools:[{name:'other',inputSchema:{type:'object'}}],nextCursor:'second'});
    const call=jest.fn().mockResolvedValue({content:[]});
    server.setRequestHandler('tools/list',list);server.setRequestHandler('tools/call',call);
    const client=new Client({name:'activation-client',version:'1'},{capabilities:{}});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(serverTransport);await client.connect(clientTransport);
      const deps=dependencies();deps.info.client=client;
      expect(await observeAcquisitionRuntime(receipt,deps)).toMatchObject({tools:['other','ping'],indexStatus:'verified'});
      expect(list).toHaveBeenCalledTimes(2);expect(call).not.toHaveBeenCalled();
    }finally{await client.close();await server.close();}
  });
});
