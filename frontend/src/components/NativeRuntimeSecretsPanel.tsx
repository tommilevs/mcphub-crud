import React, { useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPut } from '@/utils/fetchInterceptor';
import { useToast } from '@/contexts/ToastContext';

const SECRET_ID = /^[A-Za-z0-9_.-]{1,128}$/;
type NativeProcessStatus = { id: string; running: boolean; pid?: number; restarts: number };
type NativeRuntimeStatusResponse = { data?: NativeProcessStatus[] };

/** Admin-only enrollment UI. The value is sent once and never rendered back. */
const NativeRuntimeSecretsPanel: React.FC = () => {
  const { showToast } = useToast();
  const [id, setId] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<NativeProcessStatus[] | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = async () => {
    const response = await apiGet<{ success?: boolean; data?: NativeRuntimeStatusResponse; message?: string }>(
      '/native-runtime/status',
    );
    const processes = response?.data?.data;
    if (response?.success === false || !Array.isArray(processes)) {
      setRuntimeStatus(null);
      setStatusError(response?.message || 'Native runtime unavailable');
      return;
    }
    setStatusError(null);
    setRuntimeStatus(processes);
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

  return (
    <div className="hub-card mb-6 p-5">
      <h2 className="font-medium text-[var(--hub-ink)]">Windows native runtime secrets</h2>
      <p className="mt-1 text-sm text-[var(--hub-ink-2)]">
        Enroll a value under an opaque ID. Values are written to machine-scoped DPAPI storage and are never returned by MCPHub.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className={statusError ? 'text-red-600' : 'text-green-600'}>
          {statusError || `Native runtime online · ${runtimeStatus?.length ?? 0} managed process(es)`}
        </span>
        <button type="button" onClick={() => void refreshStatus()} className="hub-btn secondary !py-1 !px-2">
          Refresh status
        </button>
      </div>
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
