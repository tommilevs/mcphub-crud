import net from 'node:net';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

type ManagedProcessSpec = {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  secret_env?: Record<string, string>;
  restart_limit?: number;
  restart_delay_ms?: number;
  request_timeout_ms?: number;
  initialize_timeout_ms?: number;
};

type ControlResponse = { responses?: string[]; error?: string } & Record<string, unknown>;
const boundedTimeout=(value:unknown):number=>{
  const parsed=Number(value);
  return Math.trunc(Math.min(3_600_000,Math.max(100,Number.isFinite(parsed)?parsed:60_000)));
};

/**
 * Optional Windows transport backed by the MCPHub service named pipe.
 * It is deliberately opt-in so existing stdio behavior stays unchanged.
 */
export class NativeRuntimeTransport implements Transport {
  private socket?: net.Socket;
  private buffer = '';
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private consume?: () => void;
  private abort?: (error: Error) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly spec: ManagedProcessSpec,
    private readonly pipeName = '\\\\.\\pipe\\mcphub-runtime',
  ) {}

  async start(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('MCPHub native runtime is available only on Windows');
    }
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.pipeName);
      const onError = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => {this.onerror?.(error);this.disconnect();});
        socket.on('close', () => this.disconnect());
        resolve(socket);
      });
    });
    const { secret_env, initialize_timeout_ms: _initializeTimeout, ...spec } = this.spec;
    spec.request_timeout_ms=boundedTimeout(spec.request_timeout_ms??60_000);
    try{await this.control({ op: 'start', spec, ...(secret_env ? { secret_env } : {}) });}
    catch(error){this.disconnect();throw error;}
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const initialize='method' in message&&message.method==='initialize';
    const timeout=boundedTimeout((initialize?this.spec.initialize_timeout_ms:undefined)??this.spec.request_timeout_ms??60_000);
    const result = await this.control({
      op: 'stdio',
      id: this.spec.id,
      message: JSON.stringify(message),
      timeout_ms: timeout,
    });
    for (const response of (result as ControlResponse).responses ?? []) {
      try {
        this.onmessage?.(JSON.parse(response) as JSONRPCMessage);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      // Send the stop command while the pipe is still usable. Marking the
      // transport closed first makes control() reject before it can flush the
      // request, leaving the managed child behind in the native service.
      await this.control({ op: 'stop', id: this.spec.id });
    } finally {
      this.disconnect();
    }
  }

  private onData(chunk: Buffer): void {
    if(this.closed)return;
    this.buffer += chunk.toString('utf8');
    this.consume?.();
  }

  private disconnect():void{
    if(this.closed)return;
    this.closed=true;this.buffer='';this.socket?.destroy();this.socket=undefined;
    this.abort?.(new Error('MCPHub native runtime connection closed'));this.onclose?.();
  }

  private control(request: Record<string, unknown>): Promise<ControlResponse> {
    const operation = this.pending.then(
      () =>
        new Promise<ControlResponse>((resolve, reject) => {
          if (!this.socket || this.closed) {
            reject(new Error('MCPHub native runtime is not connected'));
            return;
          }
          let settled = false;
          let timer: NodeJS.Timeout;
          const finish = (callback: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.consume=undefined;this.abort=undefined;
            callback();
          };
          timer = setTimeout(
            () => finish(() => {this.disconnect();reject(new Error('MCPHub runtime request timed out'));}),
            request.op==='stdio'?Number(request.timeout_ms)+5_000:10_000,
          );
          const poll = () => {
            if (settled) return;
            if (this.closed) {
              finish(() => reject(new Error('MCPHub native runtime connection closed')));
              return;
            }
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) {
              return;
            }
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            try {
              const parsed = JSON.parse(line) as ControlResponse;
              if (parsed.error) finish(() => reject(new Error(parsed.error)));
              else finish(() => resolve(parsed));
            } catch (error) {
              finish(() => {this.disconnect();reject(error);});
            }
          };
          this.consume=poll;this.abort=(error)=>finish(()=>reject(error));
          this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
            if (error) {
              finish(() => {this.disconnect();reject(error);});
              return;
            }
            poll();
          });
        }),
    );
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
