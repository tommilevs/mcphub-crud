import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Clock3, Copy, Download, Pin, PinOff, Search } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Pagination from '@/components/ui/Pagination';
import type { PaginationInfo, ToolResultDetail, ToolResultFilter, ToolResultStats, ToolResultSummary } from '@/types';
import {
  getToolResult,
  getToolResultRaw,
  getToolResultRawRange,
  getToolResults,
  getToolResultStats,
  compareToolResults,
  getToolResultTimeline,
  getToolResultConversationTimeline,
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
  const [rangeStart, setRangeStart] = useState('0');
  const [rangeEnd, setRangeEnd] = useState('1024');
  const [rangeOutput, setRangeOutput] = useState('');
  const [rangeError, setRangeError] = useState('');

  useEffect(() => {
    Promise.allSettled([getToolResult(resultId), getToolResultRaw(resultId)]).then(([metadata, payload]) => {
      if (metadata.status === 'fulfilled' && metadata.value.success && metadata.value.data) {
        setDetail(metadata.value.data);
      } else {
        setError(metadata.status === 'rejected' ? metadata.reason?.message : metadata.value.message || t('toolResults.fetchError'));
      }
      if (payload.status === 'fulfilled') setRaw(payload.value);
      else setError(payload.reason instanceof Error ? payload.reason.message : t('toolResults.noPayload'));
    });
  }, [resultId, t]);

  const togglePin = async () => {
    if (!detail) return;
    const response = await setToolResultPinned(resultId, !detail.pinned);
    if (response.success && response.data) setDetail(response.data);
  };

  const loadRange = async () => {
    const start = Number(rangeStart);
    const end = Number(rangeEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      setRangeError(t('toolResults.rangeError'));
      return;
    }
    try {
      setRangeError('');
      setRangeOutput(await getToolResultRawRange(resultId, start, end));
    } catch (cause) {
      setRangeOutput('');
      setRangeError(cause instanceof Error ? cause.message : t('toolResults.rangeError'));
    }
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
      {(detail.sessionId || detail.conversationId || detail.parentResultId || detail.rawSha256) && <div className="hub-card grid gap-2 p-3 text-xs md:grid-cols-2">
        {detail.sessionId && <div><div className="text-[var(--hub-ink-3)]">{t('toolResults.session')}</div><Link to={`/tool-results?sessionId=${encodeURIComponent(detail.sessionId)}`} className="hub-mono mt-1 block break-all text-[var(--hub-accent)]">{detail.sessionId}</Link></div>}
        {detail.conversationId && <div><div className="text-[var(--hub-ink-3)]">{t('toolResults.conversation')}</div><Link to={`/tool-results?conversationId=${encodeURIComponent(detail.conversationId)}`} className="hub-mono mt-1 block break-all text-[var(--hub-accent)]">{detail.conversationId}</Link></div>}
        {detail.parentResultId && <div><div className="text-[var(--hub-ink-3)]">{t('toolResults.parent')}</div><Link className="hub-mono mt-1 block break-all text-[var(--hub-accent)]" to={`/tool-results/${detail.parentResultId}`}>{detail.parentResultId}</Link></div>}
        {detail.rawSha256 && <div><div className="text-[var(--hub-ink-3)]">{t('toolResults.rawHash')}</div><div className="hub-mono mt-1 break-all">{detail.rawSha256}</div></div>}
      </div>}
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
      <div className="hub-card p-3">
        <div className="text-sm font-medium">{t('toolResults.range')}</div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.rangeStart')}<input className="hub-input mt-1 w-28" type="number" min="0" value={rangeStart} onChange={(event) => setRangeStart(event.target.value)} /></label>
          <label className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.rangeEnd')}<input className="hub-input mt-1 w-28" type="number" min="1" value={rangeEnd} onChange={(event) => setRangeEnd(event.target.value)} /></label>
          <button className="hub-btn" onClick={() => void loadRange()} disabled={!detail.payloadAvailable}>{t('toolResults.loadRange')}</button>
        </div>
        {rangeError && <div className="mt-2 text-sm text-red-500">{rangeError}</div>}
        {rangeOutput && <pre className="mt-3 max-h-48 overflow-auto rounded border border-[var(--hub-line)] p-3 text-xs hub-mono whitespace-pre-wrap break-words">{rangeOutput}</pre>}
      </div>
    </div>
  );
};

