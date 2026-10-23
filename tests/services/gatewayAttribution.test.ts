import { createGatewayProof } from '../../src/services/gatewayProvenance.js';
import { withGatewayAttribution } from '../../src/services/gatewayAttribution.js';
import { runWithCallAttribution, getCallAttribution } from '../../src/services/callAttribution.js';
const secret='test-gateway-key-at-least-32-characters';
const principal='["alice",null]';
const request = { id: 1, params: { name: 'call_tool', arguments: { toolName: 'demo', arguments: {} }, _meta: {} as any } };
const response = { id:'r',model:'observed',choices:[{message:{tool_calls:[{id:'c',type:'function',function:{name:'call_tool',arguments:JSON.stringify(request.params.arguments)}}]}}] };
test('verifies only this call and preserves call ID, claims and conflict evidence', async () => {
  const proof=createGatewayProof(response,'c',request,{adapterId:'gateway',principal,secret});
  const repo={consumeGatewayNonce:jest.fn(async()=>true)};
  await runWithCallAttribution({contextId:null,taskId:null,traceId:null,modelSegmentId:null,
    identity:{modelId:'claimed',source:'self_reported',verified:false}},async()=>{
    const before=getCallAttribution()!;
    await withGatewayAttribution({...request,params:{...request.params,_meta:{'dev.mcphub/provenance':proof}}},request,principal,repo,async()=>{
      expect(getCallAttribution()).toMatchObject({callId:before.callId,identity:{modelId:'observed',source:'gateway_observed',verified:true},
        conflictReason:'gateway_model_differs_from_claim',provenance:{claimedModelId:'claimed',causalCorrelationVerified:true}});
      return {};
    },()=>secret);
    expect(getCallAttribution()).toBe(before);
  });
});
test('replayed or invalid proofs never elevate identity or replay execution', async () => {
  const proof=createGatewayProof(response,'c',request,{adapterId:'gateway',principal,secret});
  const handler=jest.fn(async()=>{expect(getCallAttribution()?.identity.verified).not.toBe(true); return {};});
  await runWithCallAttribution(null,()=>withGatewayAttribution({...request,params:{...request.params,_meta:{'dev.mcphub/provenance':proof}}},request,principal,
    {consumeGatewayNonce:async()=>false},handler,()=>secret));
  expect(handler).toHaveBeenCalledTimes(1);
});
