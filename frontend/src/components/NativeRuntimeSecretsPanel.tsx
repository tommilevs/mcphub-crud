import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPost, apiPut } from '@/utils/fetchInterceptor';
import { useToast } from '@/contexts/ToastContext';

const SECRET_ID = /^[A-Za-z0-9_.-]{1,128}$/;
type ExecutionContext={kind:'service'}|{kind:'interactive';sessionId:number;pipeName?:string};
type NativeProcessStatus = { id: string; serverName?:string; executionContext?:ExecutionContext; state?: string; running: boolean; pid?: number; restarts: number; restart_limit?: number; protocolReady?: boolean; lastError?: string };
type NativeRuntimeStatusResponse = NativeProcessStatus[] | { processes: NativeProcessStatus[]; gatewayHealthy?: boolean;configurationAvailable?:boolean;agents?:Array<{executionContext:ExecutionContext;available:boolean}> };

/** Admin-only enrollment UI. The value is sent once and never rendered back. */
const NativeRuntimeSecretsPanel: React.FC = () => {
  const { showToast } = useToast();
  const [id, setId] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<NativeProcessStatus[] | null>(null);
  const [gatewayHealthy, setGatewayHealthy] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [unavailableAgents,setUnavailableAgents]=useState<ExecutionContext[]>([]);
  const [configurationAvailable,setConfigurationAvailable]=useState(true);

  const refreshStatus = async () => {
    try {
    const response = await apiGet<{ success?: boolean; data?: NativeRuntimeStatusResponse; message?: string }>(
      '/native-runtime/status?includeInteractive=true',
    );
    const payload = response?.data;
    const processes = Array.isArray(payload) ? payload : payload?.processes;
    if (response?.success === false || !Array.isArray(processes)) {
      setRuntimeStatus(null);
      setGatewayHealthy(null);
      setStatusError(response?.message || 'Native runtime unavailable');
      return;
    }
    setStatusError(null);
    setRuntimeStatus(processes);
    setGatewayHealthy(Array.isArray(payload) || !payload ? null : payload.gatewayHealthy ?? null);
    setUnavailableAgents(Array.isArray(payload)||!payload?[]:(payload.agents??[]).filter(agent=>!agent.available).map(agent=>agent.executionContext));
    setConfigurationAvailable(Array.isArray(payload)||!payload||payload.configurationAvailable!==false);
    }catch(error){
      setStatusError(error instanceof Error?error.message:'Native runtime unavailable');
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const enroll = async (event: React.FormEvent) => {
    event.preventDefault();
    const secretId = id.trim();
    if (!SECRET_ID.test(secretId) || !value) {
      showToast('Use a valid secret ID and enter a value.', 'error');
      return;
    }
    setBusy(true);
    try {
      const response = await apiPut(`/native-runtime/secrets/${encodeURIComponent(secretId)}`, { value });
      if (response?.success === false) throw new Error(response.message || response.error);
      setValue('');
      showToast('Secret enrolled. The value is stored by the Windows runtime.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Native runtime unavailable', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const secretId = id.trim();
    if (!SECRET_ID.test(secretId)) {
      showToast('Enter the secret ID to delete.', 'error');
      return;
    }
    setBusy(true);
    try {
      const response = await apiDelete(`/native-runtime/secrets/${encodeURIComponent(secretId)}`);
      if (response?.success === false) throw new Error(response.message || response.error);
      setValue('');
      showToast('Secret deleted from the Windows runtime.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Native runtime unavailable', 'error');
    } finally {
      setBusy(false);
    }
  };

  const restart = async (processId: string,executionContext?:ExecutionContext) => {
    setBusy(true);
    try {
      const response = await apiPost(`/native-runtime/processes/${encodeURIComponent(processId)}/restart`, executionContext?{executionContext}:{});
      if (response?.success === false) throw new Error(response.message || response.error);
      showToast(`Restart requested for ${processId}.`, 'success');
      await refreshStatus();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Native runtime unavailable', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hub-card mb-6 p-5">
      <h2 className="font-medium text-[var(--hub-ink)]">Windows native runtime secrets</h2>
      <p className="mt-1 text-sm text-[var(--hub-ink-2)]">
        Enroll a value under an opaque ID. Values are written to machine-scoped DPAPI storage and are never returned by MCPHub.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className={statusError ? 'text-red-600' : 'text-green-600'}>
          {statusError || `Native runtime online · ${runtimeStatus?.length ?? 0} managed process(es)${gatewayHealthy === null ? '' : gatewayHealthy ? ' · gateway healthy' : ' · gateway unhealthy'}`}
        </span>
        <button type="button" onClick={() => void refreshStatus()} className="hub-btn secondary !py-1 !px-2">
          Refresh status
        </button>
      </div>
      {unavailableAgents.map(context=>(
        <p key={JSON.stringify(context)} className="mt-2 text-sm text-amber-600">
          User agent unavailable{context.kind==='interactive'?` · Windows session ${context.sessionId}`:''}
        </p>
      ))}
      {!configurationAvailable&&<p className="mt-2 text-sm text-amber-600">Server settings unavailable. Showing Windows service processes only.</p>}
      {runtimeStatus && runtimeStatus.length > 0 && (
        <div className="mt-3 space-y-2">
          {runtimeStatus.map((process) => (
            <div key={`${JSON.stringify(process.executionContext)}:${process.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--hub-line)] px-3 py-2 text-sm">
              <span className="font-medium">{process.serverName||process.id}</span>
              <span className="text-xs text-[var(--hub-ink-2)]">{process.executionContext?.kind==='interactive'?`Windows session ${process.executionContext.sessionId}`:'Windows service'}</span>
              <span className={process.running ? 'text-green-600' : 'text-amber-600'}>
                {process.state || (process.running ? 'RUNNING' : 'STOPPED')} · {process.restarts}/{process.restart_limit ?? '—'} restarts
              </span>
              {process.lastError && <span className="basis-full text-xs text-red-600">{process.lastError}</span>}
              <button type="button" disabled={busy} onClick={() => void restart(process.id,process.executionContext)} className="hub-btn secondary !py-1 !px-2">Restart</button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={enroll} className="mt-4 grid gap-3 md:grid-cols-[220px_1fr_auto_auto]">
        <input value={id} onChange={(event) => setId(event.target.value)} className="form-input px-3 py-2" placeholder="github-token" maxLength={128} aria-label="Secret ID" />
        <input type="password" value={value} onChange={(event) => setValue(event.target.value)} className="form-input px-3 py-2" placeholder="Secret value (never shown again)" maxLength={65536} autoComplete="new-password" aria-label="Secret value" />
        <button type="submit" disabled={busy} className="hub-btn primary">Enroll / replace</button>
        <button type="button" disabled={busy} onClick={remove} className="hub-btn secondary">Delete</button>
      </form>
    </div>
  );
};

export default NativeRuntimeSecretsPanel;
