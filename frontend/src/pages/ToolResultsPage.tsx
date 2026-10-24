import React, { useCallback, useEffect, useState, useRef } from 'react';
import { ArrowLeft, Clock3, Copy, Download, Pin, PinOff, Search } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Pagination from '@/components/ui/Pagination';
import AttributionSummaryPanel from '@/components/AttributionSummaryPanel';
import LoopGuardSummaryPanel from '@/components/LoopGuardSummaryPanel';
import TaskReviewForm from '@/components/TaskReviewForm';
import ToolResultReviewForm from '@/components/ToolResultReviewForm';
import TrainingContextEditor from '@/components/TrainingContextEditor';
import DatasetBuilderPanel from '@/components/DatasetBuilderPanel';
import ExperienceMemoryPanel from '@/components/ExperienceMemoryPanel';
import ExperienceReference from '@/components/ExperienceReference';
import LoopGuardFeedbackButtons from '@/components/LoopGuardFeedbackButtons';
import type { PaginationInfo, ToolResultChunk, ToolResultChunkHit, ToolResultDetail, ToolResultFilter, ToolResultLineage, ToolResultSearchDiagnostics, ToolResultStats, ToolResultSummary } from '@/types';
import {
  getToolResult,
  getAttributionEvents,
  type AttributionEvent,
  getToolResultRaw,
  getToolResultRawRange,
  getToolResults,
  getToolResultStats,
  compareToolResults,
  getToolResultTimeline,
  getToolResultConversationTimeline,
  getToolResultLineage,
  searchToolResultChunks,
  getToolResultChunks,
  reindexToolResults,
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
  const [identityEvents, setIdentityEvents] = useState<AttributionEvent[] | null>(null);
  const [identityEventError, setIdentityEventError] = useState('');
  const [identityEventsLoading, setIdentityEventsLoading] = useState(false);
  const [identityEventsCursor, setIdentityEventsCursor] = useState<string>();
  const currentResultRef = useRef(resultId);
  currentResultRef.current = resultId;
  useEffect(() => { setIdentityEvents(null); setIdentityEventError(''); setIdentityEventsCursor(undefined); setIdentityEventsLoading(false); }, [resultId]);
  const loadIdentityEvents = async (append = false) => {
    if (!detail?.attribution?.traceId) return;
    const currentResult = detail.resultId;
    setIdentityEventsLoading(true);
    setIdentityEventError('');
    try {
      const response = await getAttributionEvents(detail.attribution.traceId, append ? identityEventsCursor : undefined);
      if (!response.success) throw new Error(response.message || 'Failed to load identity events');
      if (currentResult === currentResultRef.current) {
        setIdentityEvents((previous) => append ? [...(previous ?? []), ...(response.data ?? [])] : response.data ?? []);
        setIdentityEventsCursor(response.meta?.nextCursor);
      }
    } catch (error) {
      if (currentResult === currentResultRef.current) setIdentityEventError(error instanceof Error ? error.message : String(error));
    } finally { if (currentResult === currentResultRef.current) setIdentityEventsLoading(false); }
  };
  const [raw, setRaw] = useState('');
  const [error, setError] = useState('');
  const [rangeStart, setRangeStart] = useState('0');
  const [rangeEnd, setRangeEnd] = useState('1024');
  const [rangeOutput, setRangeOutput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [lineage, setLineage] = useState<ToolResultLineage | null>(null);
  const [chunkQuery, setChunkQuery] = useState('');
  const [chunkHits, setChunkHits] = useState<ToolResultChunkHit[]>([]);
  const [chunkLoading, setChunkLoading] = useState(false);
  const [chunkError, setChunkError] = useState('');
  const [chunks, setChunks] = useState<ToolResultChunk[]>([]);
  const [chunksError, setChunksError] = useState('');

  useEffect(() => {
    Promise.allSettled([getToolResult(resultId), getToolResultRaw(resultId), getToolResultLineage(resultId), getToolResultChunks(resultId)]).then(([metadata, payload, related, indexed]) => {
      if (metadata.status === 'fulfilled' && metadata.value.success && metadata.value.data) {
        setDetail(metadata.value.data);
      } else {
        setError(metadata.status === 'rejected' ? metadata.reason?.message : metadata.value.message || t('toolResults.fetchError'));
      }
      if (payload.status === 'fulfilled') setRaw(payload.value);
      else setError(payload.reason instanceof Error ? payload.reason.message : t('toolResults.noPayload'));
      if (related.status === 'fulfilled' && related.value.success && related.value.data) setLineage(related.value.data);
      if (indexed.status === 'fulfilled' && indexed.value.success && indexed.value.data) setChunks(indexed.value.data);
      else if (indexed.status === 'rejected') setChunksError(indexed.reason instanceof Error ? indexed.reason.message : t('toolResults.fetchError'));
      else if (indexed.status === 'fulfilled' && !indexed.value.success) setChunksError(indexed.value.message || t('toolResults.fetchError'));
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

  const searchChunks = async () => {
    const search = chunkQuery.trim();
    if (!search) return;
    setChunkLoading(true);
    setChunkError('');
    try {
      const response = await searchToolResultChunks(resultId, search);
      if (response.success && response.data) setChunkHits(response.data);
      else setChunkError(response.message || t('toolResults.fetchError'));
    } catch (cause) {
      setChunkError(cause instanceof Error ? cause.message : t('toolResults.fetchError'));
    } finally {
      setChunkLoading(false);
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
      {detail.attribution && <section className="hub-card p-3 space-y-3" aria-label={t('attribution.title', 'Model attribution')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{t('attribution.title', 'Model attribution')}</h2>
          <span className="text-xs text-[var(--hub-ink-3)]">{detail.attribution.identity.verified && detail.attribution.provenance?.causalCorrelationVerified
            ? t('attribution.verifiedCorrelation', 'Verified adapter correlation') : t('attribution.unverified', 'Unverified')}</span>
        </div>
        <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {[
            [t('attribution.model', 'Model'), detail.attribution.identity.modelId || t('attribution.unknown', 'Unknown')],
            [t('attribution.source', 'Source'), detail.attribution.identity.source === 'gateway_observed' ? 'gateway_observed' : detail.attribution.identity.source === 'self_reported' ? t('attribution.selfReported', 'Self-reported') : t('attribution.unknown', 'Unknown')],
            [t('attribution.gatewayAdapter', 'Gateway adapter'), detail.attribution.provenance?.adapterId],
            [t('attribution.providerResponse', 'Provider response'), detail.attribution.provenance?.responseId],
            [t('attribution.providerToolCall', 'Provider tool call'), detail.attribution.provenance?.toolCallId],
            [t('attribution.modelClaim', 'Model claim'), detail.attribution.provenance?.claimedModelId],
            [t('attribution.client', 'Client claim'), detail.attribution.clientClaims?.clientNameClaim],
            [t('attribution.instance', 'Client instance claim'), detail.attribution.clientClaims?.clientInstanceHint],
            [t('attribution.run', 'Agent run claim'), detail.attribution.clientClaims?.agentRunHint],
            [t('attribution.call', 'Call'), detail.attribution.callId],
            [t('attribution.task', 'Task'), detail.attribution.taskId],
            [t('attribution.trace', 'Trace'), detail.attribution.traceId],
            [t('attribution.branch', 'Branch'), detail.attribution.branchId],
            [t('attribution.segment', 'Model segment'), detail.attribution.modelSegmentId],
          ].filter(([, value]) => value).map(([label, value]) => <div key={label} className="min-w-0">
            <dt className="text-[var(--hub-ink-3)]">{label}</dt>
            <dd className="hub-mono mt-1 break-all">{value}</dd>
          </div>)}
        </dl>
        {detail.attribution.conflictReason && <p role="status" className="rounded border border-[var(--hub-line)] p-2 text-xs">
          {t('attribution.conflict', 'Conflicting identity data')}: {detail.attribution.conflictReason}
        </p>}
        <div className="flex flex-wrap gap-2">
          {detail.attribution.traceId && <button type="button" className="hub-btn text-xs" disabled={identityEventsLoading} onClick={() => void loadIdentityEvents()}>{identityEventsLoading ? t('app.loading') : t('attribution.events', 'Identity timeline')}</button>}
          {detail.attribution.traceId && <Link className="hub-btn text-xs" to={`/tool-results?traceId=${encodeURIComponent(detail.attribution.traceId)}`}>{t('attribution.trace', 'Trace')}</Link>}
          {detail.attribution.taskId && <Link className="hub-btn text-xs" to={`/tool-results?taskId=${encodeURIComponent(detail.attribution.taskId)}`}>{t('attribution.task', 'Task')}</Link>}
          {detail.attribution.branchId && <Link className="hub-btn text-xs" to={`/tool-results?branchId=${encodeURIComponent(detail.attribution.branchId)}`}>{t('attribution.branch', 'Branch')}</Link>}
        </div>
        {identityEventError && <p role="alert" className="text-xs text-red-500">{identityEventError}</p>}
        {identityEvents && <ol className="space-y-2 border-t border-[var(--hub-line)] pt-3">
          {identityEvents.map((event) => <li key={event.event_id} className="grid gap-1 text-xs sm:grid-cols-3">
            <time dateTime={event.occurred_at} className="text-[var(--hub-ink-3)]">{new Date(event.occurred_at).toLocaleString()}</time>
            <span>{t(`attribution.eventNames.${event.event_type}`, event.event_type)}</span>
            <span className="hub-mono break-all">{event.claimed_model_id || t('attribution.unknown', 'Unknown')} · {t('attribution.unverified', 'Unverified')}</span>
          </li>)}
          {identityEvents.length === 0 && <li className="text-xs text-[var(--hub-ink-3)]">{t('attribution.noEvents', 'No identity events')}</li>}
          {identityEventsCursor && <li><button type="button" className="hub-btn text-xs" disabled={identityEventsLoading} onClick={() => void loadIdentityEvents(true)}>{t('attribution.loadMore', 'Load more events')}</button></li>}
        </ol>}
      </section>}
      {detail.attribution?.taskId && <TaskReviewForm key={`${detail.resultId}:${detail.taskReview?.revision ?? 0}`}
        taskId={detail.attribution.taskId} review={detail.taskReview} onSaved={async () => {
          const response = await getToolResult(resultId);
          if (response.success && response.data) setDetail(response.data);
          else throw new Error(response.message || t('toolResults.fetchError'));
        }} />}
      {detail.payloadAvailable && detail.rawSha256 && <ToolResultReviewForm
        key={`${detail.resultId}:review:${detail.resultReview?.revision ?? 0}`} resultId={detail.resultId}
        digest={detail.rawSha256} review={detail.resultReview} onSaved={async () => {
          const response = await getToolResult(resultId);
          if (response.success && response.data) setDetail(response.data);
          else throw new Error(response.message || t('toolResults.fetchError'));
        }} />}
      <TrainingContextEditor key={`${detail.resultId}:context`} resultId={detail.resultId} onSaved={async()=>{
        const response=await getToolResult(resultId);
        if(response.success&&response.data)setDetail(response.data);
        else throw new Error(response.message||t('toolResults.fetchError'));
      }}/>
      {detail.loopGuardAdvice && <section className="hub-card p-3 space-y-2">
        <h2 className="text-sm font-medium">LoopGuard</h2>
        <p className="text-xs">{detail.loopGuardAdvice.trigger === 'alternating_failure_cycle'
          ? t('attribution.loopCycleAdviceCount', { count: detail.loopGuardAdvice.resultIds.length / 2, defaultValue: 'A two-step failure cycle repeated {{count}} times. Review both errors and consider changing the diagnostic strategy. Intentional retries remain allowed.' })
          : t('attribution.loopAdviceCount', { count: detail.loopGuardAdvice.resultIds.length, defaultValue: '{{count}} identical rapid failures were observed. Review the saved error and tool schema before retrying. Intentional retries remain allowed.' })}</p>
        <div className="flex flex-wrap gap-2">{detail.loopGuardAdvice.resultIds.map((id) => <Link key={id} className="hub-mono text-xs text-[var(--hub-accent)] break-all" to={`/tool-results/${encodeURIComponent(id)}`}>{id}</Link>)}</div>
        <LoopGuardFeedbackButtons key={detail.resultId} resultId={detail.resultId} initialVerdict={detail.loopGuardFeedback?.verdict} />
        {detail.loopGuardAdvice.experiences?.map(reference=><ExperienceReference key={`${detail.resultId}:${reference.experienceId}`}
          id={reference.experienceId} keyId={detail.keyId}/>)}
        {detail.loopGuardAdvice.toolPilot && <aside className="border-t border-[var(--hub-line)] pt-2 text-xs space-y-1">
          <h3 className="font-medium">{t('attribution.toolPilotAdvice', 'Internal ToolPilot suggestion')} · {detail.loopGuardAdvice.toolPilot.model}</h3>
          <p className="text-[var(--hub-ink-3)]">{t('attribution.toolPilotLimit', 'Based on metadata only; unverified advice from a separate internal model. No tool was executed.')}</p>
          <p className="whitespace-pre-wrap break-words">{detail.loopGuardAdvice.toolPilot.suggestion}</p>
        </aside>}
      </section>}
      {detail.trainingReadiness && <section className="hub-card p-3 space-y-2">
        <h2 className="text-sm font-medium">{t('attribution.trainingReadiness', 'Training readiness')}</h2>
        <p className="text-xs text-[var(--hub-ink-3)]">{t(`attribution.readiness.${detail.trainingReadiness.tier}`, detail.trainingReadiness.tier)}</p>
        <ul className="list-disc pl-4 text-xs space-y-1">{detail.trainingReadiness.reasons.map((reason) => <li key={reason}>{t(`attribution.trainingReasons.${reason}`, reason)}</li>)}</ul>
      </section>}
      {detail.objective && <div className="hub-card p-3"><div className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.objective')}</div><div className="mt-1 text-sm">{detail.objective}</div></div>}
      {lineage && (lineage.ancestors.length > 0 || lineage.children.length > 0) && <div className="hub-card p-3 space-y-3">
        <div className="text-sm font-medium">{t('toolResults.lineage')}</div>
        {lineage.ancestors.length > 0 && <div><div className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.ancestors')}</div><div className="mt-1 space-y-1">{lineage.ancestors.map((item) => <Link key={item.resultId} to={`/tool-results/${item.resultId}`} className="block rounded border border-[var(--hub-line)] p-2 text-xs hover:bg-[var(--hub-surface-hover)]"><span className="font-medium">{item.server} / {item.tool}</span><span className="ml-2 text-[var(--hub-ink-3)]">{new Date(item.timestamp).toLocaleString()}</span></Link>)}</div></div>}
        {lineage.children.length > 0 && <div><div className="text-xs text-[var(--hub-ink-3)]">{t('toolResults.children')}</div><div className="mt-1 space-y-1">{lineage.children.map((item) => <Link key={item.resultId} to={`/tool-results/${item.resultId}`} className="block rounded border border-[var(--hub-line)] p-2 text-xs hover:bg-[var(--hub-surface-hover)]"><span className="font-medium">{item.server} / {item.tool}</span><span className="ml-2 text-[var(--hub-ink-3)]">{new Date(item.timestamp).toLocaleString()}</span></Link>)}</div></div>}
      </div>}
      <div className="hub-card p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{t('toolResults.chunks')}</span>
          <span className="text-xs text-[var(--hub-ink-3)]">{chunks.length} · {chunks.filter((chunk) => chunk.hasEmbedding).length} {t('toolResults.embedded')}</span>
        </div>
        {chunksError && <div className="mt-2 text-sm text-red-500">{chunksError}</div>}
        {!chunksError && chunks.length === 0 && <div className="mt-2 text-sm text-[var(--hub-ink-3)]">{t('toolResults.noChunks')}</div>}
        {chunks.length > 0 && <div className="mt-3 space-y-2">{chunks.map((chunk) => <div key={`${chunk.chunkIndex}-${chunk.chunkVersion}`} className="rounded border border-[var(--hub-line)] p-2"><div className="flex items-center justify-between gap-2 text-xs text-[var(--hub-ink-3)]"><span>{t('toolResults.chunk')} #{chunk.chunkIndex} · v{chunk.chunkVersion} · {bytes(chunk.contentBytes)}</span><span>{chunk.hasEmbedding ? `${t('toolResults.embedded')} ${chunk.embeddingDimensions || ''}` : t('toolResults.noEmbedding')}</span></div><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs hub-mono">{chunk.content}</pre></div>)}</div>}
      </div>
      <div className="hub-card p-3">
        <div className="text-sm font-medium">{t('toolResults.searchInside')}</div>
        <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void searchChunks(); }}>
          <input className="hub-input min-w-64 flex-1" value={chunkQuery} onChange={(event) => setChunkQuery(event.target.value)} placeholder={t('toolResults.searchInsidePlaceholder')} />
          <button className="hub-btn hub-btn-primary" type="submit" disabled={chunkLoading || !detail.payloadAvailable}><Search size={15} /> {chunkLoading ? t('app.loading') : t('common.search')}</button>
        </form>
        {chunkError && <div className="mt-2 text-sm text-red-500">{chunkError}</div>}
        {!chunkLoading && chunkHits.length === 0 && chunkQuery && !chunkError && <div className="mt-2 text-sm text-[var(--hub-ink-3)]">{t('toolResults.noChunkMatches')}</div>}
        {chunkHits.length > 0 && <div className="mt-3 space-y-2">{chunkHits.map((hit) => <div key={`${hit.chunkIndex}-${hit.chunkVersion}`} className="rounded border border-[var(--hub-line)] p-2"><div className="flex items-center justify-between gap-2 text-xs text-[var(--hub-ink-3)]"><span>{t('toolResults.chunk')} #{hit.chunkIndex}</span><span>{hit.retrievalScore.toFixed(4)}</span></div><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs hub-mono">{hit.content}</pre></div>)}</div>}
      </div>
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
  const [showAttributionSummary, setShowAttributionSummary] = useState(false);
  const [showLoopGuardSummary, setShowLoopGuardSummary] = useState(false);
  const { resultId } = useParams<{ resultId?: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const initialSessionId = searchParams.get('sessionId') || undefined;
  const initialConversationId = searchParams.get('conversationId') || undefined;
  const [items, setItems] = useState<ToolResultSummary[]>([]);
  const [stats, setStats] = useState<ToolResultStats | null>(null);
  const [pagination, setPagination] = useState<PaginationInfo | null>(null);
  const [page, setPage] = useState(1);
  const historyRequestRef = useRef(0);
  const initialAttribution = Object.fromEntries(['modelId', 'taskId', 'traceId', 'branchId'].map((key) => [key, searchParams.get(key) || undefined]));
  const [draft, setDraft] = useState<ToolResultFilter>({ ...initialAttribution, sessionId: initialSessionId, conversationId: initialConversationId });
  const [filter, setFilter] = useState<ToolResultFilter>({ ...initialAttribution, sessionId: initialSessionId, conversationId: initialConversationId });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<{ sameRaw: boolean; results: ToolResultSummary[] } | null>(null);
  const [comparisonRaw, setComparisonRaw] = useState<Record<string, string>>({});
  const [comparisonRawLoading, setComparisonRawLoading] = useState(false);
  const [comparisonRawError, setComparisonRawError] = useState('');
  const timelineRequestRef = useRef(0);
  const [timeline, setTimeline] = useState<ToolResultSummary[] | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelinePagination, setTimelinePagination] = useState<PaginationInfo | null>(null);
  const [timelineError, setTimelineError] = useState('');
  const [timelineContext, setTimelineContext] = useState<{ kind: 'session' | 'conversation'; id: string } | null>(null);
  const [retrievalDiagnostics, setRetrievalDiagnostics] = useState<ToolResultSearchDiagnostics | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMessage, setReindexMessage] = useState('');

  const load = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    setLoading(true); setError('');
    try {
      const [list, totals] = await Promise.all([getToolResults(page, 20, filter), getToolResultStats(filter)]);
      if (requestId !== historyRequestRef.current) return;
      if (list.success && list.data) {
        setItems(list.data);
        setRetrievalDiagnostics(filter.query && list.meta ? list.meta : null);
        setPagination(list.pagination || (filter.query ? { page: 1, limit: 20, total: list.data.length, totalPages: 1, hasNextPage: false, hasPrevPage: false } : null));
      }
      else setError(list.message || t('toolResults.fetchError'));
      if (totals.success && totals.data) setStats(totals.data);
    } catch (cause) {
      if (requestId === historyRequestRef.current) setError(cause instanceof Error ? cause.message : t('toolResults.fetchError'));
    } finally {
      if (requestId === historyRequestRef.current) setLoading(false);
    }
  }, [page, filter, t]);

  const runCompare = async () => {
    const response = await compareToolResults(selected);
    if (response.success && response.data) {
      setComparison(response.data);
      setComparisonRaw({});
      setComparisonRawError('');
    }
  };

  const runReindex = async () => {
    setReindexing(true);
    setReindexMessage('');
    try {
      const response = await reindexToolResults(25, true);
      if (response.success && response.data) {
        setReindexMessage(`${response.data.indexed} indexed · ${response.data.remaining} remaining · ${response.data.skipped} skipped · ${response.data.embeddingFailures} embedding failures`);
      } else {
        setReindexMessage(response.message || t('toolResults.reindexError'));
      }
    } catch (cause) {
      setReindexMessage(cause instanceof Error ? cause.message : t('toolResults.reindexError'));
    } finally {
      setReindexing(false);
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

  const runTimeline = async (timelinePage = 1, existingContext: typeof timelineContext = null) => {
    const sessionId = filter.sessionId?.trim();
    const conversationId = filter.conversationId?.trim();
    const context = existingContext ?? (sessionId
      ? { kind: 'session' as const, id: sessionId }
      : conversationId
        ? { kind: 'conversation' as const, id: conversationId }
        : null);
    if (!context) return;
    const requestId = ++timelineRequestRef.current;
    setTimelineLoading(true);
    setTimelineError('');
    try {
      const response = context.kind === 'session'
        ? await getToolResultTimeline(context.id, 100, timelinePage)
        : await getToolResultConversationTimeline(context.id, 100, timelinePage);
      if (requestId !== timelineRequestRef.current) return;
      if (response.success && response.data) {
        setTimeline(response.data);
        setTimelinePagination(response.pagination || null);
        setTimelineContext(context);
      }
      else setTimelineError(response.message || t('toolResults.fetchError'));
    } catch (cause) {
      if (requestId !== timelineRequestRef.current) return;
      setTimelineError(cause instanceof Error ? cause.message : t('toolResults.fetchError'));
    } finally {
      if (requestId === timelineRequestRef.current) setTimelineLoading(false);
    }
  };

  useEffect(() => () => { timelineRequestRef.current += 1; historyRequestRef.current += 1; }, [resultId]);
  useEffect(() => { if (!resultId) void load(); }, [load, resultId]);
  if (resultId) return <ToolResultDetailView resultId={resultId} />;

  return <div className="p-5 space-y-4">
    <div><h1 className="text-lg font-semibold text-[var(--hub-ink)]">{t('toolResults.title')}</h1><p className="mt-1 text-sm text-[var(--hub-ink-3)]">{t('toolResults.subtitle')}</p></div>
    <section className="hub-card">
      <button type="button" className="hub-btn m-3" aria-expanded={showAttributionSummary} onClick={() => setShowAttributionSummary(!showAttributionSummary)}>{t('attribution.title', 'Model attribution')}</button>
      {showAttributionSummary && <AttributionSummaryPanel />}
      <button type="button" className="hub-btn m-3" aria-expanded={showLoopGuardSummary} onClick={() => setShowLoopGuardSummary(!showLoopGuardSummary)}>{t('attribution.loopSummary', 'LoopGuard feedback')}</button>
      {showLoopGuardSummary && <LoopGuardSummaryPanel />}
    </section>
    {stats && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[[t('toolResults.total'), stats.total], [t('toolResults.pinned'), stats.pinned], [t('toolResults.payloads'), stats.payloadAvailable], [t('toolResults.storage'), bytes(stats.totalRawBytes)]].map(([label, value]) => <div key={label} className="hub-card p-3"><div className="text-xs text-[var(--hub-ink-3)]">{label}</div><div className="hub-num mt-1 text-xl">{value}</div></div>)}
    </div>}
    {stats?.retrieval && <div className="hub-card px-3 py-2 text-xs text-[var(--hub-ink-3)]">{t('toolResults.retrievalMetrics')}: {stats.retrieval.searches} {t('toolResults.searches')} · {stats.retrieval.hybridSearches} {t('toolResults.hybrid')} · {stats.retrieval.indexFailures} {t('toolResults.indexFailures')}</div>}
    {retrievalDiagnostics && <div className="hub-card px-3 py-2 text-xs text-[var(--hub-ink-3)]">{t('toolResults.searchDiagnostics')}: {retrievalDiagnostics.mode} · {retrievalDiagnostics.resultCount} {t('toolResults.hits')} · {retrievalDiagnostics.lexicalMatches} {t('toolResults.lexical')} · {retrievalDiagnostics.vectorMatches} {t('toolResults.vector')} · {retrievalDiagnostics.fusedMatches} {t('toolResults.fused')}</div>}
    <div className="hub-card flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs text-[var(--hub-ink-3)]"><span>{reindexMessage || t('toolResults.reindexDescription')}</span><button className="hub-btn" type="button" onClick={() => void runReindex()} disabled={reindexing}>{reindexing ? t('app.loading') : t('toolResults.reindex')}</button></div>
    <form className="hub-card p-3 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setFilter({ ...draft, startDate: draft.startDate ? new Date(draft.startDate).toISOString() : undefined, endDate: draft.endDate ? new Date(draft.endDate).toISOString() : undefined }); }}>
      <input className="hub-input min-w-56 flex-1" placeholder={t('toolResults.query')} value={draft.query || ''} onChange={(e) => setDraft({ ...draft, query: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.server')} value={draft.server || ''} onChange={(e) => setDraft({ ...draft, server: e.target.value })} />
      <input className="hub-input min-w-44" placeholder={t('toolResults.tool')} value={draft.tool || ''} onChange={(e) => setDraft({ ...draft, tool: e.target.value })} />
      {(['modelId', 'taskId', 'traceId', 'branchId'] as const).map((field) => <input key={field}
        className="hub-input min-w-44" aria-label={t(`attribution.${field.slice(0, -2)}`, field)} placeholder={t(`attribution.${field.slice(0, -2)}`, field)}
        value={draft[field] || ''} onChange={(event) => setDraft({ ...draft, [field]: event.target.value })} />)}
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
      <div className="flex items-center justify-between gap-2"><div><div className="text-sm font-medium">{t('toolResults.timeline')}</div><div className="hub-mono text-xs text-[var(--hub-ink-3)] truncate">{timelineContext?.id}</div></div><button className="hub-btn" onClick={() => { timelineRequestRef.current += 1; setTimelineLoading(false); setTimelineError(''); setTimeline(null); setTimelineContext(null); setTimelinePagination(null); }}>{t('common.close')}</button></div>
      {timelineError && <div className="mt-2 text-sm text-red-500">{timelineError}</div>}
      {!timelineLoading && timeline.length === 0 && <div className="mt-3 text-sm text-[var(--hub-ink-3)]">{t('toolResults.timelineEmpty')}</div>}
      <div className="mt-3 space-y-2">{timeline.map((item) => <Link key={item.resultId} to={`/tool-results/${item.resultId}`} className="block rounded border border-[var(--hub-line)] p-2 hover:bg-[var(--hub-surface-hover)]"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium">{item.server} / {item.tool}</span><span className={item.status === 'error' ? 'text-red-500' : 'text-emerald-500'}>{item.status}</span></div><div className="mt-1 text-xs text-[var(--hub-ink-3)]">{new Date(item.timestamp).toLocaleString()} · {item.durationMs} ms · {bytes(item.rawBytes)}</div></Link>)}</div>
      {timelinePagination && <Pagination currentPage={timelinePagination.page} totalPages={Math.max(1, timelinePagination.totalPages)} onPageChange={nextPage => void runTimeline(nextPage, timelineContext)} disabled={timelineLoading} />}
    </div>}
    <ExperienceMemoryPanel resultIds={selected}/>
    {selected.length>0&&<DatasetBuilderPanel resultIds={selected}/>}
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
