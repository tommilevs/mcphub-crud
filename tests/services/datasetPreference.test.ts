import {assessPreference} from '../../src/services/datasetPreference.js';
const sample=(id:string)=>({resultId:id,username:'owner',keyId:null,taskId:id,traceId:id,branchId:'branch',segmentId:id,
  modelId:'observed',source:'gateway_observed',verified:true,causal:true,conflict:false,payloadAvailable:true,rawSha256:'a'.repeat(64),
  objective:'Inspect system',toolName:'demo-read',arguments:'{}',tools:[{name:'demo-read',inputSchema:{type:'object'}}],
  consent:true,outcome:'success',quality:'correct',privacy:true,contextPrivacy:true,reviewDigest:'a'.repeat(64),
  reviewRevision:1,contextRevision:1,taskRevision:1});
const options={username:'owner',keyId:null};
test('requires genuinely identical derived context, distinct actions and explicit call-quality labels',()=>{
  const chosen=sample('a'),rejected={...sample('b'),quality:'incorrect',arguments:'{"mode":"wrong"}'};
  expect(assessPreference(chosen,rejected,options)).toHaveProperty('digest');
  for(const change of [{objective:'different task'},{tools:[{name:'demo-read',inputSchema:{type:'object',required:['x']}}]},
    {arguments:'{}'},{quality:'correct'},{consent:false},{privacy:false},{modelId:null}]){
    expect(assessPreference(chosen,{...rejected,...change},options)).toBeNull();
  }
});
test('HTTP status alone creates no preference; evidence digest changes with review revisions',()=>{
  const chosen=sample('a'),rejected={...sample('b'),arguments:'{"mode":"other"}',status:'error'};
  expect(assessPreference(chosen,rejected,options)).toBeNull();
  const explicit={...rejected,quality:'incorrect'};
  const current=assessPreference(chosen,explicit,options)!;
  expect(assessPreference(chosen,{...explicit,reviewRevision:2},options)?.digest).not.toBe(current.digest);
});
