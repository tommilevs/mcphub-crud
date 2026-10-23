import { prepareTrainingCatalogue } from '../../src/services/trainingContext.js';
import { createHash } from 'node:crypto';
test('binds the exact full schema catalogue to discovery fingerprints',()=>{
  const schema={type:'object',properties:{path:{type:'string'}}};
  const result=prepareTrainingCatalogue([{name:'demo-read',inputSchema:schema}]);
  expect(result?.fingerprints).toEqual([{name:'demo-read',schemaSha256:createHash('sha256').update(JSON.stringify(schema)).digest('hex')}]);
});
test('rejects incomplete, duplicate and oversized schema catalogues',()=>{
  for(const value of [[],[{name:'a'}],[{name:'a',inputSchema:{}},{name:'a',inputSchema:{}}],
    [{name:'a',inputSchema:{description:'x'.repeat(524288)}}]]) expect(prepareTrainingCatalogue(value)).toBeNull();
});
