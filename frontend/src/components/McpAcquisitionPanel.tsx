import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import type { Group } from '../types';
import { findAcquisitionCandidates, acquisitionGroups, prepareAcquisitionPlan, approveAcquisitionPlan,
  getAcquisitionOperation, cancelAcquisitionOperation, executeAcquisitionOperation, getAcquisitionPlan,
  acquisitionOperationStatus, acquisitionTerminal,
  type AcquisitionCandidate, type AcquisitionPlan, type AcquisitionOperation } from '../services/acquisitionService';

/** Explicit review surface. Authorization is separate from installation execution. */
export default function McpAcquisitionPanel() {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const [objective, setObjective] = useState('');
  const [candidates, setCandidates] = useState<AcquisitionCandidate[]>();
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState('');
  const [version, setVersion] = useState('');
  const [group, setGroup] = useState('');
  const [probeTool, setProbeTool] = useState('');
  const [plan, setPlan] = useState<AcquisitionPlan>();
  const [operation, setOperation] = useState<AcquisitionOperation>();
  const [key, setKey] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [statusError, setStatusError] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [restoringPlan, setRestoringPlan] = useState(false);
  const epoch = useRef(0);
  const details = useRef<HTMLDetailsElement>(null);
  const storageKey = auth.user?.isAdmin && auth.user.username ? `mcphub-acquisition-operation:${auth.user.username}` : null;
  const scopeOwner = useRef(storageKey);
  const remember = (id?: string) => {
    if (!storageKey) return;
    try { if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey); } catch { /* optional recovery aid */ }
  };
  useEffect(() => {
    scopeOwner.current = storageKey; epoch.current++;
    setCredentials({}); setOperation(undefined); setPlan(undefined); setCandidates(undefined);
    setObjective(''); setSelected(''); setGroups([]); setGroup(''); setVersion(''); setProbeTool('');
    setReviewed(false); setKey(''); setError(''); setStatusError(false); setBusy(false); setRestoringPlan(false);
    if (!storageKey) return;
    let id: string | null = null;
    try { id = sessionStorage.getItem(storageKey); } catch { return; }
    if (!id) return;
    let active = true; const initialEpoch = epoch.current;
    void (async () => {
      try {
        const result = await getAcquisitionOperation(id!);
        if (!active || initialEpoch !== epoch.current) return;
        if (!result.success || !result.data) { setStatusError(true); return; }
        setRestoringPlan(!!result.data.plan_id);
        setOperation(result.data);
        if (result.data.plan_id) {
          const savedPlan = await getAcquisitionPlan(result.data.plan_id);
          if (active && initialEpoch === epoch.current && savedPlan.success && savedPlan.data) setPlan(savedPlan.data);
        }
      } catch { if (active && initialEpoch === epoch.current) setStatusError(true); }
      finally { if (active && initialEpoch === epoch.current) setRestoringPlan(false); }
    })();
    return () => { active = false; };
  }, [storageKey]);
  useEffect(() => { if (operation && details.current) details.current.open = true; }, [operation?.operation_id]);
  const polling = !!auth.user?.isAdmin && scopeOwner.current === storageKey && !!operation && !acquisitionTerminal(operation) && !operation.requires_reconciliation &&
    (operation.state !== 'authorized' || !!operation.execution_started);
  useEffect(() => {
    if (!polling || !operation) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await getAcquisitionOperation(operation.operation_id);
        if (!active) return;
        if (!result.success || !result.data) { setStatusError(true); return; }
        setOperation(result.data); setStatusError(false);
        timer = setTimeout(poll, 3000);
      } catch { if (active) setStatusError(true); }
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [operation?.operation_id, operation?.state, polling, refreshEpoch]);
  if (!auth.user?.isAdmin || scopeOwner.current !== storageKey) return null;
  const clearPlan = () => { epoch.current++; remember(); setPlan(undefined); setOperation(undefined); setReviewed(false); setKey(''); setCredentials({}); setStatusError(false); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { if (scopeOwner.current === storageKey) setError(reason instanceof Error ? reason.message : t('app.error')); }
    finally { if (scopeOwner.current === storageKey) setBusy(false); }
  };
  const search = () => perform(async () => {
    clearPlan(); setSelected(''); setCandidates(undefined);
    const [result, groupResult] = await Promise.all([findAcquisitionCandidates(objective), acquisitionGroups()]);
    if (scopeOwner.current !== storageKey) return;
    if (!result.success || !result.data || !groupResult.success || !groupResult.data) {
      throw new Error(result.message || groupResult.message || t('app.error'));
    }
    setCandidates(result.data.candidates); setGroups(groupResult.data); setGroup('');
  });
  const prepare = () => perform(async () => {
    clearPlan();
    const result = await prepareAcquisitionPlan(selected, version, group, probeTool || undefined);
    if (scopeOwner.current !== storageKey) return;
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setKey(crypto.randomUUID()); setPlan(result.data);
  });
  const approve = () => perform(async () => {
    if (!plan || !reviewed || !key) return;
    if (Date.parse(plan.expires_at) <= Date.now()) {
      setReviewed(false); throw new Error(t('acquisition.expired', 'This plan expired. Prepare a new plan.'));
    }
    const result = await approveAcquisitionPlan(plan, key);
    if (scopeOwner.current !== storageKey) return;
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setOperation(result.data);
    remember(result.data.operation_id);
  });
  const execute = () => perform(async () => {
    if (!operation || !plan) return;
    const result = await executeAcquisitionOperation(operation.operation_id, credentials);
    if (scopeOwner.current !== storageKey) return;
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setCredentials({}); setStatusError(false);
    setOperation({ ...operation, execution_started: true }); setRefreshEpoch(value => value + 1);
  });
  const updateOperation = (cancel = false) => perform(async () => {
    if (!operation) return;
    const result = await (cancel ? cancelAcquisitionOperation : getAcquisitionOperation)(operation.operation_id);
    if (scopeOwner.current !== storageKey) return;
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setOperation(result.data); setStatusError(false); setRefreshEpoch(value => value + 1);
  });
  return <details ref={details} className="mb-5 rounded-lg border border-[var(--hub-line)] bg-[var(--hub-surface)] p-4">
    <summary className="cursor-pointer text-sm font-medium">{t('acquisition.title', 'Find a missing capability')}
      {polling && <span className="ml-2 text-xs text-[var(--hub-ink-3)]">{t('acquisition.inProgress', 'Installation in progress')}</span>}</summary>
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-[var(--hub-ink-3)]">{t('acquisition.help', 'Describe what you need. Catalog matches are suggestions, not verified capabilities. Searching and preparing a plan do not install anything.')}</p>
      {(!operation || acquisitionTerminal(operation)) && <fieldset disabled={busy} className="space-y-3 min-w-0">
        <label className="block space-y-1"><span>{t('acquisition.objective', 'What should the tool do?')}</span>
          <textarea className="hub-input" rows={2} maxLength={2000} value={objective}
            onChange={event => { setObjective(event.target.value); setCandidates(undefined); setSelected(''); clearPlan(); }}/></label>
        <button type="button" className="hub-btn" disabled={!objective.trim()} onClick={search}>{t('acquisition.search', 'Find servers')}</button>
        {candidates?.length === 0 && <p role="status">{t('acquisition.noMatch', 'No matching catalog entries. A missing result does not prove that a new server is required.')}</p>}
        {candidates && candidates.length > 0 && <>
          <label className="block space-y-1"><span>{t('acquisition.server', 'Suggested server')}</span>
            <select aria-label={t('acquisition.server', 'Suggested server')} className="hub-input" value={selected} onChange={event => { setSelected(event.target.value); clearPlan(); }}>
              <option value="">{t('acquisition.choose', 'Choose a server')}</option>
              {candidates.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.displayName || candidate.name}</option>)}
            </select></label>
          {selected && <p className="break-words text-[var(--hub-ink-3)]">{candidates.find(candidate => candidate.name === selected)?.description}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1"><span>{t('acquisition.version', 'Exact release version')}</span>
              <input className="hub-input" placeholder="1.2.3" maxLength={64} value={version} onChange={event => { setVersion(event.target.value); clearPlan(); }}/></label>
            <label className="block space-y-1"><span>{t('acquisition.group', 'Target group')}</span>
              <select aria-label={t('acquisition.group', 'Target group')} className="hub-input" value={group} onChange={event => { setGroup(event.target.value); clearPlan(); }}>
                <option value="">{t('acquisition.chooseGroup', 'Choose a group')}</option>
                {groups.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
          </div>
          <label className="block space-y-1"><span>{t('acquisition.probeTool', 'Optional verification tool to call once with {}')}</span>
            <input className="hub-input" maxLength={255} value={probeTool} onChange={event => { setProbeTool(event.target.value); clearPlan(); }}/>
          </label>
          <p className="text-xs text-[var(--hub-ink-3)]">{t('acquisition.probeHelp', 'Choose only a tool whose effects you understand and permit. Leaving this empty allows discovery only, without calling tools.')}</p>
          <p className="text-xs text-[var(--hub-ink-3)]">{t('acquisition.support', 'Plan preparation currently supports simple npm packages with a fixed release version. Other installers may require manual configuration.')}</p>
          <button type="button" className="hub-btn" disabled={!selected || !version.trim() || !group} onClick={prepare}>{t('acquisition.prepare', 'Prepare plan')}</button>
        </>}
      </fieldset>}
      {(plan || operation) && <section aria-label={t('acquisition.review', 'Review installation plan')} className="space-y-3 border-t border-[var(--hub-line)] pt-3">
        {plan && <dl className="space-y-1 break-words text-xs">
          <div><dt>{t('acquisition.package', 'Package')}</dt><dd className="font-mono">{plan.manifest.package.name}@{plan.manifest.package.version}</dd></div>
          <div><dt>{t('acquisition.group', 'Target group')}</dt><dd>{groups.find(item => item.id === plan.manifest.targetGroup)?.name || plan.manifest.targetGroup}</dd></div>
          <div><dt>{t('acquisition.source', 'Catalog source')}</dt><dd>{plan.manifest.source.repository || t('acquisition.noSource', 'Not specified')}</dd></div>
          <div><dt>{t('acquisition.inputs', 'Required configuration')}</dt><dd>{plan.manifest.requiredInputs.join(', ') || t('acquisition.none', 'None declared')}</dd></div>
          <div><dt>{t('acquisition.probeTool', 'Optional verification tool to call once with {}')}</dt><dd>{plan.manifest.probe?.tool || t('acquisition.discoveryOnly', 'Discovery only; no tool calls authorized')}</dd></div>
          <div><dt>{t('acquisition.expires', 'Expires')}</dt><dd>{new Date(plan.expires_at).toLocaleString()}</dd></div>
          <div><dt>{t('acquisition.digest', 'Plan fingerprint')}</dt><dd className="font-mono break-all">{plan.manifest_digest}</dd></div>
        </dl>}
        {plan && !operation && <>
          <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>
            <span>{t('acquisition.confirm', 'I reviewed this exact package, version, target group and optional verification call and authorize this plan.')}</span></label>
          <button type="button" className="hub-btn" disabled={busy || !reviewed} onClick={approve}>{t('acquisition.authorize', 'Save authorization')}</button>
        </>}
        <p role="status" className="text-xs text-[var(--hub-ink-3)]">{operation?.state === 'authorized' && !operation.execution_started && !plan
          ? restoringPlan ? t('app.loading', 'Loading…') : t('acquisition.savedPlanUnavailable', 'The saved plan is unavailable or expired. Cancel this authorization and prepare a new plan.')
          : operation
          ? t(`acquisition.progress.${acquisitionOperationStatus(operation).key}`, acquisitionOperationStatus(operation).text)
          : t('acquisition.notStarted', 'Nothing has been installed. Review and authorize this plan before starting.')}</p>
        {plan && operation?.state === 'authorized' && !operation.execution_started && !operation.cancel_requested && !operation.requires_reconciliation &&
          <div className="space-y-3">
            {plan.manifest.requiredInputs.map(name => <label key={name} className="block space-y-1"><span>{name}</span>
              <input type="password" autoComplete="off" className="hub-input" disabled={busy} maxLength={16384}
                value={credentials[name] || ''} onChange={event => setCredentials(current => ({ ...current, [name]: event.target.value }))}/></label>)}
            {plan.manifest.requiredInputs.length > 0 && <p className="text-xs text-[var(--hub-ink-3)]">{t('acquisition.credentialsHelp', 'Required values are sent to protected Windows storage and are not written to browser storage.')}</p>}
            <button type="button" className="hub-btn primary" disabled={busy || plan.manifest.requiredInputs.some(name => !credentials[name])}
              onClick={execute}>{t('acquisition.start', 'Start installation')}</button>
          </div>}
        {operation && <div className="flex flex-wrap gap-2">
          <button type="button" className="hub-btn" disabled={busy} onClick={() => updateOperation()}>{t('acquisition.refresh', 'Refresh status')}</button>
          {['authorized', 'staging', 'starting', 'verifying'].includes(operation.state) &&
            <button type="button" className="hub-btn" disabled={busy || operation.cancel_requested} onClick={() => updateOperation(true)}>{t('acquisition.cancel', 'Cancel installation')}</button>}
        </div>}
      </section>}
      {statusError && <p role="alert" className="text-xs text-[var(--hub-err)]">{operation
        ? t('acquisition.refreshPaused', 'Status updates paused. Refresh status to try again.')
        : t('acquisition.restoreFailed', 'Saved installation status is unavailable. Reload this page to retry.')}</p>}
      {busy && <p role="status">{t('app.loading', 'Loading…')}</p>}
      {error && <p role="alert" className="break-words text-[var(--hub-err)]">{error}</p>}
    </div>
  </details>;
}
