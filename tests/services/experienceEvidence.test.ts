import {assessExperienceEvidence} from '../../src/services/experienceEvidence.js';
const source=(id:string,task=id)=>({resultId:id,taskId:task,payloadAvailable:true,rawSha256:'digest',reviewDigest:'digest',
  quality:'correct',privacy:'approved',outcome:'success'});
test('independent reviewed tasks support a strategy without inventing verified outcomes',()=>{
  expect(assessExperienceEvidence(['a','b'],[source('a'),source('b')])).toMatchObject({usable:true,confidence:'supported',independentTasks:2,outcomeSource:'user_confirmed'});
  expect(assessExperienceEvidence(['a','b'],[source('a','same'),source('b','same')]).confidence).toBe('hypothesis');
});
test('missing or revoked evidence makes retrieval unusable',()=>{
  for(const rows of [[source('a')],[source('a'),{...source('b'),privacy:'rejected'}],[source('a'),{...source('b'),outcome:'failure'}]]){
    expect(assessExperienceEvidence(['a','b'],rows).usable).toBe(false);
  }
});
