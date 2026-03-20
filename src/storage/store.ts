import { and, desc, eq, inArray, lte, gte, sql } from "drizzle-orm"
import type { Database } from "bun:sqlite"
import {
  deletionLog,
  observationEmbeddings,
  observations,
  pendingMessages,
  sessionSummaries,
  toolUsageStats,
  userPrompts,
  type DeletionLogRow,
  type ObservationEmbeddingRow,
  type ObservationRow,
  type PendingMessageRow,
  type SessionSummaryRow,
  type ToolUsageStatRow,
  type UserPromptRow,
} from "./schema"
import type { MemoryDatabase } from "./db"
import type {
  EmbeddingSearchOptions,
  DeletionInitiator,
  DeletionLogEntry,
  MemorySearchResult,
  Observation,
  ObservationEmbedding,
  ObservationType,
  PendingMessage,
  PendingStatus,
  ProjectScope,
  SessionSummary,
  TimelinePage,
  TimelineQuery,
  ToolUsageStat,
  UserPromptRecord,
} from "../types"
import { createSortableId, parseJsonValue, sanitizeFtsQuery, serializeJson } from "../utils"

type MaxRow = { value: number | null }

type SearchCandidate = {
  id: string
  title: string
  subtitle: string | null
  type: ObservationType
  createdAt: number
  toolName: string | null
  quality: Observation["quality"]
  lexicalScore?: number
  semanticScore?: number
}

/**
 * Provides project-scoped persistence and retrieval operations for the memory plugin.
 */
export class MemoryStore {
  constructor(
    private readonly database: MemoryDatabase,
    private readonly scope: ProjectScope,
    private readonly now: () => number,
  ) {}

  /**
   * Closes the underlying SQLite connection.
   *
   * @returns Nothing.
   */
  close(): void {
    this.database.sqlite.close()
  }

  /**
   * Persists a compressed observation.
   *
   * @param observation - Observation to save.
   * @returns A promise that resolves after insertion.
   */
  async saveObservation(observation: Observation): Promise<void> {
    this.database.db.insert(observations).values({
      id: observation.id,
      projectId: observation.projectId,
      projectRoot: observation.projectRoot,
      sessionId: observation.sessionId,
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle,
      narrative: observation.narrative,
      facts: serializeJson(observation.facts),
      concepts: serializeJson(observation.concepts),
      filesInvolved: serializeJson(observation.filesInvolved),
      rawTokenCount: observation.rawTokenCount,
      compressedTokenCount: observation.compressedTokenCount,
      toolName: observation.toolName,
      modelUsed: observation.modelUsed,
      quality: observation.quality,
      rawFallback: observation.rawFallback,
      createdAt: observation.createdAt,
    }).run()
  }

  /**
   * Retrieves a single observation by identifier.
   *
   * @param id - Observation identifier.
   * @returns The observation or null.
   */
  async getObservation(id: string): Promise<Observation | null> {
    const row = this.database.db
      .select()
      .from(observations)
      .where(and(eq(observations.id, id), eq(observations.projectId, this.scope.projectId)))
      .get()

    return row ? mapObservation(row) : null
  }

  /**
   * Retrieves multiple observations in a single query.
   *
   * @param ids - Observation identifiers.
   * @returns Matching observations.
   */
  async getObservationsBatch(ids: string[]): Promise<Observation[]> {
    if (!ids.length) {
      return []
    }

    const rows = this.database.db
      .select()
      .from(observations)
      .where(and(inArray(observations.id, ids), eq(observations.projectId, this.scope.projectId)))
      .orderBy(desc(observations.createdAt))
      .all()

    return rows.map(mapObservation)
  }

  /**
   * Retrieves the most recent observations for the current project.
   *
   * @param limit - Maximum number of rows.
   * @returns Recent observations ordered from newest to oldest.
   */
  async getRecentObservations(limit: number): Promise<Observation[]> {
    const rows = this.database.db
      .select()
      .from(observations)
      .where(eq(observations.projectId, this.scope.projectId))
      .orderBy(desc(observations.createdAt))
      .limit(limit)
      .all()

    return rows.map(mapObservation)
  }

