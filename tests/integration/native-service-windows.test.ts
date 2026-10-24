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
  const control=(request:object,target=pipe)=>new Promise<any>((resolve,reject)=>{
    const socket=net.createConnection(target);let buffer='';
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('Acceptance control timed out'));},8000);
    const finish=(error?:Error,value?:any)=>{clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(value);};
    socket.once('error',error=>finish(error));socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{buffer+=chunk.toString();const newline=buffer.indexOf('\n');if(newline>=0){try{finish(undefined,JSON.parse(buffer.slice(0,newline)));}catch(error){finish(error as Error);}}});
  });
  test('service delegates a secret-backed SDK stream to the explicit user session and cleans its lease',async()=>{
    const agentName=process.env.MCPHUB_NATIVE_TEST_AGENT_PIPE!;
    const agentPipe=`\\\\.\\pipe\\${agentName}`;
    const session=Number(process.env.MCPHUB_NATIVE_TEST_AGENT_SESSION);
    expect(session).toBeGreaterThan(0);
    const id=`delegated-${randomUUID()}`,secretId=`delegated-${randomUUID()}`,value=`synthetic-${randomUUID()}`;
    await control({op:'secret_put',id:secretId,value});
    const transport=new NativeRuntimeTransport({id,command:process.execPath,args:[path.resolve('native/tests/stdio-fixture.mjs')],env:{},streaming:true,
      secret_env:{MCPHUB_NATIVE_TEST_SECRET:secretId},execution_context:{kind:'interactive',session_id:session,pipe_name:agentName}},pipe);
    const client=new LegacyMcpClient({name:'delegated-acceptance',version:'1'});
    let childPid=0;
    try{
      await client.connect(transport);
      expect((await client.listTools()).tools[0].name).toBe('check_secret');
      expect((await client.callTool({name:'check_secret',arguments:{expected:value}})).content)
        .toEqual([{type:'text',text:'{"secretMatches":true}'}]);
      const agent=await control({op:'status'},agentPipe);
      expect(agent).toMatchObject({executionContext:'interactive',sessionId:session});
      childPid=agent.processes.find((p:any)=>p.id===transport.processId).pid;
      expect((await control({op:'status'})).processes.some((p:any)=>p.id===transport.processId)).toBe(false);
      expect(JSON.stringify(agent)).not.toContain(value);
    }finally{await client.close();await control({op:'secret_delete',id:secretId});}
    const deadline=Date.now()+3000;
    while((await control({op:'status'},agentPipe)).processes.some((p:any)=>p.id===transport.processId)){
      if(Date.now()>deadline)throw new Error('Delegated lease survived disconnect');
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    expect(()=>process.kill(childPid,0)).toThrow();
  },15000);
  test('delegation rejects session ambiguity and counterfeit agent before resolving any secret',async()=>{
    const spec={id:`denied-${randomUUID()}`,command:process.execPath,args:[],env:{}};
    expect(await control({op:'start',stream:true,spec,execution_context:{kind:'interactive',session_id:0}}))
      .toHaveProperty('error','interactive execution requires an explicit nonzero Windows session id');
    expect(await control({op:'start',stream:true,spec,execution_context:{kind:'interactive',
      session_id:Number(process.env.MCPHUB_NATIVE_TEST_AGENT_SESSION)+1,pipe_name:process.env.MCPHUB_NATIVE_TEST_AGENT_PIPE}}))
      .toHaveProperty('error','agent Windows session mismatch');
    const spoof=`mcphub-user-counterfeit-${randomUUID()}`;
    const server=net.createServer(socket=>socket.on('error',()=>{}));
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(`\\\\.\\pipe\\${spoof}`,resolve);});
    try{
      expect(await control({op:'start',stream:true,spec,secret_env:{TOKEN:'nonexistent-secret'},
        execution_context:{kind:'interactive',session_id:Number(process.env.MCPHUB_NATIVE_TEST_AGENT_SESSION),pipe_name:spoof}}))
        .toHaveProperty('error','agent executable mismatch');
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
    expect((await control({op:'status'})).processes.some((p:any)=>p.id===spec.id)).toBe(false);
  },10000);
  afterEach(async()=>{
    for(const id of ids)await control({op:'stop',id});
    const status=await control({op:'status'});
    for(const id of ids)expect(status.processes.find((row:any)=>row.id===id)?.running).not.toBe(true);
    ids.clear();
  });
  test('real SDK initialize/list/call resolves a DPAPI reference without exposing secret values in status',async()=>{
    const id=`acceptance-${randomUUID()}`,secretId=`fixture-${randomUUID()}`,value=`synthetic-${randomUUID()}`;ids.add(id);
    const serviceStatus=await control({op:'status'});
    expect(serviceStatus).toMatchObject({executionContext:'service',sessionId:0});
    expect(typeof serviceStatus.gatewayHealthy).toBe('boolean');
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
  test.each([false,true])('live duplex preserves progress, server requests and cancellation (interactive=%s)',async(interactive)=>{
    const name=`duplex-${randomUUID()}`;
    const execution_context=interactive?{kind:'interactive' as const,session_id:Number(process.env.MCPHUB_NATIVE_TEST_AGENT_SESSION),pipe_name:process.env.MCPHUB_NATIVE_TEST_AGENT_PIPE}:undefined;
    const transport=new NativeRuntimeTransport({id:name,command:process.execPath,args:[path.resolve('native/tests/stdio-fixture.mjs')],env:{},streaming:true,execution_context},pipe);
    ids.add(transport.processId);
    const client=new LegacyMcpClient({name:'duplex-acceptance',version:'1'});
    let answered=0,progress=0;client.setRequestHandler('ping',async()=>{answered++;return {};});
    try{
      await client.connect(transport);await client.listTools();
      const receive=transport.onmessage;
      transport.onmessage=message=>{if('method' in message&&message.method==='notifications/progress')progress++;receive?.(message);};
      expect((await client.callTool({name:'duplex',arguments:{}},{timeout:5000})).content).toEqual([{type:'text',text:'duplex-complete'}]);
      expect(answered).toBe(1);expect(progress).toBe(1);
      const abort=new AbortController();
      const pending=client.callTool({name:'hang',arguments:{}},{signal:abort.signal,timeout:5000}).then(()=>null,error=>error);
      await new Promise(resolve=>setTimeout(resolve,100));abort.abort();expect(await pending).not.toBeNull();
      const counts=await client.callTool({name:'counts',arguments:{}},{timeout:5000});
      expect(counts.content).toEqual([{type:'text',text:'{"cancelled":1}'}]);
    }finally{await client.close();}
  },15000);
  test('two connections with the same logical server name own different process generations',async()=>{
    const name=`shared-${randomUUID()}`;
    const spec={id:name,command:process.execPath,args:[path.resolve('native/tests/stdio-fixture.mjs')],env:{},streaming:true};
    const first=new NativeRuntimeTransport(spec,pipe),second=new NativeRuntimeTransport(spec,pipe);
    ids.add(first.processId);ids.add(second.processId);expect(first.processId).not.toBe(second.processId);
    const a=new LegacyMcpClient({name:'a',version:'1'}),b=new LegacyMcpClient({name:'b',version:'1'});
    try{
      await a.connect(first);await b.connect(second);await a.close();
      expect((await b.callTool({name:'counts',arguments:{}},{timeout:5000})).content).toEqual([{type:'text',text:'{"cancelled":0}'}]);
      expect((await control({op:'status'})).processes.find((row:any)=>row.id===second.processId)).toMatchObject({serverName:name,running:true});
    }finally{await a.close();await b.close();}
  },15000);
  test('abrupt stream disconnect releases its process lease and does not retain an orphan',async()=>{
    const id=`disconnect-${randomUUID()}`;ids.add(id);
    const socket=net.createConnection(pipe);socket.on('error',()=>{});
    const started=await new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.destroy();reject(new Error('Lease start timeout'));},5000);let buffer='';
      socket.once('connect',()=>socket.write(JSON.stringify({op:'start',stream:true,spec:{id,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}}})+'\n'));
      socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.includes('\n')){clearTimeout(timer);resolve(JSON.parse(buffer.split('\n')[0]));}});
    });
    expect(started).toMatchObject({id,streaming:true});socket.destroy();
    let status;
    for(let attempt=0;attempt<50;attempt++){
      status=await control({op:'status'});if(!status.processes.some((row:any)=>row.id===id))break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(status.processes.some((row:any)=>row.id===id)).toBe(false);
    let missing=false;try{process.kill(started.pid,0);}catch(error){missing=(error as NodeJS.ErrnoException).code==='ESRCH';}
    expect(missing).toBe(true);
  },10000);
});
