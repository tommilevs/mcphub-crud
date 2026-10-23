import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {NativeRuntimeTransport} from '../../src/services/nativeRuntimeTransport.js';
import {LegacyMcpClient} from '../../src/clients/legacyMcpClient.js';
const suite=process.platform==='win32'&&process.env.MCPHUB_NATIVE_TEST_PIPE?describe:describe.skip;
suite('isolated installed Windows SCM service',()=>{
  const pipe=process.env.MCPHUB_NATIVE_TEST_PIPE!,secretRoot=process.env.MCPHUB_NATIVE_TEST_SECRET_DIR!;
  const ids=new Set<string>();
  const control=(request:object)=>new Promise<any>((resolve,reject)=>{
    const socket=net.createConnection(pipe);let buffer='';
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('Acceptance control timed out'));},8000);
    const finish=(error?:Error,value?:any)=>{clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(value);};
    socket.once('error',error=>finish(error));socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{buffer+=chunk.toString();const newline=buffer.indexOf('\n');if(newline>=0){try{finish(undefined,JSON.parse(buffer.slice(0,newline)));}catch(error){finish(error as Error);}}});
  });
  afterEach(async()=>{
    for(const id of ids)await control({op:'stop',id});
    const status=await control({op:'status'});
    for(const id of ids)expect(status.processes.find((row:any)=>row.id===id)?.running).not.toBe(true);
    ids.clear();
  });
  test('real SDK initialize/list/call resolves a DPAPI reference without exposing secret values in status',async()=>{
    const id=`acceptance-${randomUUID()}`,secretId=`fixture-${randomUUID()}`,value=`synthetic-${randomUUID()}`;ids.add(id);
    expect(await control({op:'status'})).toMatchObject({gatewayHealthy:false});
    expect(await control({op:'secret_put',id:secretId,value})).toMatchObject({ok:true});
    const client=new LegacyMcpClient({name:'native-acceptance-client',version:'1'});
    const transport=new NativeRuntimeTransport({id,command:process.execPath,args:[path.resolve('native/tests/stdio-fixture.mjs')],env:{},
      secret_env:{MCPHUB_NATIVE_TEST_SECRET:secretId},request_timeout_ms:5000},pipe);
    try{
      await client.connect(transport);
      expect((await client.listTools()).tools[0].name).toBe('check_secret');
      const result=await client.callTool({name:'check_secret',arguments:{expected:value}});
      expect(result.content).toEqual([{type:'text',text:'{"secretMatches":true}'}]);
      const status=await control({op:'status'});
      expect(status.processes.find((row:any)=>row.id===id)).toMatchObject({state:'RUNNING',protocolReady:true});
      expect(JSON.stringify(status)).not.toContain(value);
      expect((await fs.readFile(path.join(secretRoot,`${secretId}.dpapi`))).includes(Buffer.from(value))).toBe(false);
    }finally{await client.close();await control({op:'secret_delete',id:secretId});}
    await expect(fs.stat(path.join(secretRoot,`${secretId}.dpapi`))).rejects.toMatchObject({code:'ENOENT'});
  },15000);
  test('service watchdog restarts crashed children without dashboard polling and exhausts its budget',async()=>{
    const id=`crash-${randomUUID()}`;ids.add(id);
    expect(await control({op:'start',spec:{id,command:process.execPath,args:['-e','process.exit(17)'],env:{},restart_limit:2,restart_delay_ms:0}})).toHaveProperty('pid');
    await new Promise(resolve=>setTimeout(resolve,2500));
    const status=await control({op:'status'});
    expect(status.processes.find((row:any)=>row.id===id)).toMatchObject({state:'CRASH_LOOP',restarts:2,running:false});
  },10000);
  test('a real pending pipe exchange leaves management responsive and reaches its deadline',async()=>{
    const id=`hung-${randomUUID()}`;ids.add(id);
    await control({op:'start',spec:{id,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{},restart_limit:0,request_timeout_ms:1500}});
    const pending=control({op:'stdio',id,message:'{"jsonrpc":"2.0","id":1,"method":"ping"}'});
    const started=Date.now();expect(await control({op:'status'})).toHaveProperty('processes');expect(Date.now()-started).toBeLessThan(1000);
    expect(await pending).toHaveProperty('error');
  },10000);
});
