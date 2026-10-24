import { normalizeNativeExecution, interactiveExecutionRequest } from '../../src/utils/nativeExecution.js';
describe('native execution policy', () => {
  test('legacy configuration remains service-hosted without new requirements', () => {
    expect(normalizeNativeExecution(undefined)).toBeUndefined();
    expect(interactiveExecutionRequest(undefined, false)).toBeUndefined();
    expect(interactiveExecutionRequest({kind:'service'}, false)).toBeUndefined();
  });
  test('interactive hosting requires an explicit session and never falls back to Session 0', () => {
    for(const value of [{kind:'interactive'}, {kind:'interactive',sessionId:0}, {kind:'interactive',sessionId:1.2},
      {kind:'interactive',sessionId:2,pipeName:'mcphub-runtime'}, {kind:'other'}]) {
      expect(()=>normalizeNativeExecution(value)).toThrow();
    }
    const execution={kind:'interactive' as const,sessionId:7,pipeName:'mcphub-user-test'};
    expect(()=>interactiveExecutionRequest(execution,false)).toThrow('requires Windows native runtime');
    expect(interactiveExecutionRequest(execution,true)).toEqual({kind:'interactive',session_id:7,pipe_name:'mcphub-user-test'});
  });
});
