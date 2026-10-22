import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Copy, Download, Pin, PinOff, Search } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Pagination from '@/components/ui/Pagination';
import type { PaginationInfo, ToolResultDetail, ToolResultFilter, ToolResultStats, ToolResultSummary } from '@/types';
import {
  getToolResult,
  getToolResultRaw,
  getToolResults,
  getToolResultStats,
  setToolResultPinned,
} from '@/services/toolResultHistoryService';

const bytes = (value: number) => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const ToolResultDetailView: React.FC<{ resultId: string }> = ({ resultId }) => {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<ToolResultDetail | null>(null);
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([getToolResult(resultId), getToolResultRaw(resultId).catch((e) => Promise.reject(e))])
      .then(([response, payload]) => {
        if (!response.success || !response.data) throw new Error(response.message);
        setDetail(response.data);
        setRaw(payload);
      })
      .catch((e) => {
        getToolResult(resultId).then((response) => response.data && setDetail(response.data));
        setError(e instanceof Error ? e.message : t('toolResults.fetchError'));
      });
  }, [resultId, t]);

  const togglePin = async () => {
    if (!detail) return;
    const response = await setToolResultPinned(resultId, !detail.pinned);
    if (response.success && response.data) setDetail(response.data);
  };

  if (!detail) return <div className="p-6 text-sm text-[var(--hub-ink-3)]">{error || t('app.loading')}</div>;
  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/tool-results" className="hub-icon-btn" aria-label={t('common.back')}><ArrowLeft size={16} /></Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-[var(--hub-ink)]">{detail.server} / {detail.tool}</h1>
          <div className="hub-mono text-xs text-[var(--hub-ink-3)] truncate">{detail.resultId}</div>
        </div>
        <button className="hub-btn active:scale-[0.98]" onClick={togglePin}>
          {detail.pinned ? <PinOff size={15} /> : <Pin size={15} />} {detail.pinned ? t('toolResults.unpin') : t('toolResults.pin')}
        </button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          [t('toolResults.status'), detail.status],
          [t('toolResults.timestamp'), new Date(detail.timestamp).toLocaleString()],
          [t('toolResults.duration'), `${detail.durationMs} ms`],
          [t('toolResults.size'), bytes(detail.rawBytes)],
        ].map(([label, value]) => <div key={label} className="hub-card p-3"><div className="text-xs text-[var(--hub-ink-3)]">{label}</div><div className="mt-1 text-sm text-[var(--hub-ink)]">{value}</div></div>)}
      </div>
      {detail.objective && <div className="hub-card p-3"><div className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.objective')}</div><div className="mt-1 text-sm">{detail.objective}</div></div>}
      <div className="hub-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--hub-line)] px-3 py-2">
          <span className="text-sm font-medium">RAW</span>
          {raw && <div className="flex gap-1">
            <button className="hub-icon-btn active:scale-95" onClick={() => navigator.clipboard.writeText(raw)} aria-label={t('common.copy')}><Copy size={15} /></button>
            <button className="hub-icon-btn active:scale-95" onClick={() => {
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
              a.download = `${resultId}.json`; a.click(); URL.revokeObjectURL(a.href);
            }} aria-label={t('toolResults.download')}><Download size={15} /></button>
          </div>}
        </div>
        {raw ? <pre className="max-h-[60vh] overflow-auto p-4 text-xs hub-mono whitespace-pre-wrap break-words">{raw}</pre> : <div className="p-5 text-sm text-[var(--hub-ink-3)]">{detail.payloadOmissionReason || error || t('toolResults.noPayload')}</div>}
      </div>
    </div>
  );
};

