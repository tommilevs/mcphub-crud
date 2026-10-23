import {buildTrajectoryDataset} from '../../src/services/datasetTrajectory.js';
const sample=(id:string,time:number)=>({resultId:id,username:'owner',keyId:null,taskId:'task',traceId:'trace',branchId:'branch',segmentId:'segment',
  modelId:'observed',source:'gateway_observed',verified:true,causal:true,conflict:false,payloadAvailable:true,rawSha256:'a'.repeat(64),
  objective:'Inspect system',toolName:'demo-read',arguments:'{}',tools:[{name:'demo-read',inputSchema:{type:'object'}}],
  consent:true,outcome:'success',quality:'correct',privacy:true,contextPrivacy:true,reviewDigest:'a'.repeat(64),
  reviewRevision:1,contextRevision:1,taskRevision:1,timestamp:new Date(time).toISOString(),status:'success',retainedSegmentCalls:2});
test('exports recorded segment events and result references without inventing conversation or success labels',()=>{
  const data=buildTrajectoryDataset([sample('later',2000),{...sample('earlier',1000),quality:'incorrect',status:'error'}],{username:'owner',keyId:null});
  expect(data.examples).toHaveLength(1);const trace=data.examples[0];
  expect(trace.events.map(event=>event.resultId)).toEqual(['earlier','later']);
  expect(trace.events[0]).toMatchObject({quality:'incorrect',executionStatus:'error',result:{resultId:'earlier',rawSha256:'a'.repeat(64)}});
  expect(trace.metadata).toMatchObject({representation:'recorded-tool-trajectory',modelId:'observed',coverage:'all-currently-retained-segment-calls'});
  expect(trace).not.toHaveProperty('messages');expect(JSON.stringify(trace)).not.toContain('assistant');
});
test('omitted calls, revoked evidence, unknown identity and mixed models reject the whole segment',()=>{
  for(const change of [{retainedSegmentCalls:3},{privacy:false},{modelId:null},{modelId:'different'}]){
    expect(buildTrajectoryDataset([sample('a',1000),{...sample('b',2000),...change}],{username:'owner',keyId:null}).examples).toHaveLength(0);
  }
});
test('parallel branches and model segments stay separate, with per-call labels and common task split',()=>{
  const calls=[{...sample('a',1000),retainedSegmentCalls:1},{...sample('b',1000),segmentId:'next',modelId:'next-model',retainedSegmentCalls:1}];
  const data=buildTrajectoryDataset(calls,{username:'owner',keyId:null});
  expect(data.examples).toHaveLength(2);expect(new Set(data.examples.map(row=>row.metadata.split)).size).toBe(1);
  expect(data.examples.map(row=>row.metadata.modelId).sort()).toEqual(['next-model','observed']);
});
test('reviewed failed tasks remain observational data, and self-report still needs explicit opt-in',()=>{
  const calls=[sample('a',1000),sample('b',2000)].map(call=>({...call,outcome:'failure',source:'self_reported',verified:false,causal:false}));
  expect(buildTrajectoryDataset(calls,{username:'owner',keyId:null}).examples).toHaveLength(0);
  const trajectory=buildTrajectoryDataset(calls,{username:'owner',keyId:null,allowSelfReported:true}).examples[0];
  expect(trajectory.metadata).toMatchObject({taskOutcome:'failure',identityTrust:'unverified'});
});
test('orders timestamps by actual instant and never claims equal timestamps prove causality',()=>{
  const first={...sample('a',0),timestamp:'2026-10-23T12:00:00+03:00'};
  const second={...sample('b',0),timestamp:'2026-10-23T10:00:00Z'};
  expect(buildTrajectoryDataset([second,first],{username:'owner',keyId:null}).examples[0].events[0].resultId).toBe('a');
  const ties=buildTrajectoryDataset([first,{...second,timestamp:first.timestamp}],{username:'owner',keyId:null}).examples[0];
  expect(ties.metadata.ordering).toContain('do not imply causal');
});
