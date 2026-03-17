import { and, desc, eq, inArray, lte, sql } from "drizzle-orm"
import type { Database } from "bun:sqlite"
import { observations, pendingMessages, sessionSummaries, userPrompts, type ObservationRow, type PendingMessageRow, type SessionSummaryRow, type UserPromptRow } from "./schema"
import type { MemoryDatabase } from "./db"
import type { MemorySearchResult, Observation, ObservationType, PendingMessage, PendingStatus, ProjectScope, SessionSummary, TimelinePage, TimelineQuery, UserPromptRecord } from "../types"
import { createSortableId, parseJsonValue, sanitizeFtsQuery, serializeJson } from "../utils"

type MaxRow = { value: number | null }

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
        o.tool_name
      FROM observations_fts f
      JOIN observations o ON o.rowid = f.rowid
      WHERE observations_fts MATCH ?
        AND o.project_id = ?
        ${typeFilter ? "AND o.type = ?" : ""}
      ORDER BY bm25(observations_fts), o.created_at DESC
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
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      type: row.type,
      createdAt: row.created_at,
      toolName: row.tool_name,
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

    this.database.db
      .delete(observations)
      .where(and(eq(observations.projectId, this.scope.projectId), lte(observations.createdAt, retentionCutoff)))
      .run()

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
