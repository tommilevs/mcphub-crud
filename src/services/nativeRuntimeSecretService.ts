import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { NativeExecution } from '../types/index.js';
import { interactiveExecutionRequest } from '../utils/nativeExecution.js';

type RuntimeResponse = { ok?: boolean; error?: string; id?: string } & Record<string, unknown>;


/** Send one administrative control request to the installed Windows runtime service. */
const callRuntime = (request: Record<string, unknown>): Promise<RuntimeResponse> => {
  if (process.platform !== 'win32') {
    throw new Error('Native runtime service is available only on Windows');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.MCPHUB_NATIVE_PIPE || '\\\\.\\pipe\\mcphub-runtime');
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error('Native runtime service request timed out')));
    }, 30_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
      socket.destroy();
    };
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += decoder.write(chunk);
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
    socket.once('close', () => finish(() => reject(new Error('Native runtime service connection closed before its response'))));
  });
};

export const putNativeRuntimeSecret = (id: string, value: string): Promise<RuntimeResponse> =>
  callRuntime({ op: 'secret_put', id, value });

export const deleteNativeRuntimeSecret = (id: string): Promise<RuntimeResponse> =>
  callRuntime({ op: 'secret_delete', id });

export const getNativeRuntimeStatus = (execution?: NativeExecution): Promise<RuntimeResponse> => {
  const context=interactiveExecutionRequest(execution,true);
  return callRuntime({op:'status',...(context?{execution_context:context}:{})});
};

export const restartNativeRuntimeProcess = (id: string,execution?: NativeExecution): Promise<RuntimeResponse> => {
  const context=interactiveExecutionRequest(execution,true);
  return callRuntime({op:'restart',id,...(context?{execution_context:context}:{})});
};

// Installer jobs have their own asynchronous lifecycle; they are not MCP streams.
export const startNativeNpmInstall = (id: string, packageName: string, version: string): Promise<RuntimeResponse> =>
  callRuntime({op:'install_start',id,package:packageName,version});
export const getNativeInstallStatus = (id: string): Promise<RuntimeResponse> => callRuntime({op:'install_status',id});
export const cancelNativeInstall = (id: string): Promise<RuntimeResponse> => callRuntime({op:'install_cancel',id});
export const forgetNativeInstall = (id: string): Promise<RuntimeResponse> => callRuntime({op:'install_forget',id});
export const resolveNativeInstalledPackage = (id: string, packageName: string, version: string): Promise<RuntimeResponse> =>
  callRuntime({op:'install_resolve',id,package:packageName,version});

/** Read-only ownership preflight; this never deletes files or credentials. */
export const inspectNativeInstallCleanup = (id: string, packageName: string, version: string): Promise<RuntimeResponse> =>
  callRuntime({op:'install_cleanup_inspect',id,package:packageName,version});
