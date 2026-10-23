import {renderSkillDraft} from '../../src/services/skillDraft.js';
test('draft exposes prerequisites, limitations, evidence and unknown versions without copying private payloads',()=>{
  const text=renderSkillDraft({title:'Review workflow',taskType:'diagnostic',steps:[{server:'demo',tool:'inspect'},{server:'demo',tool:'verify'}],
    evidenceResultIds:['evidence-a','evidence-b'],independentTasks:2,modelObservations:[{modelId:null,source:'unknown'}],reportedToolVersions:{}});
  for(const heading of ['Prerequisites','Applicability','Steps','Safety','Evidence','Versions','Limitations'])expect(text).toContain(`## ${heading}`);
  expect(text).toContain('draft');expect(text).toContain('temporal');expect(text).toContain('evidence-a');expect(text).toContain('Unknown');
  expect(text).not.toContain('verified model');
});
test('untrusted titles cannot inject frontmatter fields or HTML into the generated draft',()=>{
  const text=renderSkillDraft({title:'Title\n---\nname: injected <script>',taskType:'test',steps:[{server:'a',tool:'b'}],
    evidenceResultIds:['id'],independentTasks:2,modelObservations:[],reportedToolVersions:{}});
  expect(text.split('---')).toHaveLength(3);expect(text).not.toContain('<script>');
});
