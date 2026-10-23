import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { submitLoopGuardFeedback } from '@/services/toolResultHistoryService';
type Verdict = 'helpful' | 'false_positive' | 'ignored';
export default function LoopGuardFeedbackButtons({ resultId, initialVerdict }: { resultId: string; initialVerdict?: Verdict }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(initialVerdict);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async (verdict: Verdict) => {
    setSaving(true); setError('');
    try {
      const response = await submitLoopGuardFeedback(resultId, verdict);
      if (!response.success) throw new Error(response.message || t('app.error'));
      setSelected(verdict);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">{(['helpful', 'false_positive', 'ignored'] as const).map((verdict) =>
      <button key={verdict} className="hub-btn text-xs" type="button" aria-pressed={selected === verdict} disabled={saving || selected === verdict} onClick={() => void save(verdict)}>{t(`attribution.loopFeedback.${verdict}`, verdict)}</button>)}</div>
    {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
  </div>;
}
