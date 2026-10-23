import {resolveDatasetGroups} from '../../src/services/datasetRegistry.js';
const groups=[{tokens:['task:a','trace:a','example:one'],fingerprints:['one'],split:'train'}];
test('prior split wins over a new seed or selection, without moving an exported component',()=>{
  const known=new Map([['task:a','test']]);
  expect(resolveDatasetGroups(groups,known)).toEqual([{...groups[0],split:'test'}]);
});
test('a newly observed bridge between previously exported splits is rejected',()=>{
  expect(()=>resolveDatasetGroups(groups,new Map([['task:a','test'],['example:one','train']]))).toThrow('split conflict');
});
test('new components keep deterministic proposed assignment and duplicates retain all linkage tokens',()=>{
  const linked={tokens:['task:a','task:b','example:one'],fingerprints:['one'],split:'validation'};
  expect(resolveDatasetGroups([linked],new Map())).toEqual([linked]);
  expect(resolveDatasetGroups([linked],new Map([['task:b','test']]))[0].split).toBe('test');
});
