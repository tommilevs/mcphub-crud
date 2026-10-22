import net from 'node:net';

type RuntimeResponse = { ok?: boolean; error?: string; id?: string } & Record<string, unknown>;

const PIPE = '\\\\.\\pipe\\mcphub-runtime';

/** Send one administrative control request to the installed Windows runtime service. */
const callRuntime = (request: Record<string, unknown>): Promise<RuntimeResponse> => {
  if (process.platform !== 'win32') {
    throw new Error('Native runtime service is available only on Windows');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Native runtime service request timed out'));
    }, 30_000);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      callback();
      socket.destroy();
    };
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const response = JSON.parse(line) as RuntimeResponse;
        if (response.error) finish(() => reject(new Error(response.error)));
        else finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.once('error', (error) => finish(() => reject(error)));
  });
};

export const putNativeRuntimeSecret = (id: string, value: string): Promise<RuntimeResponse> =>
  callRuntime({ op: 'secret_put', id, value });

export const deleteNativeRuntimeSecret = (id: string): Promise<RuntimeResponse> =>
  callRuntime({ op: 'secret_delete', id });
