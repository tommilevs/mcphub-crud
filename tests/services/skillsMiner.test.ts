import {mineWorkflowCandidate} from '../../src/services/skillsMiner.js';
const workflow=(task:string)=>[0,1].map(index=>({resultId:`${task}-${index}`,taskId:task,traceId:task,branchId:'branch',
  timestamp:new Date(index*1000),server:'demo',tool:index?'verify':'inspect',reviewedPositive:true,modelId:'reported',identitySource:'self_reported'}));
test('requires a repeated multi-step workflow in independent reviewed tasks',()=>{
  expect(mineWorkflowCandidate(workflow('a'))).toBeNull();
  const result=mineWorkflowCandidate([...workflow('a'),...workflow('b')]);
  expect(result).toMatchObject({independentTasks:2,sequenceEvidence:'temporal',outcomeSource:'user_confirmed',confidence:'proposal'});
  expect(result?.steps).toEqual([{server:'demo',tool:'inspect'},{server:'demo',tool:'verify'}]);
});
test('rejects ambiguous timing, branches, revoked evidence and mismatched sequences',()=>{
  for(const change of [{timestamp:new Date(0)},{branchId:null},{reviewedPositive:false},{tool:'different'}]){
    const calls=[...workflow('a'),...workflow('b')];Object.assign(calls[3],change);
    expect(mineWorkflowCandidate(calls)).toBeNull();
  }
});
test('never copies arguments or RAW into a proposal and preserves model-source limitations',()=>{
  const calls=[...workflow('a'),...workflow('b')].map(call=>({...call,arguments:'secret',raw:'private'}));
  const result=mineWorkflowCandidate(calls);
  expect(JSON.stringify(result)).not.toContain('secret');expect(JSON.stringify(result)).not.toContain('private');
  expect(result?.modelObservations).toEqual([{modelId:'reported',source:'self_reported'}]);
});
