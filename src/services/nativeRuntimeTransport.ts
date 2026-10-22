import net from 'node:net';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server';

type ManagedProcessSpec = {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  restart_limit?: number;
  restart_delay_ms?: number;
};

type ControlResponse = { responses?: string[]; error?: string } & Record<string, unknown>;

/**
 * Optional Windows transport backed by the MCPHub service named pipe.
 * It is deliberately opt-in so existing stdio behavior stays unchanged.
 */
export class NativeRuntimeTransport implements Transport {
  private socket?: net.Socket;
  private buffer = '';
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
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
        socket.on('error', (error) => this.onerror?.(error));
        socket.on('close', () => this.onclose?.());
        resolve(socket);
      });
    });
    await this.control({ op: 'start', spec: this.spec });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const result = await this.control({
      op: 'stdio',
      id: this.spec.id,
      message: JSON.stringify(message),
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
    this.closed = true;
    try {
      await this.control({ op: 'stop', id: this.spec.id });
    } finally {
      this.socket?.destroy();
      this.socket = undefined;
      this.onclose?.();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
  }

  private control(request: Record<string, unknown>): Promise<ControlResponse> {
    const operation = this.pending.then(
      () =>
        new Promise<ControlResponse>((resolve, reject) => {
          if (!this.socket || this.closed) {
            reject(new Error('MCPHub native runtime is not connected'));
            return;
          }
          const timer = setTimeout(() => reject(new Error('MCPHub runtime request timed out')), 30_000);
          const poll = () => {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0) {
              setImmediate(poll);
              return;
            }
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            clearTimeout(timer);
            try {
              const parsed = JSON.parse(line) as ControlResponse;
              if (parsed.error) reject(new Error(parsed.error));
              else resolve(parsed);
            } catch (error) {
              reject(error);
            }
          };
          this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
            if (error) {
              clearTimeout(timer);
              reject(error);
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