  /**
   * Retrieves all observations recorded for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns Observations ordered from oldest to newest.
   */
  async getSessionObservations(sessionId: string): Promise<Observation[]> {
    const rows = this.database.db
      .select()
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), eq(observations.sessionId, sessionId)))
      .orderBy(observations.createdAt)
      .all()

    return rows.map(mapObservation)
  }

  /**
   * Returns the total number of stored observations for the current project.
   *
   * @returns Observation count.
   */
  async countObservations(): Promise<number> {
    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observations)
      .where(eq(observations.projectId, this.scope.projectId))
      .get()

    return row?.value ?? 0
  }

  /**
   * Adds a pending raw tool result to the crash-safe queue.
   *
   * @param pendingMessage - Pending message payload.
   * @returns A promise that resolves after insertion.
   */
  async enqueuePending(pendingMessage: PendingMessage): Promise<void> {
    this.database.db.insert(pendingMessages).values({
      id: pendingMessage.id,
      projectId: pendingMessage.projectId,
      projectRoot: pendingMessage.projectRoot,
      sessionId: pendingMessage.sessionId,
      toolName: pendingMessage.toolName,
      title: pendingMessage.title,
      rawContent: pendingMessage.rawContent,
      rawMetadata: pendingMessage.rawMetadata ? serializeJson(pendingMessage.rawMetadata) : null,
      status: pendingMessage.status,
      retryCount: pendingMessage.retryCount,
      errorMessage: pendingMessage.errorMessage,
      createdAt: pendingMessage.createdAt,
      processedAt: pendingMessage.processedAt,
    }).run()
  }

  /**
   * Fetches pending messages by status.
   *
   * @param statuses - Accepted queue statuses.
   * @param limit - Maximum number of rows.
   * @returns Matching pending messages.
   */
  async getPendingMessages(statuses: PendingStatus[], limit: number): Promise<PendingMessage[]> {
    const rows = this.database.db
      .select()
      .from(pendingMessages)
      .where(
        and(
          eq(pendingMessages.projectId, this.scope.projectId),
          inArray(pendingMessages.status, statuses),
        ),
      )
      .orderBy(pendingMessages.createdAt)
      .limit(limit)
      .all()

    return rows.map(mapPendingMessage)
  }

  /**
   * Finds queue items that were left in processing state past the orphan threshold.
   *
   * @param orphanThresholdMs - Threshold in milliseconds.
   * @returns Orphaned pending messages.
   */
  async getOrphanedMessages(orphanThresholdMs: number): Promise<PendingMessage[]> {
    const cutoff = this.now() - orphanThresholdMs
    const rows = this.database.db
      .select()
      .from(pendingMessages)
      .where(
        and(
          eq(pendingMessages.projectId, this.scope.projectId),
          eq(pendingMessages.status, "processing"),
          lte(pendingMessages.createdAt, cutoff),
        ),
      )
      .orderBy(pendingMessages.createdAt)
      .all()

    return rows.map(mapPendingMessage)
  }

  /**
   * Updates the status for a queued message.
   *
   * @param id - Pending message identifier.
   * @param status - Next queue status.
   * @param retryCount - Updated retry count.
   * @param errorMessage - Optional error message.
   * @returns A promise that resolves after the update.
   */
  async updatePendingStatus(
    id: string,
    status: PendingStatus,
    retryCount: number,
    errorMessage: string | null,
  ): Promise<void> {
    this.database.db
      .update(pendingMessages)
      .set({
        status,
        retryCount,
        errorMessage,
        processedAt: status === "processed" ? this.now() : null,
      })
      .where(and(eq(pendingMessages.id, id), eq(pendingMessages.projectId, this.scope.projectId)))
      .run()
  }

  /**
   * Counts queued items for a specific session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns Queue size for that session.
   */
  async countPendingForSession(sessionId: string): Promise<number> {
    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(pendingMessages)
      .where(
        and(
          eq(pendingMessages.projectId, this.scope.projectId),
          eq(pendingMessages.sessionId, sessionId),
          inArray(pendingMessages.status, ["pending", "processing"]),
        ),
      )
      .get()

    return row?.value ?? 0
  }

  /**
   * Saves or replaces a session summary.
   *
   * @param summary - Summary payload.
   * @returns A promise that resolves after persistence.
   */
  async saveSessionSummary(summary: SessionSummary): Promise<void> {
    this.database.db
      .insert(sessionSummaries)
      .values({
        id: summary.id,
        projectId: summary.projectId,
        projectRoot: summary.projectRoot,
        sessionId: summary.sessionId,
        requested: summary.requested,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        nextSteps: summary.nextSteps,
        observationCount: summary.observationCount,
        modelUsed: summary.modelUsed,
        createdAt: summary.createdAt,
      })
      .onConflictDoUpdate({
        target: [sessionSummaries.projectId, sessionSummaries.sessionId],
        set: {
          requested: summary.requested,
          investigated: summary.investigated,
          learned: summary.learned,
          completed: summary.completed,
          nextSteps: summary.nextSteps,
          observationCount: summary.observationCount,
          modelUsed: summary.modelUsed,
          createdAt: summary.createdAt,
        },
      })
      .run()
  }

  /**
   * Retrieves the latest summary for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns The stored summary or null.
   */
  async getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    const row = this.database.db
      .select()
      .from(sessionSummaries)
      .where(and(eq(sessionSummaries.projectId, this.scope.projectId), eq(sessionSummaries.sessionId, sessionId)))
      .get()

    return row ? mapSessionSummary(row) : null
  }

  /**
   * Retrieves the most recent summaries for the current project.
   *
   * @param limit - Maximum number of summaries.
   * @returns Recent summaries ordered from newest to oldest.
   */
  async getRecentSummaries(limit: number): Promise<SessionSummary[]> {
    const rows = this.database.db
      .select()
      .from(sessionSummaries)
      .where(eq(sessionSummaries.projectId, this.scope.projectId))
      .orderBy(desc(sessionSummaries.createdAt))
      .limit(limit)
      .all()

    return rows.map(mapSessionSummary)
  }

  /**
   * Stores a user prompt for later summarization and retrieval.
   *
   * @param prompt - Prompt payload.
   * @returns A promise that resolves after insertion.
   */
  async saveUserPrompt(prompt: UserPromptRecord): Promise<void> {
    this.database.db
      .insert(userPrompts)
      .values({
        id: prompt.id,
        projectId: prompt.projectId,
        projectRoot: prompt.projectRoot,
        sessionId: prompt.sessionId,
        messageId: prompt.messageId,
        content: prompt.content,
        createdAt: prompt.createdAt,
      })
      .onConflictDoNothing({ target: userPrompts.messageId })
      .run()
  }

  /**
   * Returns prompts associated with a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns Session prompts ordered from oldest to newest.
   */
  async getSessionUserPrompts(sessionId: string): Promise<UserPromptRecord[]> {
    const rows = this.database.db
      .select()
      .from(userPrompts)
      .where(and(eq(userPrompts.projectId, this.scope.projectId), eq(userPrompts.sessionId, sessionId)))
      .orderBy(userPrompts.createdAt)
      .all()

    return rows.map(mapUserPrompt)
  }

  /**
   * Searches observations through the FTS5 index.
   *
   * @param query - User-entered search text.
   * @param limit - Maximum number of results.
   * @param typeFilter - Optional observation type filter.
   * @returns Compact search results.
   */
  async searchFTS(
    query: string,
    limit: number,
    typeFilter?: ObservationType,
  ): Promise<MemorySearchResult[]> {
    const rows = this.searchFTSRows(query, limit, typeFilter)

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      type: row.type,
      createdAt: row.createdAt,
      toolName: row.toolName,
      quality: row.quality,
      source: "lexical",
      score: row.lexicalScore ?? null,
    }))
  }

  /**
   * Searches observations through the vector index.
   *
   * @param embedding - Query embedding.
   * @param options - Ranking and filtering options.
   * @returns Compact semantic search results.
   */
  async searchSemantic(embedding: number[], options: EmbeddingSearchOptions): Promise<MemorySearchResult[]> {
    if (!embedding.length) {
      return []
    }

    const semanticRows = this.searchSemanticRows(embedding, options.semanticLimit ?? options.limit, options.typeFilter)
      .filter((row) => (row.semanticScore ?? 0) >= options.semanticMinScore)
      .sort((left, right) => {
        const leftScore = left.semanticScore ?? 0
        const rightScore = right.semanticScore ?? 0
        if (rightScore !== leftScore) {
          return rightScore - leftScore
        }

        return right.createdAt - left.createdAt
      })
      .slice(0, options.limit)

    return semanticRows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      type: row.type,
      createdAt: row.createdAt,
      toolName: row.toolName,
      quality: row.quality,
      source: "semantic",
      score: row.semanticScore ?? null,
    }))
  }

  /**
   * Combines lexical and semantic retrieval into a single ranked result list.
   *
   * @param query - Raw search query.
   * @param embedding - Optional semantic query embedding.
   * @param options - Ranking and filtering options.
   * @returns Compact hybrid search results.
   */
  async searchHybrid(
    query: string,
    embedding: number[] | null,
    options: EmbeddingSearchOptions,
  ): Promise<MemorySearchResult[]> {
    const lexicalRows = this.searchFTSRows(query, options.limit, options.typeFilter)
    if (!embedding?.length) {
      return lexicalRows.map((row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        type: row.type,
        createdAt: row.createdAt,
        toolName: row.toolName,
        quality: row.quality,
        source: "lexical",
        score: row.lexicalScore ?? null,
      }))
    }

    const semanticRows = this.searchSemanticRows(embedding, options.semanticLimit ?? options.limit, options.typeFilter)
    const entries = new Map<string, SearchCandidate>()

    for (const row of lexicalRows) {
      entries.set(row.id, row)
    }

    for (const row of semanticRows) {
      const existing = entries.get(row.id)
      if (existing) {
        existing.semanticScore = row.semanticScore
        continue
      }

      entries.set(row.id, row)
    }

    const ranked = Array.from(entries.values())
      .map((row) => {
        const lexicalScore = row.lexicalScore ?? 0
        const semanticScore = row.semanticScore ?? 0
        const score = lexicalScore > 0 && semanticScore > 0
          ? lexicalScore * options.hybridSearchAlpha + semanticScore * (1 - options.hybridSearchAlpha)
          : lexicalScore || semanticScore
        const qualityPenalty = row.quality === "low" ? 0.15 : row.quality === "medium" ? 0.05 : 0

        return {
          ...row,
          combinedScore: Math.max(0, score - qualityPenalty),
        }
      })
      .filter((row) => row.lexicalScore || row.semanticScore)
      .filter((row) => row.semanticScore === undefined || row.semanticScore >= options.semanticMinScore || row.lexicalScore)
      .sort((left, right) => {
        if (right.combinedScore !== left.combinedScore) {
          return right.combinedScore - left.combinedScore
        }

        return right.createdAt - left.createdAt
      })
      .slice(0, options.limit)

    return ranked.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      type: row.type,
      createdAt: row.createdAt,
      toolName: row.toolName,
      quality: row.quality,
      source: row.lexicalScore && row.semanticScore ? "hybrid" : row.semanticScore ? "semantic" : "lexical",
      score: row.combinedScore,
    }))
  }

  /**
   * Stores or replaces an observation embedding.
   *
   * @param embedding - Embedding metadata to persist.
   * @param observation - Observation linked to the embedding.
   * @param vector - Numeric embedding vector.
   * @returns A promise that resolves after persistence.
   */
  async saveObservationEmbedding(
    embedding: ObservationEmbedding,
    observation: Observation,
    vector: number[],
  ): Promise<void> {
    if (!vector.length) {
      return
    }

    this.database.db
      .insert(observationEmbeddings)
      .values({
        observationId: embedding.observationId,
        projectId: embedding.projectId,
        embeddingModel: embedding.embeddingModel,
        embeddingDimensions: embedding.embeddingDimensions,
        embeddingInput: embedding.embeddingInput,
        embeddingVector: serializeJson(vector),
        createdAt: embedding.createdAt,
        updatedAt: embedding.updatedAt,
      })
      .onConflictDoUpdate({
        target: observationEmbeddings.observationId,
        set: {
          embeddingModel: embedding.embeddingModel,
          embeddingDimensions: embedding.embeddingDimensions,
          embeddingInput: embedding.embeddingInput,
          embeddingVector: serializeJson(vector),
          updatedAt: embedding.updatedAt,
        },
      })
      .run()

    if (!this.database.vector.available) {
      return
    }

    this.database.sqlite
      .query("DELETE FROM observation_embeddings_vec WHERE observation_id = ?")
      .run(embedding.observationId)

    this.database.sqlite
      .query(
        `
          INSERT INTO observation_embeddings_vec(
            observation_id,
            project_id,
            type,
            quality,
            created_at,
            embedding
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        embedding.observationId,
        embedding.projectId,
        observation.type,
        observation.quality,
        observation.createdAt,
        JSON.stringify(vector),
      )
  }

  /**
   * Deletes stored embeddings for a set of observations.
   *
   * @param ids - Observation identifiers.
   * @returns A promise that resolves after deletion.
   */
  async deleteObservationEmbeddings(ids: string[]): Promise<void> {
    if (!ids.length) {
      return
    }

    this.database.db
      .delete(observationEmbeddings)
      .where(and(eq(observationEmbeddings.projectId, this.scope.projectId), inArray(observationEmbeddings.observationId, ids)))
      .run()

    if (!this.database.vector.available) {
      return
    }

    const placeholders = ids.map(() => "?").join(", ")
    this.database.sqlite
      .query(`DELETE FROM observation_embeddings_vec WHERE project_id = ? AND observation_id IN (${placeholders})`)
      .run(this.scope.projectId, ...ids)
  }

  /**
   * Returns embedding coverage statistics for the current project.
   *
   * @returns Vector coverage and metadata summary.
   */
  async getEmbeddingStats(): Promise<{
    totalEmbeddings: number
    coverage: number
    model: string | null
    dimensions: number | null
    vectorAvailable: boolean
    backendMode: "sqlite-vec" | "js-fallback"
    semanticEnabled: boolean
    vectorError: string | null
  }> {
    const countRow = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observationEmbeddings)
      .where(eq(observationEmbeddings.projectId, this.scope.projectId))
      .get()

    const latestRow = this.database.db
      .select({
        embeddingModel: observationEmbeddings.embeddingModel,
        embeddingDimensions: observationEmbeddings.embeddingDimensions,
      })
      .from(observationEmbeddings)
      .where(eq(observationEmbeddings.projectId, this.scope.projectId))
      .orderBy(desc(observationEmbeddings.updatedAt))
      .get()

    const totalEmbeddings = countRow?.value ?? 0
    const totalObservations = await this.countObservations()

    return {
      totalEmbeddings,
      coverage: totalObservations > 0 ? totalEmbeddings / totalObservations : 0,
      model: latestRow?.embeddingModel ?? null,
      dimensions: latestRow?.embeddingDimensions ?? null,
      vectorAvailable: this.database.vector.available,
      backendMode: this.database.vector.available ? "sqlite-vec" : "js-fallback",
      semanticEnabled: this.database.vector.enabled,
      vectorError: this.database.vector.error,
    }
  }

  /**
   * Returns the latest user prompt for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns The latest prompt text or null.
   */
  async getLatestUserPrompt(sessionId: string): Promise<string | null> {
    const row = this.database.db
      .select({ content: userPrompts.content })
      .from(userPrompts)
      .where(and(eq(userPrompts.projectId, this.scope.projectId), eq(userPrompts.sessionId, sessionId)))
      .orderBy(desc(userPrompts.createdAt))
      .get()

    return row?.content ?? null
  }

  /**
   * Returns the current vector backend state.
   *
   * @returns Vector backend state.
   */
  getVectorBackendState() {
    return this.database.vector
  }

  /**
   * Executes the lexical portion of search and normalizes scores.
   *
   * @param query - Raw user query.
   * @param limit - Maximum number of results.
   * @param typeFilter - Optional observation type filter.
   * @returns Lexical candidates with normalized scores.
   */
  private searchFTSRows(query: string, limit: number, typeFilter?: ObservationType): SearchCandidate[] {
    const match = sanitizeFtsQuery(query)
    if (!match) {
      return []
    }

    const sqlText = `
      SELECT
        o.id,
        o.title,
        o.subtitle,
        o.type,
        o.created_at,
        o.tool_name,
        o.quality,
        bm25(observations_fts) AS lexical_rank
      FROM observations_fts f
      JOIN observations o ON o.rowid = f.rowid
      WHERE observations_fts MATCH ?
        AND o.project_id = ?
        ${typeFilter ? "AND o.type = ?" : ""}
      ORDER BY lexical_rank, o.created_at DESC
      LIMIT ?
    `

    const parameters = typeFilter
      ? [match, this.scope.projectId, typeFilter, limit]
      : [match, this.scope.projectId, limit]

    const rows = this.database.sqlite.query(sqlText).all(...parameters) as Array<{
      id: string
      title: string
      subtitle: string | null
      type: ObservationType
      created_at: number
      tool_name: string | null
      quality: Observation["quality"]
      lexical_rank: number | null
    }>

    return rows.map((row, index) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      type: row.type,
      createdAt: row.created_at,
      toolName: row.tool_name,
      quality: row.quality,
      lexicalScore: normalizeRank(row.lexical_rank, index),
    }))
  }

  /**
   * Executes semantic search against the sqlite-vec table.
   *
   * @param embedding - Query embedding.
   * @param limit - Maximum number of results.
   * @param typeFilter - Optional observation type filter.
   * @returns Semantic candidates with normalized cosine scores.
   */
  private searchSemanticRows(embedding: number[], limit: number, typeFilter?: ObservationType): SearchCandidate[] {
    if (!this.database.vector.available) {
      const conditions = [eq(observationEmbeddings.projectId, this.scope.projectId)]
      if (typeFilter) {
        conditions.push(eq(observations.type, typeFilter))
      }

      const rows = this.database.db
        .select({
          observationId: observationEmbeddings.observationId,
          embeddingVector: observationEmbeddings.embeddingVector,
          title: observations.title,
          subtitle: observations.subtitle,
          type: observations.type,
          createdAt: observations.createdAt,
          toolName: observations.toolName,
          quality: observations.quality,
        })
        .from(observationEmbeddings)
        .innerJoin(observations, eq(observations.id, observationEmbeddings.observationId))
        .where(and(...conditions))
        .all()

      return rows
        .map((row) => ({
          id: row.observationId,
          title: row.title,
          subtitle: row.subtitle,
          type: row.type as ObservationType,
          createdAt: row.createdAt,
          toolName: row.toolName,
          quality: row.quality as Observation["quality"],
          semanticScore: cosineSimilarity(embedding, parseJsonValue<number[]>(row.embeddingVector, [])),
        }))
        .filter((row) => (row.semanticScore ?? 0) > 0)
        .sort((left, right) => {
          const leftScore = left.semanticScore ?? 0
          const rightScore = right.semanticScore ?? 0
          if (rightScore !== leftScore) {
            return rightScore - leftScore
          }

          return right.createdAt - left.createdAt
        })
        .slice(0, limit)
    }

    const sqlText = `
      SELECT
        o.id,
        o.title,
        o.subtitle,
        o.type,
        o.created_at,
        o.tool_name,
        o.quality,
        v.distance
      FROM observation_embeddings_vec v
      JOIN observations o ON o.id = v.observation_id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND v.project_id = ?
        ${typeFilter ? "AND v.type = ?" : ""}
      ORDER BY v.distance, o.created_at DESC
    `

    const serialized = JSON.stringify(embedding)
    const parameters = typeFilter
      ? [serialized, limit, this.scope.projectId, typeFilter]
      : [serialized, limit, this.scope.projectId]

    const rows = this.database.sqlite.query(sqlText).all(...parameters) as Array<{
      id: string
      title: string
      subtitle: string | null
      type: ObservationType
      created_at: number
      tool_name: string | null
      quality: Observation["quality"]
      distance: number
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      type: row.type,
      createdAt: row.created_at,
      toolName: row.tool_name,
      quality: row.quality,
      semanticScore: normalizeDistance(row.distance),
    }))
  }

  /**
   * Retrieves a timeline page for the current project.
   *
   * @param query - Timeline filters and pagination options.
   * @returns Timeline page with the next cursor.
   */
  async getTimeline(query: TimelineQuery): Promise<TimelinePage> {
    const conditions = [eq(observations.projectId, this.scope.projectId)]

    if (query.before) {
      conditions.push(lte(observations.createdAt, query.before))
    }

    if (query.after) {
      conditions.push(sql`${observations.createdAt} >= ${query.after}`)
    }

    if (query.sessionId) {
      conditions.push(eq(observations.sessionId, query.sessionId))
    }

    const rows = this.database.db
      .select()
      .from(observations)
      .where(and(...conditions))
      .orderBy(desc(observations.createdAt))
      .limit(query.limit + 1)
      .all()
      .map(mapObservation)

    const hasMore = rows.length > query.limit
    const observationsPage = hasMore ? rows.slice(0, query.limit) : rows
    const lastObservation = observationsPage.at(-1) ?? null

    return {
      observations: observationsPage,
      nextCursor: hasMore && lastObservation ? String(lastObservation.createdAt - 1) : null,
    }
  }

  /**
   * Determines whether a session has new activity after its current summary.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns True when a summary refresh is needed.
   */
  async hasSessionActivityAfterSummary(sessionId: string): Promise<boolean> {
    const summary = await this.getSessionSummary(sessionId)
    if (!summary) {
      const observationCount = await this.countSessionObservations(sessionId)
      const promptCount = await this.countSessionPrompts(sessionId)
      return observationCount > 0 || promptCount > 0
    }

    const lastObservation = this.getLastTimestamp(
      this.database.sqlite,
      "observations",
      sessionId,
      this.scope.projectId,
    )
    const lastPrompt = this.getLastTimestamp(
      this.database.sqlite,
      "user_prompts",
      sessionId,
      this.scope.projectId,
    )
    const lastActivity = Math.max(lastObservation, lastPrompt)
    return lastActivity > summary.createdAt
  }

  /**
   * Counts observations for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns Observation count.
   */
  async countSessionObservations(sessionId: string): Promise<number> {
    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), eq(observations.sessionId, sessionId)))
      .get()

    return row?.value ?? 0
  }

  /**
   * Counts prompts for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns Prompt count.
   */
  async countSessionPrompts(sessionId: string): Promise<number> {
    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(userPrompts)
      .where(and(eq(userPrompts.projectId, this.scope.projectId), eq(userPrompts.sessionId, sessionId)))
      .get()

    return row?.value ?? 0
  }

  /**
   * Deletes a set of observations by identifier.
   *
   * @param ids - Observation identifiers.
   * @returns Number of deleted observations.
   */
  async deleteObservations(ids: string[]): Promise<number> {
    if (!ids.length) {
      return 0
    }

    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), inArray(observations.id, ids)))
      .get()

    const count = row?.value ?? 0
    if (!count) {
      return 0
    }

    await this.deleteObservationEmbeddings(ids)

    this.database.db
      .delete(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), inArray(observations.id, ids)))
      .run()

    return count
  }

  /**
   * Deletes observations that match an FTS query.
   *
   * @param ftsQuery - Raw user query.
   * @returns Number of deleted observations.
   */
  async deleteByQuery(ftsQuery: string): Promise<number> {
    const match = sanitizeFtsQuery(ftsQuery)
    if (!match) {
      return 0
    }

    const rows = this.database.sqlite
      .query(
        `
          SELECT o.id
          FROM observations_fts f
          JOIN observations o ON o.rowid = f.rowid
          WHERE observations_fts MATCH ?
            AND o.project_id = ?
        `,
      )
      .all(match, this.scope.projectId) as Array<{ id: string }>

    return this.deleteObservations(rows.map((row) => row.id))
  }

  /**
   * Deletes all observations and summary for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @returns Number of deleted observations.
   */
  async deleteBySession(sessionId: string): Promise<number> {
    const rows = this.database.db
      .select({ id: observations.id })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), eq(observations.sessionId, sessionId)))
      .all()

    const count = await this.deleteObservations(rows.map((row) => row.id))

    this.database.db
      .delete(sessionSummaries)
      .where(and(eq(sessionSummaries.projectId, this.scope.projectId), eq(sessionSummaries.sessionId, sessionId)))
      .run()

    return count
  }

  /**
   * Deletes observations created before or at a given date.
   *
   * @param date - Cutoff date.
   * @returns Number of deleted observations.
   */
  async deleteBefore(date: Date): Promise<number> {
    const cutoff = date.getTime()
    if (!Number.isFinite(cutoff)) {
      return 0
    }

    const rows = this.database.db
      .select({ id: observations.id })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), lte(observations.createdAt, cutoff)))
      .all()

    const count = rows.length
    if (!count) {
      return 0
    }

    await this.deleteObservations(rows.map((row) => row.id))

    return count
  }

  /**
   * Stores a deletion audit log entry.
   *
   * @param criteria - JSON criteria description.
   * @param count - Deleted observation count.
   * @param initiator - Operation initiator.
   * @returns A promise that resolves after insertion.
   */
  async logDeletion(criteria: string, count: number, initiator: DeletionInitiator): Promise<void> {
    this.database.db.insert(deletionLog).values({
      id: this.createId(),
      projectId: this.scope.projectId,
      projectRoot: this.scope.projectRoot,
      timestamp: this.now(),
      criteria,
      count,
      initiator,
    }).run()
  }

  /**
   * Increments tool usage counters for a session.
   *
   * @param sessionId - OpenCode session identifier.
   * @param toolName - Tool name.
   * @returns A promise that resolves after update.
   */
  async incrementToolUsage(sessionId: string, toolName: string): Promise<void> {
    const existing = this.database.db
      .select({ id: toolUsageStats.id, callCount: toolUsageStats.callCount })
      .from(toolUsageStats)
      .where(
        and(
          eq(toolUsageStats.projectId, this.scope.projectId),
          eq(toolUsageStats.sessionId, sessionId),
          eq(toolUsageStats.toolName, toolName),
        ),
      )
      .get()

    if (!existing) {
      this.database.db.insert(toolUsageStats).values({
        id: this.createId(),
        projectId: this.scope.projectId,
        projectRoot: this.scope.projectRoot,
        sessionId,
        toolName,
        callCount: 1,
        createdAt: this.now(),
      }).run()
      return
    }

    this.database.db
      .update(toolUsageStats)
      .set({
        callCount: existing.callCount + 1,
        createdAt: this.now(),
      })
      .where(eq(toolUsageStats.id, existing.id))
      .run()
  }

  /**
   * Retrieves tool usage stats from the last N days.
   *
   * @param days - Lookback window in days.
   * @returns Matching tool usage rows.
   */
  async getToolUsageStats(days: number): Promise<ToolUsageStat[]> {
    const cutoff = this.now() - Math.max(1, days) * 86_400_000
    const rows = this.database.db
      .select()
      .from(toolUsageStats)
      .where(and(eq(toolUsageStats.projectId, this.scope.projectId), gte(toolUsageStats.createdAt, cutoff)))
      .orderBy(desc(toolUsageStats.createdAt))
      .all()

    return rows.map(mapToolUsageStat)
  }

  /**
   * Returns observation quality distribution counts.
   *
   * @returns Quality counts by bucket.
   */
  async getQualityDistribution(): Promise<{ high: number; medium: number; low: number }> {
    const rows = this.database.sqlite
      .query(
        `
          SELECT quality, COUNT(*) AS value
          FROM observations
          WHERE project_id = ?
          GROUP BY quality
        `,
      )
      .all(this.scope.projectId) as Array<{ quality: string; value: number }>

    const distribution = {
      high: 0,
      medium: 0,
      low: 0,
    }

    for (const row of rows) {
      if (row.quality === "high" || row.quality === "medium" || row.quality === "low") {
        distribution[row.quality] = row.value
      }
    }

    return distribution
  }

  /**
   * Returns success metrics for a compression model.
   *
   * @param modelName - Model identifier.
   * @returns Total, success and rate values.
   */
  async getModelSuccessRate(modelName: string): Promise<{ total: number; success: number; rate: number }> {
    const totalRow = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), eq(observations.modelUsed, modelName)))
      .get()

    const successRow = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observations)
      .where(
        and(
          eq(observations.projectId, this.scope.projectId),
          eq(observations.modelUsed, modelName),
          inArray(observations.quality, ["high", "medium"]),
        ),
      )
      .get()

    const total = totalRow?.value ?? 0
    const success = successRow?.value ?? 0

    return {
      total,
      success,
      rate: total > 0 ? success / total : 0,
    }
  }

  /**
   * Searches observations within a date range.
   *
   * @param from - Range start.
   * @param to - Range end.
   * @param limit - Maximum number of rows.
   * @returns Matching observations.
   */
  async searchByDateRange(from: Date, to: Date, limit: number): Promise<Observation[]> {
    const fromTimestamp = from.getTime()
    const toTimestamp = to.getTime()
    if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp)) {
      return []
    }

    const start = Math.min(fromTimestamp, toTimestamp)
    const end = Math.max(fromTimestamp, toTimestamp)

    const rows = this.database.db
      .select()
      .from(observations)
      .where(
        and(
          eq(observations.projectId, this.scope.projectId),
          gte(observations.createdAt, start),
          lte(observations.createdAt, end),
        ),
      )
      .orderBy(desc(observations.createdAt))
      .limit(Math.max(1, limit))
      .all()

    return rows.map(mapObservation)
  }

  /**
   * Searches observations by matching file paths against the FTS index.
   *
   * @param filePaths - File path patterns.
   * @returns Matching observations.
   */
  async searchByFiles(filePaths: string[]): Promise<Observation[]> {
    const matches = filePaths
      .map((filePath) => sanitizeFtsQuery(filePath))
      .filter(Boolean)

    if (!matches.length) {
      return []
    }

    const matchQuery = matches.map((value) => `(${value})`).join(" OR ")
    const rows = this.database.sqlite
      .query(
        `
          SELECT o.id
          FROM observations_fts f
          JOIN observations o ON o.rowid = f.rowid
          WHERE observations_fts MATCH ?
            AND o.project_id = ?
          ORDER BY bm25(observations_fts), o.created_at DESC
          LIMIT 200
        `,
      )
      .all(matchQuery, this.scope.projectId) as Array<{ id: string }>

    return this.getObservationsBatch(rows.map((row) => row.id))
  }

  /**
   * Returns the number of summaries for the current project.
   *
   * @returns Summary count.
   */
  async countSessionSummaries(): Promise<number> {
    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(sessionSummaries)
      .where(eq(sessionSummaries.projectId, this.scope.projectId))
      .get()

    return row?.value ?? 0
  }

  /**
   * Returns pending queue counts grouped by status.
   *
   * @returns Status count object.
   */
  async getPendingStatusCounts(): Promise<Record<PendingStatus, number>> {
    const rows = this.database.sqlite
      .query(
        `
          SELECT status, COUNT(*) AS value
          FROM pending_messages
          WHERE project_id = ?
          GROUP BY status
        `,
      )
      .all(this.scope.projectId) as Array<{ status: PendingStatus; value: number }>

    const counts: Record<PendingStatus, number> = {
      pending: 0,
      processing: 0,
      processed: 0,
      failed: 0,
    }

    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status] = row.value
      }
    }

    return counts
  }

  /**
   * Counts observations since a timestamp.
   *
   * @param timestamp - Lower bound timestamp.
   * @returns Observation count.
   */
  async countObservationsSince(timestamp: number): Promise<number> {
    const row = this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), gte(observations.createdAt, timestamp)))
      .get()

    return row?.value ?? 0
  }

  /**
   * Calculates compression ratio and last compression timestamp.
   *
   * @returns Compression summary values.
   */
  async getCompressionStats(): Promise<{ averageRatio: number; lastCompressedAt: number | null }> {
    const row = this.database.sqlite
      .query(
        `
          SELECT
            AVG(CASE WHEN compressed_token_count > 0 THEN CAST(raw_token_count AS REAL) / compressed_token_count END) AS average_ratio,
            MAX(created_at) AS last_compressed_at
          FROM observations
          WHERE project_id = ?
        `,
      )
      .get(this.scope.projectId) as {
      average_ratio: number | null
      last_compressed_at: number | null
    } | null

    return {
      averageRatio: row?.average_ratio ?? 0,
      lastCompressedAt: row?.last_compressed_at ?? null,
    }
  }

  /**
   * Returns deletion log totals for a lookback window.
   *
   * @param days - Lookback in days.
   * @returns Operation and deletion totals.
   */
  async getDeletionStats(days: number): Promise<{ operations: number; removed: number }> {
    const cutoff = this.now() - Math.max(1, days) * 86_400_000
    const row = this.database.sqlite
      .query(
        `
          SELECT COUNT(*) AS operations, COALESCE(SUM(count), 0) AS removed
          FROM deletion_log
          WHERE project_id = ?
            AND timestamp >= ?
        `,
      )
      .get(this.scope.projectId, cutoff) as {
      operations: number
      removed: number
    } | null

    return {
      operations: row?.operations ?? 0,
      removed: row?.removed ?? 0,
    }
  }

  /**
   * Returns the current SQLite database size in bytes.
   *
   * @returns Database file size estimate.
   */
  async getDatabaseSizeBytes(): Promise<number> {
    const row = this.database.sqlite
      .query("SELECT page_count AS page_count, page_size AS page_size FROM pragma_page_count(), pragma_page_size()")
      .get() as { page_count: number; page_size: number } | null

    if (!row) {
      return 0
    }

    return row.page_count * row.page_size
  }

  /**
   * Returns deletion log entries from the last N days.
   *
   * @param days - Lookback window in days.
   * @returns Matching deletion entries.
   */
  async getDeletionLog(days: number): Promise<DeletionLogEntry[]> {
    const cutoff = this.now() - Math.max(1, days) * 86_400_000
    const rows = this.database.db
      .select()
      .from(deletionLog)
      .where(and(eq(deletionLog.projectId, this.scope.projectId), gte(deletionLog.timestamp, cutoff)))
      .orderBy(desc(deletionLog.timestamp))
      .all()

    return rows.map(mapDeletionLogEntry)
  }

  /**
   * Deletes data older than the configured retention windows.
   *
   * @param retentionDays - Number of days to keep observations and prompts.
   * @returns A promise that resolves after cleanup.
   */
  async cleanupOldData(retentionDays: number): Promise<void> {
    const now = this.now()
    const retentionCutoff = now - retentionDays * 86_400_000
    const pendingCutoff = now - 7 * 86_400_000
    const summaryCutoff = now - retentionDays * 2 * 86_400_000

    const observationRows = this.database.db
      .select({ id: observations.id })
      .from(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), lte(observations.createdAt, retentionCutoff)))
      .all()
    const observationDeleteCount = observationRows.length

    await this.deleteObservations(observationRows.map((row) => row.id))

    if (observationDeleteCount > 0) {
      await this.logDeletion(
        JSON.stringify({ type: "retention", target: "observations", before: retentionCutoff }),
        observationDeleteCount,
        "retention_cleanup",
      )
    }

    this.database.db
      .delete(userPrompts)
      .where(and(eq(userPrompts.projectId, this.scope.projectId), lte(userPrompts.createdAt, retentionCutoff)))
      .run()

    this.database.db
      .delete(sessionSummaries)
      .where(
        and(
          eq(sessionSummaries.projectId, this.scope.projectId),
          lte(sessionSummaries.createdAt, summaryCutoff),
        ),
      )
      .run()

    this.database.db
      .delete(pendingMessages)
      .where(
        and(
          eq(pendingMessages.projectId, this.scope.projectId),
          inArray(pendingMessages.status, ["processed", "failed"]),
          lte(pendingMessages.createdAt, pendingCutoff),
        ),
      )
      .run()

    this.database.sqlite.exec("VACUUM")
  }

  /**
   * Creates a new project-scoped record identifier.
   *
   * @returns A sortable identifier.
   */
  createId(): string {
    return createSortableId(this.now)
  }

  /**
   * Returns the last activity timestamp for a table and session.
   *
   * @param sqlite - SQLite client.
   * @param tableName - Table to inspect.
   * @param sessionId - OpenCode session identifier.
   * @param projectId - Current project identifier.
   * @returns The last timestamp or zero.
   */
  private getLastTimestamp(
    sqlite: Database,
    tableName: "observations" | "user_prompts",
    sessionId: string,
    projectId: string,
  ): number {
    const row = sqlite
      .query(`SELECT MAX(created_at) AS value FROM ${tableName} WHERE project_id = ? AND session_id = ?`)
      .get(projectId, sessionId) as MaxRow | null

    return row?.value ?? 0
  }
}

/**
 * Maps an observation row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized observation.
 */
export function mapObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    sessionId: row.sessionId,
    type: row.type as ObservationType,
    title: row.title,
    subtitle: row.subtitle ?? null,
    narrative: row.narrative,
    facts: parseJsonValue<string[]>(row.facts, []),
    concepts: parseJsonValue<string[]>(row.concepts, []),
    filesInvolved: parseJsonValue<string[]>(row.filesInvolved, []),
    rawTokenCount: row.rawTokenCount,
    compressedTokenCount: row.compressedTokenCount,
    toolName: row.toolName ?? null,
    modelUsed: row.modelUsed ?? null,
    quality: (row.quality as Observation["quality"]) ?? "high",
    rawFallback: row.rawFallback ?? null,
    createdAt: row.createdAt,
  }
}

/**
 * Maps a pending queue row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized pending message.
 */
export function mapPendingMessage(row: PendingMessageRow): PendingMessage {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    sessionId: row.sessionId,
    toolName: row.toolName,
    title: row.title ?? null,
    rawContent: row.rawContent,
    rawMetadata: parseJsonValue<Record<string, unknown> | null>(row.rawMetadata, null),
    status: row.status as PendingStatus,
    retryCount: row.retryCount,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    processedAt: row.processedAt ?? null,
  }
}

/**
 * Maps a summary row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized session summary.
 */
export function mapSessionSummary(row: SessionSummaryRow): SessionSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    sessionId: row.sessionId,
    requested: row.requested ?? null,
    investigated: row.investigated ?? null,
    learned: row.learned ?? null,
    completed: row.completed ?? null,
    nextSteps: row.nextSteps ?? null,
    observationCount: row.observationCount,
    modelUsed: row.modelUsed ?? null,
    createdAt: row.createdAt,
  }
}

/**
 * Maps a prompt row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized user prompt.
 */
export function mapUserPrompt(row: UserPromptRow): UserPromptRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    sessionId: row.sessionId,
    messageId: row.messageId,
    content: row.content,
    createdAt: row.createdAt,
  }
}

/**
 * Maps a deletion log row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized deletion log entry.
 */
export function mapDeletionLogEntry(row: DeletionLogRow): DeletionLogEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    timestamp: row.timestamp,
    criteria: row.criteria,
    count: row.count,
    initiator: row.initiator as DeletionInitiator,
  }
}

/**
 * Maps a tool usage stats row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized tool usage stats entry.
 */
export function mapToolUsageStat(row: ToolUsageStatRow): ToolUsageStat {
  return {
    id: row.id,
    projectId: row.projectId,
    projectRoot: row.projectRoot,
    sessionId: row.sessionId,
    toolName: row.toolName,
    callCount: row.callCount,
    createdAt: row.createdAt,
  }
}

/**
 * Maps an embedding row into the runtime shape.
 *
 * @param row - Database row.
 * @returns Normalized observation embedding.
 */
export function mapObservationEmbedding(row: ObservationEmbeddingRow): ObservationEmbedding {
  return {
    observationId: row.observationId,
    projectId: row.projectId,
    embeddingModel: row.embeddingModel,
    embeddingDimensions: row.embeddingDimensions,
    embeddingInput: row.embeddingInput,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Normalizes BM25 ranks into a descending 0..1 style score.
 *
 * @param rank - Raw BM25 rank.
 * @param index - Positional fallback index.
 * @returns Normalized lexical score.
 */
export function normalizeRank(rank: number | null, index: number): number {
  const safeRank = typeof rank === "number" && Number.isFinite(rank) ? Math.abs(rank) : index + 1
  return 1 / (1 + safeRank)
}

/**
 * Converts cosine distance into a descending similarity score.
 *
 * @param distance - sqlite-vec cosine distance.
 * @returns Normalized semantic score.
 */
export function normalizeDistance(distance: number): number {
  if (!Number.isFinite(distance)) {
    return 0
  }

  return Math.max(0, 1 - distance)
}

/**
 * Computes cosine similarity between two numeric vectors.
 *
 * @param left - Left-hand vector.
 * @param right - Right-hand vector.
 * @returns Similarity score in the 0..1 range when possible.
 */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0
  }

  let dotProduct = 0
  let leftNorm = 0
  let rightNorm = 0

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dotProduct += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0
  }

  const similarity = dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
  return Math.max(0, Math.min(1, similarity))
}
