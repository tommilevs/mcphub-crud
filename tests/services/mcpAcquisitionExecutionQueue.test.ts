import { AcquisitionExecutionQueue } from '../../src/services/mcpAcquisitionExecutionQueue.js';

test('bounded execution queue serializes jobs and releases capacity after completion',async()=>{
  let release!:()=>void;const first=new Promise<void>(resolve=>{release=resolve;});
  const execute=jest.fn().mockImplementationOnce(async()=>{await first;return {status:'ready'};}).mockResolvedValue({status:'ready'});
  const prepare=jest.fn().mockResolvedValue(execute);
  const queue=new AcquisitionExecutionQueue(prepare,2);
  expect(await queue.enqueue('alice','first',{})).toEqual({accepted:true});
  expect(await queue.enqueue('alice','second',{})).toEqual({accepted:true});
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(queue.enqueue('alice','third',{})).rejects.toThrow('full');
  expect(prepare).toHaveBeenCalledTimes(2);
  release();await queue.drain();expect(execute).toHaveBeenCalledTimes(2);expect(queue.size).toBe(0);
});

test('validation failure and missing claim release capacity without poisoning later jobs',async()=>{
  const prepare=jest.fn().mockRejectedValueOnce(new Error('invalid credentials')).mockResolvedValueOnce(null)
    .mockResolvedValue(async()=>({status:'ready'}));
  const queue=new AcquisitionExecutionQueue(prepare,1);
  await expect(queue.enqueue('alice','bad',{})).rejects.toThrow('invalid credentials');expect(queue.size).toBe(0);
  expect(await queue.enqueue('alice','duplicate',{})).toEqual({accepted:false});expect(queue.size).toBe(0);
  expect(await queue.enqueue('alice','valid',{})).toEqual({accepted:true});await queue.drain();expect(queue.size).toBe(0);
});
