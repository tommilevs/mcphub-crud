import type {
  ToolResultFilter,
  ToolResultRecord,
  ToolResultStats,
  ToolResultSearchHit,
  ToolResultChunkHit,
  ToolResultChunk,
} from '../../types/toolResult.js';
import type {
  ToolResultPage,
  ToolResultRepository,
} from '../../services/toolResultHistoryService.js';

type Queryable = {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
};

type ToolResultRow = Record<string, unknown>;

const mapRow = (row: ToolResultRow): ToolResultRecord => ({
  trainingContext: row.training_context as ToolResultRecord['trainingContext'] ?? undefined,
  resultReview: row.result_review as ToolResultRecord['resultReview'] ?? undefined,
  loopGuardFeedback: row.loop_guard_feedback as ToolResultRecord['loopGuardFeedback'] ?? undefined,
  loopGuardAdvice: row.loop_guard_advice as ToolResultRecord['loopGuardAdvice'] ?? undefined,
  taskReview: row.task_review as ToolResultRecord['taskReview'] ?? undefined,
  attribution: row.attribution as ToolResultRecord['attribution'] ?? undefined,
  resultId: String(row.result_id),
  timestamp: new Date(String(row.timestamp)),
  server: String(row.server),
  tool: String(row.tool),
  durationMs: Number(row.duration_ms),
  status: row.status === 'error' ? 'error' : 'success',
  group: row.group_name ? String(row.group_name) : undefined,
  username: row.username ? String(row.username) : undefined,
  keyId: row.key_id ? String(row.key_id) : undefined,
  sessionId: row.session_id ? String(row.session_id) : undefined,
  conversationId: row.conversation_id ? String(row.conversation_id) : undefined,
  parentResultId: row.parent_result_id ? String(row.parent_result_id) : undefined,
  objective: row.objective ? String(row.objective) : undefined,
  arguments: row.arguments === null || row.arguments === undefined ? null : String(row.arguments),
  raw: row.raw === null || row.raw === undefined ? null : String(row.raw),
  rawText: row.raw_text === null || row.raw_text === undefined ? null : String(row.raw_text),
  rawBytes: Number(row.raw_bytes),
  rawSha256: row.raw_sha256 ? String(row.raw_sha256) : null,
  payloadAvailable: Boolean(row.payload_available),
  payloadOmissionReason: row.payload_omission_reason
    ? String(row.payload_omission_reason)
    : undefined,
  pinned: Boolean(row.pinned),
  useCount: Number(row.use_count ?? 0),
  lastReferencedAt: row.last_referenced_at
    ? new Date(String(row.last_referenced_at))
    : undefined,
});

const SELECT_COLUMNS = `
  result.*, state.pinned, state.use_count, state.last_referenced_at, state.loop_guard_advice, state.loop_guard_feedback, review.task_review, call_review.result_review, training.training_context
  FROM tool_results result
  JOIN tool_result_state state ON state.result_id = result.result_id
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('revision', revision, 'outcome', outcome,
      'trainingConsent', training_consent, 'reviewedBy', reviewed_by, 'reviewedAt', reviewed_at) AS task_review
    FROM attribution_task_reviews WHERE task_id::text = result.attribution->>'taskId'
    ORDER BY revision DESC LIMIT 1
  ) review ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('revision',revision,'rawSha256',raw_sha256,'quality',quality,
      'privacy',privacy,'reviewedBy',reviewed_by,'reviewedAt',reviewed_at) AS result_review
    FROM tool_result_reviews WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1
  ) call_review ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('revision',revision,'discoveryCallId',discovery_call_id,
      'privacyApproved',privacy_approved,'reviewedBy',reviewed_by,'reviewedAt',reviewed_at) AS training_context
    FROM tool_result_training_contexts WHERE result_id=result.result_id ORDER BY revision DESC LIMIT 1
  ) training ON TRUE
`;

export class ToolResultRepositoryDb implements ToolResultRepository {
  constructor(private readonly dataSource: Queryable) {}