const ToolResultsPage: React.FC = () => {
  const { resultId } = useParams<{ resultId?: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const initialSessionId = searchParams.get('sessionId') || undefined;
  const initialConversationId = searchParams.get('conversationId') || undefined;
  const [items, setItems] = useState<ToolResultSummary[]>([]);
  const [stats, setStats] = useState<ToolResultStats | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<ToolResultFilter>({ sessionId: initialSessionId, conversationId: initialConversationId });
  const [filter, setFilter] = useState<ToolResultFilter>({ sessionId: initialSessionId, conversationId: initialConversationId });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ sameRaw: boolean; results: ToolResultSummary[] } | null>(null);
  const [comparisonRaw, setComparisonRaw] = useState<Record<string, string>>({});
  const [comparisonRawLoading, setComparisonRawLoading] = useState(false);
  const [comparisonRawError, setComparisonRawError] = useState('');
  const [timeline, setTimeline] = useState<ToolResultSummary[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');
  const [timelineContext, setTimelineContext] = useState<{ kind: 'session' | 'conversation'; id: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const [list, totals] = await Promise.all([getToolResults(page, 20, filter), getToolResultStats(filter)]);
    if (list.success && list.data) { setItems(list.data); setPagination(list.pagination || (filter.query ? { page: 1, limit: 20, total: list.data.length, totalPages: 1, hasNextPage: false, hasPrevPage: false } : null)); }
    else setError(list.message || t('toolResults.fetchError'));
    if (totals.success && totals.data) setStats(totals.data);
    setLoading(false);
  }, [page, filter, t]);

  const runCompare = async () => {
    const response = await compareToolResults(selected);
    if (response.success && response.data) {
      setComparison(response.data);
      setComparisonRaw({});
      setComparisonRawError('');
    }
  };

  const loadComparisonRaw = async () => {
    if (!comparison) return;
    setComparisonRawLoading(true);
    setComparisonRawError('');
    const results = await Promise.allSettled(comparison.results.map((item) => getToolResultRaw(item.resultId)));
    const loaded: Record<string, string> = {};
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') loaded[comparison.results[index].resultId] = result.value;
    });
    if (Object.keys(loaded).length !== comparison.results.length) setComparisonRawError(t('toolResults.compareRawError'));
    setComparisonRaw(loaded);
    setComparisonRawLoading(false);
  };

  const runTimeline = async () => {
    const sessionId = filter.sessionId?.trim();
    const conversationId = filter.conversationId?.trim();
    const context = sessionId
      ? { kind: 'session' as const, id: sessionId }
      : conversationId
        ? { kind: 'conversation' as const, id: conversationId }
        : null;
    if (!context) return;
    setTimelineLoading(true);
    setTimelineError('');
    try {
      const response = context.kind === 'session'
        ? await getToolResultTimeline(context.id)
        : await getToolResultConversationTimeline(context.id);
      if (response.success && response.data) setTimeline(response.data);
      else setTimelineError(response.message || t('toolResults.fetchError'));
      setTimelineContext(context);
    } catch (cause) {
      setTimelineError(cause instanceof Error ? cause.message : t('toolResults.fetchError'));
    } finally {
      setTimelineLoading(false);
    }
  };

  useEffect(() => { if (!resultId) void load(); }, [load, resultId]);
  if (resultId) return <ToolResultDetailView resultId={resultId} />;

  return <div className="p-5 space-y-4">
    <div><h1 className="text-lg font-semibold text-[var(--hub-ink)]">{t('toolResults.title')}</h1><p className="mt-1 text-sm text-[var(--hub-ink-3)]">{t('toolResults.subtitle')}</p></div>
    {stats && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[[t('toolResults.total'), stats.total], [t('toolResults.pinned'), stats.pinned], [t('toolResults.payloads'), stats.payloadAvailable], [t('toolResults.storage'), bytes(stats.totalRawBytes)]].map(([label, value]) => <div key={label} className="hub-card p-3"><div className="text-xs text-[var(--hub-ink-3)]">{label}</div><div className="hub-num mt-1 text-xl">{value}</div></div>)}
    </div>}
    {stats?.retrieval && <div className="hub-card px-3 py-2 text-xs text-[var(--hub-ink-3)]">{t('toolResults.retrievalMetrics')}: {stats.retrieval.searches} {t('toolResults.searches')} · {stats.retrieval.hybridSearches} {t('toolResults.hybrid')} · {stats.retrieval.indexFailures} {t('toolResults.indexFailures')}</div>}
    <form className="hub-card p-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setFilter({ ...draft, startDate: draft.startDate ? new Date(draft.startDate).toISOString() : undefined, endDate: draft.endDate ? new Date(draft.endDate).toISOString() : undefined }); }}>
      <input className="hub-input min-w-56 flex-1" placeholder={t('toolResults.query')} value={draft.query || ''} onChange={(e) => setDraft({ ...draft, query: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.server')} value={draft.server || ''} onChange={(e) => setDraft({ ...draft, server: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.tool')} value={draft.tool || ''} onChange={(e) => setDraft({ ...draft, tool: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.session')} value={draft.sessionId || ''} onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.conversation')} value={draft.conversationId || ''} onChange={(e) => setDraft({ ...draft, conversationId: e.target.value })} />
      <label className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.from')}<input className="hub-input mt-1" type="datetime-local" value={draft.startDate || ''} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} /></label>
      <label className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.to')}<input className="hub-input mt-1" type="datetime-local" value={draft.endDate || ''} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} /></label>
      <select className="hub-input" value={draft.status || ''} onChange={(e) => setDraft({ ...draft, status: (e.target.value || undefined) as ToolResultFilter['status'] })}><option value="">{t('toolResults.allStatuses')}</option><option value="success">success</option><option value="error">error</option></select>
      <label className="flex items-center gap-2 px-2 text-sm"><input type="checkbox" checked={draft.pinned === true} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked ? true : undefined })} />{t('toolResults.pinnedOnly')}</label>
      <button className="hub-btn hub-btn-primary active:scale-[0.98]" type="submit"><Search size={15} /> {t('common.search')}</button>
      {(filter.sessionId || filter.conversationId) && <button className="hub-btn active:scale-[0.98]" type="button" onClick={() => void runTimeline()}><Clock3 size={15} /> {t('toolResults.timeline')}</button>}
    </form>
    {error && <div className="hub-card p-4 text-sm text-red-500">{error}</div>}
    {timelineError && !timeline && <div className="hub-card p-4 text-sm text-red-500">{timelineError}</div>}
    {timeline && <div className="hub-card p-3">
      <div className="flex items-center justify-between gap-2"><div><div className="text-sm font-medium">{t('toolResults.timeline')}</div><div className="hub-mono text-xs text-[var(--hub-ink-3)] truncate">{timelineContext?.id}</div></div><button className="hub-btn" onClick={() => { setTimeline(null); setTimelineContext(null); }}>{t('common.close')}</button></div>
      {timelineError && <div className="mt-2 text-sm text-red-500">{timelineError}</div>}
      {!timelineLoading && timeline.length === 0 && <div className="mt-3 text-sm text-[var(--hub-ink-3)]">{t('toolResults.timelineEmpty')}</div>}
      <div className="mt-3 space-y-2">{timeline.map((item) => <Link key={item.resultId} to={`/tool-results/${item.resultId}`} className="block rounded border border-[var(--hub-line)] p-2 hover:bg-[var(--hub-surface-hover)]"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium">{item.server} / {item.tool}</span><span className={item.status === 'error' ? 'text-red-500' : 'text-emerald-500'}>{item.status}</span></div><div className="mt-1 text-xs text-[var(--hub-ink-3)]">{new Date(item.timestamp).toLocaleString()} · {item.durationMs} ms · {bytes(item.rawBytes)}</div></Link>)}</div>
    </div>}
    {selected.length >= 2 && <button className="hub-btn hub-btn-primary" onClick={() => void runCompare()}>{t('toolResults.compare')} ({selected.length})</button>}
    {comparison && <div className="hub-card p-3"><div className="flex items-center justify-between"><span className="text-sm font-medium">{t('toolResults.compare')}</span><div className="flex gap-2"><button className="hub-btn" onClick={() => void loadComparisonRaw()} disabled={comparisonRawLoading}>{comparisonRawLoading ? t('app.loading') : t('toolResults.loadRaw')}</button><button className="hub-btn" onClick={() => { setComparison(null); setComparisonRaw({}); }}>{t('common.close')}</button></div></div><div className="mt-2 grid gap-2 md:grid-cols-2">{comparison.results.map((item) => <div key={item.resultId} className="rounded border border-[var(--hub-line)] p-2 text-xs"><div className="font-medium">{item.server} / {item.tool}</div><div className="hub-mono text-[var(--hub-ink-3)]">{item.resultId}</div><div>{new Date(item.timestamp).toLocaleString()} · {bytes(item.rawBytes)}</div>{comparisonRaw[item.resultId] !== undefined && <pre className="mt-2 max-h-48 overflow-auto rounded bg-[var(--hub-surface)] p-2 hub-mono whitespace-pre-wrap break-words">{comparisonRaw[item.resultId]}</pre>}</div>)}</div><div className="mt-2 text-xs text-[var(--hub-ink-3)]">{comparison.sameRaw ? t('toolResults.sameRaw') : t('toolResults.differentRaw')}</div>{comparisonRawError && <div className="mt-2 text-sm text-red-500">{comparisonRawError}</div>}</div>}
    <div className="hub-card overflow-x-auto">
      <table className="w-full text-sm"><thead className="border-b border-[var(--hub-line)] text-left text-xs text-[var(--hub-ink-3)]"><tr><th className="px-3 py-2" /><>{['timestamp','server','tool','status','duration','size'].map((key) => <th key={key} className="px-3 py-2 font-medium">{t(`toolResults.${key}`)}</th>)}</></tr></thead>
      <tbody>{items.map((item) => <tr key={item.resultId} className="border-b border-[var(--hub-line)] last:border-0 hover:bg-[var(--hub-surface-hover)]"><td className="px-3 py-2"><input type="checkbox" checked={selected.includes(item.resultId)} onChange={(e) => setSelected(e.target.checked ? [...selected, item.resultId] : selected.filter((id) => id !== item.resultId))} /></td><td className="px-3 py-2 whitespace-nowrap"><Link className="text-[var(--hub-accent)]" to={`/tool-results/${item.resultId}`}>{new Date(item.timestamp).toLocaleString()}</Link></td><td className="px-3 py-2">{item.server}</td><td className="px-3 py-2">{item.tool}</td><td className="px-3 py-2"><span className={item.status === 'error' ? 'text-red-500' : 'text-emerald-500'}>{item.status}</span>{item.pinned && <Pin size={12} className="inline ml-1" />}</td><td className="px-3 py-2 hub-num">{item.durationMs} ms</td><td className="px-3 py-2 hub-num">{bytes(item.rawBytes)}</td></tr>)}</tbody></table>
      {!loading && items.length === 0 && <div className="p-8 text-center text-sm text-[var(--hub-ink-3)]">{t('toolResults.empty')}</div>}
      {loading && <div className="p-8 text-center text-sm text-[var(--hub-ink-3)]">{t('app.loading')}</div>}
    </div>
    {pagination && <Pagination currentPage={page} totalPages={Math.max(1, pagination.totalPages)} onPageChange={setPage} disabled={loading} />}
  </div>;
};

export default ToolResultsPage;
