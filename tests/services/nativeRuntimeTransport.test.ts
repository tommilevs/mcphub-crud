import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {NativeRuntimeTransport} from '../../src/services/nativeRuntimeTransport.js';
import {getNativeRuntimeStatus} from '../../src/services/nativeRuntimeSecretService.js';
const suite=process.platform==='win32'?describe:describe.skip;
suite('native transport over a real isolated Windows named pipe',()=>{
  let server:net.Server,pipe:string,sockets:net.Socket[],requests:any[],handler:(request:any,socket:net.Socket)=>void;
  beforeEach(async()=>{
    pipe=`\\\\.\\pipe\\mcphub-test-${randomUUID()}`;sockets=[];requests=[];
    handler=(request,socket)=>socket.write(JSON.stringify(request.op==='start'?{pid:1}:{ok:true})+'\n');
    server=net.createServer(socket=>{
      sockets.push(socket);socket.on('error',()=>{});let buffer='';
      socket.on('data',chunk=>{buffer+=chunk.toString();let newline;
        while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);const request=JSON.parse(line);requests.push(request);handler(request,socket);}
      });
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
  });
  afterEach(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const transport=()=>new NativeRuntimeTransport({id:'fixture',command:'unused.exe',args:[],env:{},request_timeout_ms:100},pipe);
  test('configured service pipe is shared by transports and administrative requests',async()=>{
    const previous=process.env.MCPHUB_NATIVE_PIPE;
    process.env.MCPHUB_NATIVE_PIPE=pipe;
    const client=new NativeRuntimeTransport({id:'configured',command:'unused.exe',args:[],env:{}});
    try {
      await client.start();
      await expect(getNativeRuntimeStatus()).resolves.toMatchObject({ok:true});
      await client.close();
      expect(requests.map(request=>request.op)).toEqual(['start','status','stop']);
    } finally {
      await client.close();
      if(previous===undefined)delete process.env.MCPHUB_NATIVE_PIPE;else process.env.MCPHUB_NATIVE_PIPE=previous;
    }
  });
  test('receives a fragmented reply without polling and forwards matching MCP frames',async()=>{
    handler=(request,socket)=>{
      if(request.op!=='stdio'){socket.write('{"ok":true}\n');return;}
      const reply=JSON.stringify({responses:[JSON.stringify({jsonrpc:'2.0',id:7,result:{ok:true}})]})+'\n';
      socket.write(reply.slice(0,10));setTimeout(()=>socket.write(reply.slice(10)),20);
    };
    const client=transport(),onmessage=jest.fn(),onclose=jest.fn();client.onmessage=onmessage;client.onclose=onclose;
    await client.start();await client.send({jsonrpc:'2.0',id:7,method:'ping'});
    expect(onmessage).toHaveBeenCalledWith({jsonrpc:'2.0',id:7,result:{ok:true}});
    await client.close();expect(onclose).toHaveBeenCalledTimes(1);expect(requests.map(request=>request.op)).toEqual(['start','stdio','stop']);
  });
  test('deadline closes the stream so a late reply cannot be consumed by a later call',async()=>{
    handler=(request,socket)=>{if(request.op==='start')socket.write('{"ok":true}\n');};
    const client=transport(),onclose=jest.fn();client.onclose=onclose;await client.start();
    await expect(client.send({jsonrpc:'2.0',id:1,method:'ping'})).rejects.toThrow(/timed out/);
    await expect(client.send({jsonrpc:'2.0',id:2,method:'ping'})).rejects.toThrow(/not connected/);
    await client.close();expect(onclose).toHaveBeenCalledTimes(1);expect(requests.filter(request=>request.op==='stdio')).toHaveLength(1);
  },10000);
  test('failed start disconnects without stopping a process owned by another session',async()=>{
    handler=(_request,socket)=>socket.write('{"error":"managed process already exists"}\n');
    const client=transport();await expect(client.start()).rejects.toThrow(/already exists/);
    await client.close();expect(requests.map(request=>request.op)).toEqual(['start']);
  });
  test('forwards distinct integer initialization and tool deadlines without leaking Node-only settings into the spawn spec',async()=>{
    handler=(request,socket)=>socket.write(JSON.stringify(request.op==='stdio'?{responses:[JSON.stringify({jsonrpc:'2.0',id:JSON.parse(request.message).id,result:{}})]}:{ok:true})+'\n');
    const client=new NativeRuntimeTransport({id:'fixture',command:'unused.exe',args:[],env:{},request_timeout_ms:200.9,initialize_timeout_ms:1000},pipe);
    await client.start();await client.send({jsonrpc:'2.0',id:1,method:'initialize'});await client.send({jsonrpc:'2.0',id:2,method:'ping'});await client.close();
    expect(requests[0].spec).not.toHaveProperty('initialize_timeout_ms');
    expect(requests[0].spec.request_timeout_ms).toBe(200);
    expect(requests.filter(request=>request.op==='stdio').map(request=>request.timeout_ms)).toEqual([1000,200]);
  });
  test('a streaming-capable client falls back to an older batch service without replaying start',async()=>{
    handler=(request,socket)=>socket.write(JSON.stringify(request.op==='stdio'?{responses:[JSON.stringify({jsonrpc:'2.0',id:7,result:{}})]}:{ok:true})+'\n');
    const client=new NativeRuntimeTransport({id:'older-service',command:'unused.exe',args:[],env:{},streaming:true},pipe),received=jest.fn();
    client.onmessage=received;await client.start();await client.send({jsonrpc:'2.0',id:7,method:'ping'});await client.close();
    expect(received).toHaveBeenCalledWith({jsonrpc:'2.0',id:7,result:{}});
    expect(requests.map(request=>request.op)).toEqual(['start','stdio','stop']);
    expect(requests[0]).toMatchObject({stream:true,spec:{server_name:'older-service',id:client.processId}});
  });
  test('UTF-8 text survives a named-pipe chunk boundary inside a multibyte character',async()=>{
    const text='Диагностика ✓';
    handler=(request,socket)=>{
      if(request.op!=='stdio'){socket.write('{"ok":true}\n');return;}
      const bytes=Buffer.from(JSON.stringify({responses:[JSON.stringify({jsonrpc:'2.0',id:7,result:{text}})]})+'\n');
      const split=bytes.indexOf(Buffer.from('Д'))+1;
      socket.write(bytes.subarray(0,split));setTimeout(()=>socket.write(bytes.subarray(split)),20);
    };
    const client=transport(),received=jest.fn();client.onmessage=received;
    try{await client.start();await client.send({jsonrpc:'2.0',id:7,method:'ping'});expect(received).toHaveBeenCalledWith({jsonrpc:'2.0',id:7,result:{text}});}
    finally{await client.close();}
  });
});
