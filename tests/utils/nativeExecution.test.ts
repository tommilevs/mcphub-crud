import { normalizeNativeExecution, interactiveExecutionRequest, interactiveNativeEnvironment, normalizeNativeWorkingDirectory } from '../../src/utils/nativeExecution.js';
describe('native execution policy', () => {
  test('working directories are explicit Windows paths, never relative to the service account', () => {
    expect(normalizeNativeWorkingDirectory(undefined)).toBeUndefined();
    expect(normalizeNativeWorkingDirectory(' C:\\tools\\server ')).toBe('C:\\tools\\server');
    expect(normalizeNativeWorkingDirectory('\\\\host\\share\\server')).toBe('\\\\host\\share\\server');
    for(const value of ['relative','C:relative','\\relative','/tmp',5,'C:\\bad\0'])expect(()=>normalizeNativeWorkingDirectory(value)).toThrow();
  });
  test('interactive children inherit their user agent profile, with only configured overrides crossing the gateway boundary', () => {
    const source={USERPROFILE:'system-profile',APPDATA:'system-appdata',ADMIN_PASSWORD:'gateway-only',PATH:'configured-path',API_URL:'configured-url',npm_config_registry:'configured-registry'};
    expect(interactiveNativeEnvironment({PATH:'configured-path',API_URL:'configured-url'},source,['npm_config_registry']))
      .toEqual({PATH:'configured-path',API_URL:'configured-url',npm_config_registry:'configured-registry'});
    expect(interactiveNativeEnvironment(undefined,source,[])).toEqual({});
  });
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
