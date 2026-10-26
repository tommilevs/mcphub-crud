let mockSource: any;
const mockConstruct = jest.fn();
jest.mock('../../src/db/connection.js',()=>({getAppDataSource:()=>mockSource}));
jest.mock('../../src/db/repositories/ToolResultRepository.js',()=>({ToolResultRepositoryDb:class {
  constructor(public source:unknown){mockConstruct(source);}
}}));
import {getToolResultRepository} from '../../src/services/toolResultHistoryRegistry.js';

test('reuses a repository only while the same data source remains active',()=>{
  const first={isInitialized:true},second={isInitialized:true};
  mockSource=first;
  const a=getToolResultRepository();expect(getToolResultRepository()).toBe(a);
  mockSource=second;
  const b=getToolResultRepository();expect(b).not.toBe(a);expect(getToolResultRepository()).toBe(b);
  expect(mockConstruct.mock.calls.map(c=>c[0])).toEqual([first,second]);
  second.isInitialized=false;
  expect(getToolResultRepository()).toBeUndefined();
});
