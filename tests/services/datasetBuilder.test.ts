import { buildDataset } from '../../src/services/datasetBuilder.js';
const sample=(id:string,task=id)=>({resultId:id,username:'owner',keyId:null,taskId:task,traceId:task,branchId:'b',segmentId:'s',
  modelId:'observed',source:'gateway_observed',verified:true,causal:true,conflict:false,payloadAvailable:true,raw:'original',rawSha256:'a'.repeat(64),
  objective:`task ${id}`,toolName:'demo-read',arguments:'{}',tools:[{name:'demo-read',inputSchema:{type:'object'}}],
  consent:true,outcome:'success',quality:'correct',privacy:true,contextPrivacy:true,reviewDigest:'a'.repeat(64),
  reviewRevision:1,contextRevision:1,taskRevision:1});
test('exports only explicitly reviewed positive calls and preserves per-call provenance',()=>{
  const good=sample('a');
  const data=buildDataset([good,{...sample('b'),quality:'incorrect'},{...sample('c'),consent:false}],{username:'owner',keyId:null});
  expect(data.examples).toHaveLength(1);
  expect(data.examples[0].metadata).toMatchObject({resultId:'a',modelId:'observed',identityTrust:'trusted'});
  expect(data.examples[0].messages[1]).toMatchObject({role:'assistant'});
  expect(data.manifest.excluded).toEqual({call_quality_not_positive:1,training_consent_missing:1});
});
test('self-report needs explicit opt-in and never becomes verified; foreign tenants never export',()=>{
  const self={...sample('a'),source:'self_reported',verified:false,causal:false};
  expect(buildDataset([self],{username:'owner',keyId:null}).examples).toHaveLength(0);
  const result=buildDataset([self,{...sample('b'),username:'other'}],{username:'owner',keyId:null,allowSelfReported:true});
  expect(result.examples[0].metadata.identityTrust).toBe('unverified');
  expect(result.examples).toHaveLength(1);
});
test('keeps tasks/traces and duplicate examples together across splits',()=>{
  const a=sample('a','task-a'),b={...sample('b','task-a'),traceId:'other-trace'},c={...sample('c','task-c'),objective:a.objective};
  const data=buildDataset([a,b,c],{username:'owner',keyId:null});
  expect(data.examples).toHaveLength(2);
  expect(new Set(data.examples.map(row=>row.metadata.split)).size).toBe(1);
  expect(data.manifest.duplicates).toBe(1);
  expect(buildDataset([c,b,a],{username:'owner',keyId:null}).examples).toEqual(data.examples);
});
test('missing schema context, invalid arguments, revoked privacy and unknown model are excluded',()=>{
  for(const change of [{tools:[]},{arguments:'invalid'},{privacy:false},{modelId:null},{reviewDigest:'wrong'},{contextPrivacy:false}]){
    expect(buildDataset([{...sample('a'),...change}],{username:'owner',keyId:null}).examples).toHaveLength(0);
  }
});
test('detectable credentials or email addresses never export despite an approval flag',()=>{
  for(const change of [{arguments:JSON.stringify({password:'private-value'})},{objective:'Contact person@example.com'},
    {objective:'token '+ 'ghp_'+'x'.repeat(36)}]){
    expect(buildDataset([{...sample('a'),...change}],{username:'owner',keyId:null}).manifest.excluded.sensitive_data_detected).toBe(1);
  }
});
