import net from 'node:net';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {NativeRuntimeTransport} from '../../src/services/nativeRuntimeTransport.js';
import {LegacyMcpClient} from '../../src/clients/legacyMcpClient.js';
const suite=process.platform==='win32'&&process.env.MCPHUB_NATIVE_USER_PIPE?describe:describe.skip;
suite('interactive Windows runtime agent',()=>{
  const pipe=process.env.MCPHUB_NATIVE_USER_PIPE!;
  const control=(request:object)=>new Promise<any>((resolve,reject)=>{
    const socket=net.createConnection(pipe);let data='';
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('Agent control timed out'));},3000);
    socket.once('error',error=>{clearTimeout(timer);reject(error);});
    socket.once('connect',()=>socket.write(JSON.stringify(request)+'\n'));
    socket.on('data',chunk=>{data+=chunk.toString();if(!data.includes('\n'))return;clearTimeout(timer);socket.destroy();resolve(JSON.parse(data.split('\n')[0]));});
  });
  beforeAll(async()=>{
    const until=Date.now()+10000;
    while(true){try{await control({op:'status'});return;}catch(error){if(Date.now()>until)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}
  });
  test('real SDK calls run in the signed-in session and closing the lease stops the child',async()=>{
    const transport=new NativeRuntimeTransport({id:'interactive-fixture',command:process.execPath,
      args:[path.resolve('native/tests/stdio-fixture.mjs')],env:{MCPHUB_NATIVE_TEST_SECRET:'synthetic-user-value'},streaming:true},pipe);
    const client=new LegacyMcpClient({name:'user-agent-acceptance',version:'1'});
    let pid=0;
    try{
      await client.connect(transport);
      expect((await client.listTools()).tools[0].name).toBe('check_secret');
      const result=await client.callTool({name:'check_secret',arguments:{expected:'synthetic-user-value'}});
      expect(result.content).toEqual([{type:'text',text:'{"secretMatches":true}'}]);
      const status=await control({op:'status'});
      expect(status).toMatchObject({executionContext:'interactive',sessionId:Number(process.env.MCPHUB_NATIVE_USER_SESSION),gatewayHealthy:false});
      expect(status.sessionId).toBeGreaterThan(0);
      pid=status.processes.find((row:any)=>row.id===transport.processId).pid;
      const childSession=Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${pid}).SessionId`],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
      expect(childSession).toBe(status.sessionId);
    }finally{await client.close();}
    expect((await control({op:'status'})).processes).not.toEqual(expect.arrayContaining([expect.objectContaining({id:transport.processId})]));
    expect(()=>process.kill(pid,0)).toThrow();
  },15000);
  test('machine credential operations and references are unavailable in the agent',async()=>{
    expect(await control({op:'start',execution_context:{kind:'interactive',session_id:0},
      spec:{id:'recursive-delegation',command:'nonexistent-recursive-agent-fixture',args:[],env:{}}}))
      .toHaveProperty('error','interactive delegation requires the machine service');
    for(const op of ['secret_put','secret_delete'])expect(await control({op,id:'machine-only',value:'synthetic'})).toHaveProperty('error','credentials unavailable in user agent');
    expect(await control({op:'start',spec:{id:'denied',command:process.execPath,args:[],env:{}},secret_env:{TOKEN:'machine-only'}}))
      .toHaveProperty('error','credentials unavailable in user agent');
    expect((await control({op:'status'})).processes).toHaveLength(0);
  });
  test('managed stdio starts in its explicit working directory',async()=>{
    const cwd=path.resolve('native');
    const transport=new NativeRuntimeTransport({id:'working-directory-fixture',command:process.execPath,
      args:[path.resolve('native/tests/stdio-fixture.mjs')],env:{},streaming:true,cwd},pipe);
    const client=new LegacyMcpClient({name:'working-directory-acceptance',version:'1'});
    try{
      await client.connect(transport);
      expect((await client.callTool({name:'working_directory',arguments:{expected:cwd}})).content)
        .toEqual([{type:'text',text:'{"cwdMatches":true}'}]);
    }finally{await client.close();}
    expect(await control({op:'start',spec:{id:'relative-cwd-denied',command:process.execPath,args:[],env:{},cwd:'relative'}}))
      .toMatchObject({error:expect.stringContaining('working directory must be absolute')});
  });
  test('the user agent supervises crashes without service or dashboard polling',async()=>{
    const id='user-agent-crash';
    try{
      expect(await control({op:'start',spec:{id,command:process.execPath,args:['-e','process.exit(17)'],env:{},restart_limit:2,restart_delay_ms:0}})).toHaveProperty('pid');
      await new Promise(resolve=>setTimeout(resolve,1800));
      expect((await control({op:'status'})).processes.find((row:any)=>row.id===id)).toMatchObject({state:'CRASH_LOOP',restarts:2,running:false});
    }finally{await control({op:'stop',id});}
  },10000);
});
