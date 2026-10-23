import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAttributionSummary, type AttributionSummary } from '@/services/toolResultHistoryService';

export default function AttributionSummaryPanel() {
  const { t } = useTranslation();
  const [data, setData] = useState<AttributionSummary>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getAttributionSummary().then((response) => {
      if (!active) return;
      if (response.success && response.data) setData(response.data);
      else setError(response.message || t('app.error'));
    }).catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [t]);
  if (error) return <p role="alert" className="p-3 text-sm text-red-500">{error}</p>;
  if (!data) return <p className="p-3 text-sm">{t('app.loading')}</p>;
  const coverage = (value: number) => data.total ? `${(100 * value / data.total).toFixed(1)}%` : '0%';
  return <section className="space-y-3 p-3">
    <p className="text-xs text-[var(--hub-ink-3)]">{t('attribution.summaryHelp', 'Retained calls from the last 30 days. Execution errors do not establish tool-selection errors or task outcomes.')}</p>
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        [t('attribution.totalCalls', 'Retained calls'), data.total],
        [t('attribution.knownCoverage', 'Known model coverage'), coverage(data.known)],
        [t('attribution.verifiedCoverage', 'Verified coverage'), coverage(data.verified)],
        [t('attribution.conflicts', 'Conflicted calls'), data.conflicted],
      ].map(([label, value]) => <div key={label} className="rounded border border-[var(--hub-line)] p-3"><dt className="text-xs text-[var(--hub-ink-3)]">{label}</dt><dd className="mt-1 text-lg hub-mono">{value}</dd></div>)}
    </dl>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="sr-only">{t('attribution.modelSummary', 'Model observations, up to 50 groups')}</caption>
      <thead><tr>{[t('attribution.model', 'Model'), t('attribution.source', 'Source'), t('attribution.totalCalls', 'Retained calls'), t('attribution.executionErrors', 'Execution errors')].map((label) => <th scope="col" key={label} className="p-2 font-medium text-[var(--hub-ink-3)]">{label}</th>)}</tr></thead>
      <tbody>{data.models.map((row) => <tr key={`${row.model_id}:${row.source}`} className="border-t border-[var(--hub-line)]">
        <td className="p-2 break-all">{row.model_id || t('attribution.unknown', 'Unknown')}</td>
        <td className="p-2">{row.source === 'self_reported' ? t('attribution.selfReported', 'Self-reported') : row.source}</td>
        <td className="p-2 hub-mono">{row.calls}</td><td className="p-2 hub-mono">{row.execution_errors}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
