import {EventEmitter} from 'node:events';
const mockConnect=jest.fn();
jest.mock('node:net',()=>({__esModule:true,default:{createConnection:mockConnect}}));
import {getNativeRuntimeStatus,restartNativeRuntimeProcess} from '../../src/services/nativeRuntimeSecretService.js';

const suite=process.platform==='win32'?describe:describe.skip;
suite('native administrative pipe responses',()=>{
 let socket:EventEmitter & {write:jest.Mock;destroy:jest.Mock};
 beforeEach(()=>{
  jest.useFakeTimers();
  socket=Object.assign(new EventEmitter(),{write:jest.fn(),destroy:jest.fn()});
  mockConnect.mockReturnValue(socket);
 });
 afterEach(()=>{jest.clearAllTimers();jest.useRealTimers();});
 it('serializes the validated explicit session for both management operations',async()=>{
  const execution={kind:'interactive' as const,sessionId:7,pipeName:'mcphub-user-fixture'};
  for(const op of ['status','restart']){
   const pending=op==='status'?getNativeRuntimeStatus(execution):restartNativeRuntimeProcess('fixture',execution);
   socket.emit('connect');
   expect(JSON.parse(socket.write.mock.calls[socket.write.mock.calls.length-1][0])).toEqual({op,...(op==='restart'?{id:'fixture'}:{}),execution_context:{kind:'interactive',session_id:7,pipe_name:'mcphub-user-fixture'}});
   socket.emit('data',Buffer.from('{"ok":true}\n'));await pending;
  }
 });
 it('rejects a disconnected runtime immediately rather than waiting thirty seconds',async()=>{
  const pending=getNativeRuntimeStatus();const outcome=pending.then(()=> 'resolved',()=> 'rejected');
  socket.emit('connect');socket.emit('close');
  await Promise.resolve();
  expect(await Promise.race([outcome,Promise.resolve('pending')])).toBe('rejected');
  expect(jest.getTimerCount()).toBe(0);
 });
 it('preserves Unicode split between response packets',async()=>{
  const pending=getNativeRuntimeStatus();socket.emit('connect');
  const bytes=Buffer.from(JSON.stringify({processes:[{id:'сервер😀'}]})+'\n');
  const boundary=bytes.indexOf(Buffer.from('😀'))+1;
  socket.emit('data',bytes.subarray(0,boundary));socket.emit('data',bytes.subarray(boundary));
  await expect(pending).resolves.toEqual({processes:[{id:'сервер😀'}]});
 });
 it('settles and destroys only once when close follows a valid response',async()=>{
  const pending=getNativeRuntimeStatus();socket.emit('connect');socket.emit('data',Buffer.from('{"ok":true}\n'));
  socket.emit('close');socket.emit('error',Error('late close'));
  await expect(pending).resolves.toEqual({ok:true});
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
 });
});