  async create(record: ToolResultRecord): Promise<ToolResultRecord> {
    await this.dataSource.query(
        `WITH inserted AS (
          INSERT INTO tool_results (
          result_id, timestamp, server, tool, duration_ms, status, group_name, username,
          key_id, session_id, conversation_id, parent_result_id, objective, arguments,
          raw, raw_text, raw_bytes, raw_sha256, payload_available, payload_omission_reason, attribution
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21
          )
          RETURNING result_id
        )
        INSERT INTO tool_result_state (result_id, pinned, use_count)
        SELECT result_id, FALSE, 0 FROM inserted`,
        [
          record.resultId,
          record.timestamp,
          record.server,
          record.tool,
          record.durationMs,
          record.status,
          record.group ?? null,
          record.username ?? null,
          record.keyId ?? null,
          record.sessionId ?? null,
          record.conversationId ?? null,
          record.parentResultId ?? null,
          record.objective ?? null,
          record.arguments,
          record.raw,
          record.rawText,
          record.rawBytes,
          record.rawSha256,
          record.payloadAvailable,
          record.payloadOmissionReason ?? null,
          record.attribution ? JSON.stringify(record.attribution) : null,
        ],
    );
    return record;
  }

  async enforceRetention(limit: number, username?: string): Promise<number> {
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `WITH expired AS (
        SELECT result.result_id
        FROM tool_results result
        JOIN tool_result_state state ON state.result_id = result.result_id
        WHERE state.pinned = FALSE
          AND ($2::varchar IS NULL OR result.username = $2)
        ORDER BY result.timestamp DESC, result.result_id DESC
        OFFSET $1
      )
      DELETE FROM tool_results result
      USING expired
      WHERE result.result_id = expired.result_id
      RETURNING result.result_id`,
      [limit, username ?? null],
    );
    return rows.length;
  }

  async findById(resultId: string): Promise<ToolResultRecord | null> {
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `SELECT ${SELECT_COLUMNS} WHERE result.result_id = $1`,
      [resultId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async findPaginated(
    page: number,
    limit: number,
    filter: ToolResultFilter = {},
  ): Promise<ToolResultPage> {
    const { clause, params } = this.buildFilter(filter);
    const offset = (page - 1) * limit;
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `SELECT ${SELECT_COLUMNS} ${clause}
       ORDER BY result.timestamp DESC, result.result_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const counts = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM tool_results result
       JOIN tool_result_state state ON state.result_id = result.result_id ${clause}`,
      params,
    );
    const total = Number(counts[0]?.count ?? 0);
    return { data: rows.map(mapRow), total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findForReindex(limit: number, onlyMissing: boolean, afterResultId?: string): Promise<ToolResultRecord[]> {
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `SELECT ${SELECT_COLUMNS}
       WHERE result.payload_available = TRUE
         AND result.raw_text IS NOT NULL
         AND ($2::boolean = FALSE OR NOT EXISTS (
           SELECT 1 FROM tool_result_chunks chunks WHERE chunks.result_id = result.result_id
         ))
       ${afterResultId ? 'AND result.result_id > $3::uuid' : ''}
       ORDER BY result.result_id ASC
       LIMIT $1`,
      [limit, onlyMissing, ...(afterResultId ? [afterResultId] : [])],
    );
    return rows.map(mapRow);
  }

  async countForReindex(onlyMissing: boolean, afterResultId?: string): Promise<number> {
    const rows = await this.dataSource.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count
       FROM tool_results result
       WHERE result.payload_available = TRUE
         AND result.raw_text IS NOT NULL
         AND ($1::boolean = FALSE OR NOT EXISTS (
           SELECT 1 FROM tool_result_chunks chunks WHERE chunks.result_id = result.result_id
         ))
         ${afterResultId ? 'AND result.result_id > $2::uuid' : ''}`,
      [onlyMissing, ...(afterResultId ? [afterResultId] : [])],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async search(
    query: string,
    limit: number,
    filter: ToolResultFilter = {},
  ): Promise<ToolResultRecord[]> {
    const { clause, params } = this.buildFilter(filter);
    const queryIndex = params.length + 1;
    const conjunction = clause ? ' AND ' : ' WHERE ';
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `SELECT ${SELECT_COLUMNS} ${clause}${conjunction}
       to_tsvector('simple', coalesce(result.server, '') || ' ' || coalesce(result.tool, '') ||
         ' ' || coalesce(result.objective, '') || ' ' || coalesce(result.raw_text, ''))
       @@ websearch_to_tsquery('simple', $${queryIndex})
       ORDER BY result.timestamp DESC, result.result_id DESC
       LIMIT $${queryIndex + 1}`,
      [...params, query, limit],
    );
    return rows.map(mapRow);
  }

  async indexContent(resultId: string, content: string, embedding: number[] | null): Promise<void> {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    await this.dataSource.query(
      `INSERT INTO tool_result_chunks (result_id, chunk_index, chunk_version, content, embedding)
       VALUES ($1, 0, 1, $2, $3::vector)
       ON CONFLICT (result_id, chunk_index, chunk_version) DO UPDATE
       SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
      [resultId, content, vector],
    );
  }

  async indexChunks(
    resultId: string,
    chunks: Array<{ chunkIndex: number; chunkVersion: number; content: string; embedding: number[] | null }>,
  ): Promise<void> {
    const incoming = chunks.map(chunk => ({
      chunk_index: chunk.chunkIndex,
      chunk_version: chunk.chunkVersion,
      content: chunk.content,
      embedding: chunk.embedding ? `[${chunk.embedding.join(',')}]` : null,
    }));
    // Upsert and removal affect disjoint keys in one statement. PostgreSQL rolls
    // back the entire replacement if any new chunk cannot be stored.
    await this.dataSource.query(
      `WITH incoming AS MATERIALIZED (
         SELECT chunk_index, chunk_version, content, embedding::vector AS embedding
         FROM jsonb_to_recordset($2::jsonb)
           AS chunk(chunk_index integer, chunk_version integer, content text, embedding text)
       ), written AS (
         INSERT INTO tool_result_chunks (result_id, chunk_index, chunk_version, content, embedding)
         SELECT $1::uuid, chunk_index, chunk_version, content, embedding FROM incoming WHERE TRUE
         ON CONFLICT (result_id, chunk_index, chunk_version) DO UPDATE
         SET content = EXCLUDED.content, embedding = EXCLUDED.embedding
         RETURNING chunk_index, chunk_version
       )
       DELETE FROM tool_result_chunks old
       WHERE old.result_id = $1::uuid AND NOT EXISTS (
         SELECT 1 FROM incoming
         WHERE incoming.chunk_index = old.chunk_index AND incoming.chunk_version = old.chunk_version
       )`,
      [resultId, JSON.stringify(incoming)],
    );
  }

  async searchChunks(
    resultId: string,
    query: string,
    embedding: number[] | null,
    limit: number,
  ): Promise<ToolResultChunkHit[]> {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `WITH lexical AS (
         SELECT result_id, chunk_index, chunk_version, ROW_NUMBER() OVER (
           ORDER BY ts_rank_cd(to_tsvector('simple', content), websearch_to_tsquery('simple', $2)) DESC
         ) AS lexical_rank
         FROM tool_result_chunks
         WHERE result_id = $1
           AND to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $2)
       ), semantic AS (
         SELECT result_id, chunk_index, chunk_version, ROW_NUMBER() OVER (ORDER BY embedding <=> $3::vector) AS vector_rank
         FROM tool_result_chunks
         WHERE result_id = $1
           AND $3::vector IS NOT NULL
           AND embedding IS NOT NULL
           AND vector_dims(embedding) = vector_dims($3::vector)
       ), ranked AS (
         SELECT ids.result_id, ids.chunk_index, ids.chunk_version,
           COALESCE(1.0 / (60 + lexical.lexical_rank), 0) +
           COALESCE(1.0 / (60 + semantic.vector_rank), 0) AS retrieval_score,
           lexical.lexical_rank, semantic.vector_rank
         FROM (SELECT result_id, chunk_index, chunk_version FROM lexical UNION SELECT result_id, chunk_index, chunk_version FROM semantic) ids
         LEFT JOIN lexical USING (result_id, chunk_index, chunk_version)
         LEFT JOIN semantic USING (result_id, chunk_index, chunk_version)
       )
       SELECT chunks.result_id, chunks.chunk_index, chunks.chunk_version, chunks.content,
         ranked.retrieval_score, ranked.lexical_rank, ranked.vector_rank
       FROM ranked
       JOIN tool_result_chunks chunks USING (result_id, chunk_index, chunk_version)
       WHERE chunks.result_id = $1
       ORDER BY ranked.retrieval_score DESC, chunks.chunk_index ASC
       LIMIT $4`,
      [resultId, query, vector, limit],
    );
    return rows.map((row) => ({
      resultId: String(row.result_id),
      chunkIndex: Number(row.chunk_index),
      chunkVersion: Number(row.chunk_version),
      content: String(row.content),
      retrievalScore: Number(row.retrieval_score ?? 0),
      lexicalRank: row.lexical_rank == null ? undefined : Number(row.lexical_rank),
      vectorRank: row.vector_rank == null ? undefined : Number(row.vector_rank),
    }));
  }

  async hasChunkEmbeddings(resultId: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ available: boolean | string }>>(
      `SELECT EXISTS (SELECT 1 FROM tool_result_chunks WHERE result_id = $1 AND embedding IS NOT NULL) AS available`,
      [resultId],
    );
    return rows[0]?.available === true || rows[0]?.available === 't';
  }

  async listChunks(resultId: string): Promise<ToolResultChunk[]> {
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `SELECT result_id, chunk_index, chunk_version, content,
         octet_length(content)::integer AS content_bytes,
         embedding IS NOT NULL AS has_embedding,
         CASE WHEN embedding IS NULL THEN NULL ELSE vector_dims(embedding) END AS embedding_dimensions
       FROM tool_result_chunks
       WHERE result_id = $1
       ORDER BY chunk_index ASC, chunk_version ASC`,
      [resultId],
    );
    return rows.map((row) => ({
      resultId: String(row.result_id),
      chunkIndex: Number(row.chunk_index),
      chunkVersion: Number(row.chunk_version),
      content: String(row.content),
      contentBytes: Number(row.content_bytes ?? 0),
      hasEmbedding: row.has_embedding === true || row.has_embedding === 't',
      embeddingDimensions: row.embedding_dimensions == null ? undefined : Number(row.embedding_dimensions),
    }));
  }

  async hybridSearch(
    query: string,
    embedding: number[] | null,
    limit: number,
    filter: ToolResultFilter = {},
  ): Promise<ToolResultSearchHit[]> {
    const { clause, params } = this.buildFilter(filter);
    const queryParam = params.length + 1;
    const vectorParam = params.length + 2;
    const limitParam = params.length + 3;
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const rows = await this.dataSource.query<ToolResultRow[]>(
      `WITH scoped_results AS MATERIALIZED (
         SELECT result.result_id FROM tool_results result
         JOIN tool_result_state state ON state.result_id = result.result_id
         ${clause}
       ), lexical_scores AS (
         SELECT chunks.result_id,
           MAX(ts_rank_cd(to_tsvector('simple', content), websearch_to_tsquery('simple', $${queryParam}))) AS score
         FROM tool_result_chunks chunks JOIN scoped_results USING (result_id)
         WHERE to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $${queryParam})
         GROUP BY chunks.result_id
       ), lexical AS (
         SELECT result_id, ROW_NUMBER() OVER (ORDER BY score DESC, result_id) AS lexical_rank
         FROM lexical_scores ORDER BY score DESC, result_id LIMIT 100
       ), semantic_distances AS (
         SELECT chunks.result_id, MIN(embedding <=> $${vectorParam}::vector) AS distance
         FROM tool_result_chunks chunks JOIN scoped_results USING (result_id)
         WHERE $${vectorParam}::vector IS NOT NULL AND embedding IS NOT NULL
           AND vector_dims(embedding) = vector_dims($${vectorParam}::vector)
         GROUP BY chunks.result_id
       ), semantic AS (
         SELECT result_id, ROW_NUMBER() OVER (ORDER BY distance, result_id) AS vector_rank
         FROM semantic_distances ORDER BY distance, result_id LIMIT 100
       ), ranked AS (
         SELECT ids.result_id, lexical.lexical_rank, semantic.vector_rank,
           COALESCE(1.0 / (60 + lexical.lexical_rank), 0) +
           COALESCE(1.0 / (60 + semantic.vector_rank), 0) AS retrieval_score
         FROM (SELECT result_id FROM lexical UNION SELECT result_id FROM semantic) ids
         LEFT JOIN lexical USING (result_id)
         LEFT JOIN semantic USING (result_id)
       )
       SELECT result.*, state.pinned, state.use_count, state.last_referenced_at,
         ranked.retrieval_score, ranked.lexical_rank, ranked.vector_rank
       FROM ranked
       JOIN tool_results result ON result.result_id = ranked.result_id
       JOIN tool_result_state state ON state.result_id = result.result_id
       ${clause}
       ORDER BY ranked.retrieval_score DESC, result.timestamp DESC
       LIMIT $${limitParam}`,
      [...params, query, vector, limit],
    );
    return rows.map((row) => ({
      ...mapRow(row),
      retrievalScore: Number(row.retrieval_score ?? 0),
      lexicalRank: row.lexical_rank == null ? undefined : Number(row.lexical_rank),
      vectorRank: row.vector_rank == null ? undefined : Number(row.vector_rank),
    }));
  }

  async setPinned(resultId: string, pinned: boolean): Promise<ToolResultRecord | null> {
    await this.dataSource.query(
      `UPDATE tool_result_state SET pinned = $2 WHERE result_id = $1`,
      [resultId, pinned],
    );
    return this.findById(resultId);
  }

  async incrementUseCount(resultId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE tool_result_state
       SET use_count = use_count + 1, last_referenced_at = NOW()
       WHERE result_id = $1`,
      [resultId],
    );
  }

  async getStats(filter: ToolResultFilter = {}): Promise<ToolResultStats> {
    const { clause, params } = this.buildFilter(filter);
    const rows = await this.dataSource.query<
      Array<Record<'total' | 'pinned' | 'payload_available' | 'total_raw_bytes', string> & {
        oldest: string | null;
        newest: string | null;
      }>
    >(
      `SELECT COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE state.pinned)::text AS pinned,
        COUNT(*) FILTER (WHERE result.payload_available)::text AS payload_available,
        COALESCE(SUM(result.raw_bytes), 0)::text AS total_raw_bytes,
        MIN(result.timestamp)::text AS oldest,
        MAX(result.timestamp)::text AS newest
       FROM tool_results result
       JOIN tool_result_state state ON state.result_id = result.result_id ${clause}`,
      params,
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      pinned: Number(row?.pinned ?? 0),
      payloadAvailable: Number(row?.payload_available ?? 0),
      totalRawBytes: Number(row?.total_raw_bytes ?? 0),
      oldest: row?.oldest ? new Date(row.oldest) : undefined,
      newest: row?.newest ? new Date(row.newest) : undefined,
    };
  }

  private buildFilter(filter: ToolResultFilter): { clause: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (condition: string, value: unknown): void => {
      params.push(value);
      conditions.push(condition.replace('?', `$${params.length}`));
    };
    if (filter.server) add('result.server = ?', filter.server);
    if (filter.servers) add('result.server = ANY(?::varchar[])', filter.servers);
    if (filter.keyId) add('result.key_id = ?', filter.keyId);
    if (filter.modelId) add("result.attribution->'identity'->>'modelId' = ?", filter.modelId);
    if (filter.taskId) add("result.attribution->>'taskId' = ?", filter.taskId);
    if (filter.traceId) add("result.attribution->>'traceId' = ?", filter.traceId);
    if (filter.branchId) add("result.attribution->>'branchId' = ?", filter.branchId);
    if (filter.tool) add('result.tool = ?', filter.tool);
    if (filter.status) add('result.status = ?', filter.status);
    if (filter.username) add('result.username = ?', filter.username);
    if (filter.sessionId) add('result.session_id = ?', filter.sessionId);
    if (filter.conversationId) add('result.conversation_id = ?', filter.conversationId);
    if (filter.parentResultId) add('result.parent_result_id = ?', filter.parentResultId);
    if (filter.pinned !== undefined) add('state.pinned = ?', filter.pinned);
    if (filter.startDate) add('result.timestamp >= ?', filter.startDate);
    if (filter.endDate) add('result.timestamp <= ?', filter.endDate);
    return {
      clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }
}
