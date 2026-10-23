import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolResultSummary } from '@/types';
import { saveToolResultReview } from '@/services/toolResultHistoryService';

export default function ToolResultReviewForm({ resultId, digest, review, onSaved }: {
  resultId: string; digest: string; review?: ToolResultSummary['resultReview']; onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [quality, setQuality] = useState(review?.quality ?? 'unknown');
  const [privacy, setPrivacy] = useState(review?.privacy ?? 'unreviewed');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <form className="hub-card p-3 space-y-3" onSubmit={async event => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await saveToolResultReview(resultId, { quality, privacy, revision: review?.revision ?? 0, rawSha256: digest });
      if (!response.success) throw new Error(response.message || t('app.error'));
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }}>
    <h2 className="text-sm font-medium">{t('attribution.resultReview', 'Call quality and privacy review')}</h2>
    <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.resultReviewHelp', 'Review this call’s tool choice, arguments, metadata and original RAW. Privacy approval asserts that this material is suitable for training; it does not redact RAW, grant task consent, verify model identity or approve other calls.')}</p>
    <label className="block text-xs">{t('attribution.callQuality', 'Tool choice and argument quality')}
      <select className="hub-input mt-1 block" value={quality} disabled={saving} onChange={event => setQuality(event.target.value as typeof quality)}>
        {['unknown','correct','incorrect','uncertain'].map(value => <option key={value} value={value}>{t(`attribution.callQualityValues.${value}`, value)}</option>)}
      </select>
    </label>
    <label className="block text-xs">{t('attribution.privacyReview', 'Privacy review')}
      <select className="hub-input mt-1 block" value={privacy} disabled={saving} onChange={event => setPrivacy(event.target.value as typeof privacy)}>
        {['unreviewed','approved','rejected'].map(value => <option key={value} value={value}>{t(`attribution.privacyValues.${value}`, value)}</option>)}
      </select>
    </label>
    {review && <p className="text-xs text-[var(--hub-ink-3)]">{review.reviewedBy} · {new Date(review.reviewedAt).toLocaleString()} · #{review.revision}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    <button className="hub-btn" type="submit" disabled={saving}>{saving ? t('app.loading') : t('common.save')}</button>
  </form>;
}