const ToolResultsPage: React.FC = () => {
  const { resultId } = useParams<{ resultId?: string }>();
  const { t } = useTranslation();
  const [items, setItems] = useState<ToolResultSummary[]>([]);
  const [stats, setStats] = useState<ToolResultStats | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<ToolResultFilter>({});
  const [filter, setFilter] = useState<ToolResultFilter>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [list, totals] = await Promise.all([getToolResults(page, 20, filter), getToolResultStats(filter)]);
    if (list.success && list.data) { setItems(list.data); setPagination(list.pagination || null); }
    else setError(list.message || t('toolResults.fetchError'));
    if (totals.success && totals.data) setStats(totals.data);
    setLoading(false);
  }, [page, filter, t]);

  useEffect(() => { if (!resultId) void load(); }, [load, resultId]);
  if (resultId) return <ToolResultDetailView resultId={resultId} />;

  return <div className="p-5 space-y-4">
    <div><h1 className="text-lg font-semibold text-[var(--hub-ink)]">{t('toolResults.title')}</h1><p className="mt-1 text-sm text-[var(--hub-ink-3)]">{t('toolResults.subtitle')}</p></div>
    {stats && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[[t('toolResults.total'), stats.total], [t('toolResults.pinned'), stats.pinned], [t('toolResults.payloads'), stats.payloadAvailable], [t('toolResults.storage'), bytes(stats.totalRawBytes)]].map(([label, value]) => <div key={label} className="hub-card p-3"><div className="text-xs text-[var(--hub-ink-3)]">{label}</div><div className="hub-num mt-1 text-xl">{value}</div></div>)}
    </div>}
    <form className="hub-card p-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setFilter(draft); }}>
      <input className="hub-input min-w-44" placeholder={t('toolResults.server')} value={draft.server || ''} onChange={(e) => setDraft({ ...draft, server: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.tool')} value={draft.tool || ''} onChange={(e) => setDraft({ ...draft, tool: e.target.value })} />
      <select className="hub-input" value={draft.status || ''} onChange={(e) => setDraft({ ...draft, status: (e.target.value || undefined) as ToolResultFilter['status'] })}><option value="">{t('toolResults.allStatuses')}</option><option value="success">success</option><option value="error">error</option></select>
      <label className="flex items-center gap-2 px-2 text-sm"><input type="checkbox" checked={draft.pinned === true} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked ? true : undefined })} />{t('toolResults.pinnedOnly')}</label>
      <button className="hub-btn hub-btn-primary active:scale-[0.98]" type="submit"><Search size={15} /> {t('common.search')}</button>
    </form>
    {error && <div className="hub-card p-4 text-sm text-red-500">{error}</div>}
    <div className="hub-card overflow-x-auto">
      <table className="w-full text-sm"><thead className="border-b border-[var(--hub-line)] text-left text-xs text-[var(--hub-ink-3)]"><tr>{['timestamp','server','tool','status','duration','size'].map((key) => <th key={key} className="px-3 py-2 font-medium">{t(`toolResults.${key}`)}</th>)}</tr></thead>
      <tbody>{items.map((item) => <tr key={item.resultId} className="border-b border-[var(--hub-line)] last:border-0 hover:bg-[var(--hub-surface-hover)]"><td className="px-3 py-2 whitespace-nowrap"><Link className="text-[var(--hub-accent)]" to={`/tool-results/${item.resultId}`}>{new Date(item.timestamp).toLocaleString()}</Link></td><td className="px-3 py-2">{item.server}</td><td className="px-3 py-2">{item.tool}</td><td className="px-3 py-2"><span className={item.status === 'error' ? 'text-red-500' : 'text-emerald-500'}>{item.status}</span>{item.pinned && <Pin size={12} className="inline ml-1" />}</td><td className="px-3 py-2 hub-num">{item.durationMs} ms</td><td className="px-3 py-2 hub-num">{bytes(item.rawBytes)}</td></tr>)}</tbody></table>
      {!loading && items.length === 0 && <div className="p-8 text-center text-sm text-[var(--hub-ink-3)]">{t('toolResults.empty')}</div>}
      {loading && <div className="p-8 text-center text-sm text-[var(--hub-ink-3)]">{t('app.loading')}</div>}
    </div>
    {pagination && <Pagination currentPage={page} totalPages={Math.max(1, pagination.totalPages)} onPageChange={setPage} disabled={loading} />}
  </div>;
};

export default ToolResultsPage;
