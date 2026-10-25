import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import type { Group } from '../types';
import { findAcquisitionCandidates, acquisitionGroups, prepareAcquisitionPlan, approveAcquisitionPlan,
  getAcquisitionOperation, cancelAcquisitionOperation,
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
  if (!auth.user?.isAdmin) return null;
  const clearPlan = () => { setPlan(undefined); setOperation(undefined); setReviewed(false); setKey(''); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : t('app.error')); }
    finally { setBusy(false); }
  };
  const search = () => perform(async () => {
    clearPlan(); setSelected(''); setCandidates(undefined);
    const [result, groupResult] = await Promise.all([findAcquisitionCandidates(objective), acquisitionGroups()]);
    if (!result.success || !result.data || !groupResult.success || !groupResult.data) {
      throw new Error(result.message || groupResult.message || t('app.error'));
    }
    setCandidates(result.data.candidates); setGroups(groupResult.data); setGroup('');
  });
  const prepare = () => perform(async () => {
    clearPlan();
    const result = await prepareAcquisitionPlan(selected, version, group, probeTool || undefined);
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setKey(crypto.randomUUID()); setPlan(result.data);
  });
  const approve = () => perform(async () => {
    if (!plan || !reviewed || !key) return;
    if (Date.parse(plan.expires_at) <= Date.now()) {
      setReviewed(false); throw new Error(t('acquisition.expired', 'This plan expired. Prepare a new plan.'));
    }
    const result = await approveAcquisitionPlan(plan, key);
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setOperation(result.data);
  });
  const updateOperation = (cancel = false) => perform(async () => {
    if (!operation) return;
    const result = await (cancel ? cancelAcquisitionOperation : getAcquisitionOperation)(operation.operation_id);
    if (!result.success || !result.data) throw new Error(result.message || t('app.error'));
    setOperation(result.data);
  });
  return <details className="mb-5 rounded-lg border border-[var(--hub-line)] bg-[var(--hub-surface)] p-4">
    <summary className="cursor-pointer text-sm font-medium">{t('acquisition.title', 'Find a missing capability')}</summary>
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-[var(--hub-ink-3)]">{t('acquisition.help', 'Describe what you need. Catalog matches are suggestions, not verified capabilities. Searching and preparing a plan do not install anything.')}</p>
      <fieldset disabled={busy} className="space-y-3 min-w-0">
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
      </fieldset>
      {plan && <section aria-label={t('acquisition.review', 'Review installation plan')} className="space-y-3 border-t border-[var(--hub-line)] pt-3">
        <dl className="space-y-1 break-words text-xs">
          <div><dt>{t('acquisition.package', 'Package')}</dt><dd className="font-mono">{plan.manifest.package.name}@{plan.manifest.package.version}</dd></div>
          <div><dt>{t('acquisition.group', 'Target group')}</dt><dd>{groups.find(item => item.id === plan.manifest.targetGroup)?.name || plan.manifest.targetGroup}</dd></div>
          <div><dt>{t('acquisition.source', 'Catalog source')}</dt><dd>{plan.manifest.source.repository || t('acquisition.noSource', 'Not specified')}</dd></div>
          <div><dt>{t('acquisition.inputs', 'Required configuration')}</dt><dd>{plan.manifest.requiredInputs.join(', ') || t('acquisition.none', 'None declared')}</dd></div>
          <div><dt>{t('acquisition.probeTool', 'Optional verification tool to call once with {}')}</dt><dd>{plan.manifest.probe?.tool || t('acquisition.discoveryOnly', 'Discovery only; no tool calls authorized')}</dd></div>
          <div><dt>{t('acquisition.expires', 'Expires')}</dt><dd>{new Date(plan.expires_at).toLocaleString()}</dd></div>
          <div><dt>{t('acquisition.digest', 'Plan fingerprint')}</dt><dd className="font-mono break-all">{plan.manifest_digest}</dd></div>
        </dl>
        {!operation && <>
          <label className="flex items-start gap-2"><input type="checkbox" disabled={busy} checked={reviewed} onChange={event => setReviewed(event.target.checked)}/>
            <span>{t('acquisition.confirm', 'I reviewed this exact package, version, target group and optional verification call and authorize this plan.')}</span></label>
          <button type="button" className="hub-btn" disabled={busy || !reviewed} onClick={approve}>{t('acquisition.authorize', 'Save authorization')}</button>
        </>}
        <p role="status" className="text-xs text-[var(--hub-ink-3)]">{!operation
          ? t('acquisition.notStarted', 'Nothing has been installed. This screen records authorization only.')
          : operation.requires_reconciliation
            ? t('acquisition.uncertain', 'Execution state is uncertain. Review is required before retrying; no automatic restart will occur.')
          : operation.state === 'verifying' && operation.verification === 'functional'
            ? t('acquisition.verifiedPending', 'Verification passed. Publication of tools is pending.')
          : operation.state === 'verifying' && operation.verification === 'discovery_only'
            ? t('acquisition.discoveredPending', 'Tool discovery completed. No functional call was authorized and tools have not been published.')
          : operation.state === 'authorized'
            ? t('acquisition.authorizedPending', 'Authorization saved. Installation has not started; the execution worker is not connected yet.')
            : operation.state === 'cancelled'
              ? t('acquisition.cancelled', 'Cancelled before execution.')
              : operation.cancel_requested && !['ready', 'failed', 'rolled_back'].includes(operation.state)
                ? t('acquisition.cancelling', 'Cancellation requested. Waiting for the worker to finish cleanup.')
                : t(`acquisition.state.${operation.state}`, operation.state)}</p>
        {operation && <div className="flex flex-wrap gap-2">
          <button type="button" className="hub-btn" disabled={busy} onClick={() => updateOperation()}>{t('acquisition.refresh', 'Refresh status')}</button>
          {['authorized', 'staging', 'starting', 'verifying'].includes(operation.state) &&
            <button type="button" className="hub-btn" disabled={busy || operation.cancel_requested} onClick={() => updateOperation(true)}>{t('acquisition.cancel', 'Cancel installation')}</button>}
        </div>}
      </section>}
      {busy && <p role="status">{t('app.loading', 'Loading…')}</p>}
      {error && <p role="alert" className="break-words text-[var(--hub-err)]">{error}</p>}
    </div>
  </details>;
}
