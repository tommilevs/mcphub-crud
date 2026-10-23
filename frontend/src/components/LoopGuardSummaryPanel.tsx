import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getLoopGuardSummary, type LoopGuardSummary } from '@/services/toolResultHistoryService';

export default function LoopGuardSummaryPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<LoopGuardSummary>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getLoopGuardSummary().then((response) => {
      if (!active) return;
      if (response.success && response.data) setData(response.data);
      else setError(response.message || t('app.error'));
    }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [t]);
  if (error) return <p role="alert" className="p-3 text-sm text-red-500">{error}</p>;
  if (!data) return <p className="p-3 text-sm">{t('app.loading')}</p>;
  return <section className="space-y-3 p-3">
    <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.loopSummaryHelp', 'Retained warnings from the last 30 days. Each warning uses its latest explicit review; repeated votes do not multiply counts. Unreviewed or ignored warnings are not accuracy assessments. These reports do not establish task outcomes or agent reactions.')}</p>
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        [t('attribution.loopWarnings', 'Warnings'), data.advice],
        [t('attribution.loopHelpful', 'Reported helpful'), data.helpful],
        [t('attribution.loopFalsePositive', 'Reported false positives'), data.falsePositive],
        [t('attribution.loopIgnored', 'Explicitly ignored'), data.ignored],
        [t('attribution.loopUnreviewed', 'Unreviewed'), data.unreviewed],
        [t('attribution.loopReportedRate', 'False-positive reports / assessed'), data.reportedFalsePositiveRate === null ? '—' : `${(100 * data.reportedFalsePositiveRate).toFixed(1)}% (${data.falsePositive}/${data.assessed})`],
      ].map(([label, value]) => <div key={label} className="rounded border border-[var(--hub-line)] p-3">
        <dt className="text-xs text-[var(--hub-ink-3)]">{label}</dt><dd className="mt-1 text-lg hub-mono">{value}</dd>
      </div>)}
    </dl>
    {data.agentReactions && <div className="space-y-2 border-t border-[var(--hub-line)] pt-3">
      <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.loopReactionHelp', 'Agent reactions are explicit self-reports, not verified behavior or outcomes. Counts represent reports; one warning may have several.')}</p>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
        [t('attribution.loopReactionWarnings', 'Warnings with reported reaction'), data.agentReactions.warnings],
        [t('attribution.loopReactionAccepted', 'Accepted reports'), data.agentReactions.accepted],
        [t('attribution.loopReactionDeclined', 'Declined reports'), data.agentReactions.declined],
        [t('attribution.loopReactionChanged', 'Strategy change reports'), data.agentReactions.changedStrategy],
        [t('attribution.loopReactionRetry', 'Intentional retry reports'), data.agentReactions.intentionalRetry],
      ].map(([label, value]) => <div key={label}><dt className="text-xs text-[var(--hub-ink-3)]">{label}</dt><dd className="hub-mono">{value}</dd></div>)}</dl>
    </div>}
  </section>;
}
