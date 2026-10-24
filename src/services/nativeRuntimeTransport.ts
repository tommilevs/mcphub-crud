import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import type {JSONRPCMessage,Transport} from '@modelcontextprotocol/server';
type ManagedProcessSpec={id:string;command:string;args:string[];env:Record<string,string>;secret_env?:Record<string,string>;
  restart_limit?:number;restart_delay_ms?:number;request_timeout_ms?:number;initialize_timeout_ms?:number;streaming?:boolean};
type ControlResponse={responses?:string[];error?:string;streaming?:boolean}&Record<string,unknown>;
const boundedTimeout=(value:unknown):number=>{const parsed=Number(value);return Math.trunc(Math.min(3_600_000,Math.max(100,Number.isFinite(parsed)?parsed:60_000)));};
/** Optional native transport: negotiates live duplex IPC, retaining legacy batch compatibility. */
export class NativeRuntimeTransport implements Transport {
  private socket?:net.Socket;
  private buffer='';
  private readonly decoder=new StringDecoder('utf8');
  private pending:Promise<unknown>=Promise.resolve();
  private closed=false;
  private closing=false;
  private streaming=false;
  private consume?:(response:ControlResponse)=>void;
  private abort?:(error:Error)=>void;
  readonly processId:string;
  onclose?:()=>void;
  onerror?:(error:Error)=>void;
  onmessage?:(message:JSONRPCMessage)=>void;
  constructor(private readonly spec:ManagedProcessSpec,private readonly pipeName=process.env.MCPHUB_NATIVE_PIPE||'\\\\.\\pipe\\mcphub-runtime'){
    this.processId=spec.streaming?`${spec.id.replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,80)||'server'}-${randomUUID().replace(/-/g,'')}`:spec.id;
  }
  async start():Promise<void>{
    if(process.platform!=='win32')throw new Error('MCPHub native runtime is available only on Windows');
    if(this.closed||this.socket)throw new Error('Create a new native transport for each connection');
    this.socket=await new Promise<net.Socket>((resolve,reject)=>{
      const socket=net.createConnection(this.pipeName);
      const failed=(error:Error)=>{socket.destroy();reject(error);};socket.once('error',failed);
      socket.once('connect',()=>{
        socket.off('error',failed);socket.on('data',chunk=>this.onData(chunk));
        socket.on('error',error=>{this.onerror?.(error);this.disconnect();});socket.on('close',()=>this.disconnect());resolve(socket);
      });
    });
    const {secret_env,initialize_timeout_ms:_init,streaming,...spec}=this.spec;
    try{await this.control({op:'start',spec:{...spec,id:this.processId,server_name:this.spec.id,request_timeout_ms:boundedTimeout(spec.request_timeout_ms??60_000)},
      ...(secret_env?{secret_env}:{}),...(streaming?{stream:true}:{})});}
    catch(error){this.disconnect();throw error;}
  }
  async send(message:JSONRPCMessage):Promise<void>{
    if(this.closing)throw new Error('MCPHub native runtime is closing');
    const initialize='method' in message&&message.method==='initialize';
    const timeout=this.streaming?10_000:boundedTimeout((initialize?this.spec.initialize_timeout_ms:undefined)??this.spec.request_timeout_ms??60_000);
    const response=await this.control({op:this.streaming?'stdio_send':'stdio',id:this.processId,message:JSON.stringify(message),timeout_ms:timeout});
    for(const frame of response.responses??[]){try{this.onmessage?.(JSON.parse(frame) as JSONRPCMessage);}catch(error){this.onerror?.(error instanceof Error?error:new Error(String(error)));}}
  }
  async close():Promise<void>{
    if(this.closed||this.closing)return;this.closing=true;
    try{await this.control({op:'stop',id:this.processId});}finally{this.disconnect();}
  }
  private onData(chunk:Buffer):void{
    if(this.closed)return;this.buffer+=this.decoder.write(chunk);let newline;
    while(!this.closed&&(newline=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
      try{
        const value=JSON.parse(line);
        if(value.event){
          if(value.id!==this.processId)throw new Error('Native stream process mismatch');
          if(value.event==='stdio')this.onmessage?.(JSON.parse(value.message) as JSONRPCMessage);
          else if(value.event==='closed'&&!this.closing){this.onerror?.(new Error(value.error||'Native stdio stream closed'));this.disconnect();}
        }else if(this.consume)this.consume(value as ControlResponse);
        else throw new Error('Unexpected native control response');
      }catch(error){this.onerror?.(error instanceof Error?error:new Error(String(error)));this.disconnect();}
    }
  }
  private disconnect():void{
    if(this.closed)return;this.closed=true;this.buffer='';this.decoder.end();this.socket?.destroy();this.socket=undefined;
    this.abort?.(new Error('MCPHub native runtime connection closed'));this.onclose?.();
  }
  private control(request:Record<string,unknown>):Promise<ControlResponse>{
    const operation=this.pending.then(()=>new Promise<ControlResponse>((resolve,reject)=>{
      if(!this.socket||this.closed){reject(new Error('MCPHub native runtime is not connected'));return;}
      let settled=false;let timer:NodeJS.Timeout;
      const finish=(callback:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);this.consume=undefined;this.abort=undefined;callback();};
      timer=setTimeout(()=>finish(()=>{this.disconnect();reject(new Error('MCPHub runtime request timed out'));}),
        request.op==='stdio'||request.op==='stdio_send'?Number(request.timeout_ms)+5000:10_000);
      this.consume=response=>{
        if(request.op==='start')this.streaming=response.streaming===true;
        if(response.error)finish(()=>{if(request.op==='stdio_send')this.disconnect();reject(new Error(response.error));});
        else finish(()=>resolve(response));
      };
      this.abort=error=>finish(()=>reject(error));
      this.socket.write(`${JSON.stringify(request)}\n`,error=>{if(error)finish(()=>{this.disconnect();reject(error);});});
    }));
    this.pending=operation.catch(()=>undefined);return operation;
  }
}
