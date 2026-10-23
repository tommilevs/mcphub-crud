import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolResultSummary } from '@/types';
import { saveTaskReview } from '@/services/toolResultHistoryService';

export default function TaskReviewForm({ taskId, review, onSaved }: {
  taskId: string; review?: ToolResultSummary['taskReview']; onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [outcome, setOutcome] = useState(review?.outcome ?? 'unknown');
  const [consent, setConsent] = useState(review?.trainingConsent ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <form className="hub-card p-3 space-y-3" onSubmit={async (event) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await saveTaskReview(taskId, { outcome, trainingConsent: consent, revision: review?.revision ?? 0 });
      if (!response.success) throw new Error(response.message || t('app.error'));
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }}>
    <h2 className="text-sm font-medium">{t('attribution.taskReview', 'Task review')}</h2>
    <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.taskReviewHelp', 'Review the whole task. This does not label every tool call as correct or identify which model caused the outcome.')}</p>
    <label className="block text-xs">{t('attribution.outcome', 'Task outcome')}
      <select className="hub-input mt-1 block" disabled={saving} value={outcome} onChange={(event) => setOutcome(event.target.value)}>
        {['unknown', 'success', 'failure', 'partial', 'abandoned'].map((value) => <option key={value} value={value}>{t(`attribution.outcomes.${value}`, value)}</option>)}
      </select>
    </label>
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} disabled={saving} onChange={(event) => setConsent(event.target.checked)} />{t('attribution.trainingConsent', 'I permit using this task’s data for training after the remaining quality and privacy checks pass.')}</label>
    {review && <p className="text-xs text-[var(--hub-ink-3)]">{review.reviewedBy} · {new Date(review.reviewedAt).toLocaleString()} · #{review.revision}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    <button className="hub-btn" type="submit" disabled={saving}>{saving ? t('app.loading') : t('common.save')}</button>
  </form>;
}
