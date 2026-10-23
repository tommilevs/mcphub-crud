import {experienceAppliesTo} from '../../src/services/experienceScope.js';
test('requires every explicit server and tool scope to match',()=>{
  expect(experienceAppliesTo({servers:['a'],tools:['a/read']},'a','read')).toBe(true);
  expect(experienceAppliesTo({servers:['a']},'b','read')).toBe(false);
  expect(experienceAppliesTo({tools:['a/read']},'a','write')).toBe(false);
  expect(experienceAppliesTo({},'a','read')).toBe(true);
});
test('malformed stored scopes never broaden applicability',()=>{
  for(const scope of [null,[],{servers:'a'},{tools:[1]},{unknown:['a']}])expect(experienceAppliesTo(scope,'a','read')).toBe(false);
});
