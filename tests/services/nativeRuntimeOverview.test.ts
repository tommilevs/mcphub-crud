const mockStatus=jest.fn(),mockServers=jest.fn();
jest.mock('../../src/services/nativeRuntimeSecretService.js',()=>({getNativeRuntimeStatus:mockStatus}));
jest.mock('../../src/dao/DaoFactory.js',()=>({getServerDao:()=>({findAll:mockServers})}));
import {getNativeRuntimeOverview} from '../../src/services/nativeRuntimeOverview.js';
beforeEach(()=>{jest.resetAllMocks();});
it('keeps service management available when configuration storage fails',async()=>{
 mockStatus.mockResolvedValue({processes:[{id:'machine'}]});mockServers.mockRejectedValue(Error('private database error'));
 await expect(getNativeRuntimeOverview()).resolves.toMatchObject({processes:[{id:'machine'}],agents:[],configurationAvailable:false});
});
it('merges configured agents once and keeps explicit restart targets even for duplicate process ids',async()=>{
 mockServers.mockResolvedValue([{command:'node',options:{nativeExecution:{kind:'interactive',sessionId:7}}},{command:'node',options:{nativeExecution:{kind:'interactive',sessionId:7,pipeName:'mcphub-user-session-7'}}}]);
 mockStatus.mockResolvedValueOnce({processes:[{id:'same',running:true}],gatewayHealthy:true}).mockResolvedValue({processes:[{id:'same',running:true}]});
 const result=await getNativeRuntimeOverview();
 expect(mockStatus).toHaveBeenCalledTimes(2);
 expect(result.processes).toEqual([{id:'same',running:true,executionContext:{kind:'service'}},{id:'same',running:true,executionContext:{kind:'interactive',sessionId:7}}]);
 expect(result.gatewayHealthy).toBe(true);
});
it('keeps machine processes visible when an agent is unavailable without exposing configuration secrets',async()=>{
 mockServers.mockResolvedValue([{command:'node',env:{TOKEN:'private'},options:{nativeExecution:{kind:'interactive',sessionId:8}}}]);
 mockStatus.mockResolvedValueOnce({processes:[{id:'machine'}]}).mockRejectedValue(Error('private pipe internals'));
 const result=await getNativeRuntimeOverview();
 expect(result.processes).toHaveLength(1);
 expect(result.agents).toEqual([{executionContext:{kind:'interactive',sessionId:8},available:false,error:'User agent unavailable'}]);
 expect(JSON.stringify(result)).not.toContain('private');
});
