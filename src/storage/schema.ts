import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const observations = sqliteTable(
  "observations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectRoot: text("project_root").notNull(),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    narrative: text("narrative").notNull(),
    facts: text("facts").notNull().default("[]"),
    concepts: text("concepts").notNull().default("[]"),
    filesInvolved: text("files_involved").notNull().default("[]"),
    rawTokenCount: integer("raw_token_count").notNull().default(0),
    compressedTokenCount: integer("compressed_token_count").notNull().default(0),
    toolName: text("tool_name"),
    modelUsed: text("model_used"),
    quality: text("quality").notNull().default("high"),
    rawFallback: text("raw_fallback"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("observations_project_created_idx").on(table.projectId, table.createdAt),
    index("observations_session_idx").on(table.sessionId),
    index("observations_type_idx").on(table.type),
    index("observations_quality_idx").on(table.quality),
  ],
)

export const sessionSummaries = sqliteTable(
  "session_summaries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectRoot: text("project_root").notNull(),
    sessionId: text("session_id").notNull(),
    requested: text("requested"),
    investigated: text("investigated"),
    learned: text("learned"),
    completed: text("completed"),
    nextSteps: text("next_steps"),
    observationCount: integer("observation_count").notNull().default(0),
    modelUsed: text("model_used"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_summaries_session_unique_idx").on(table.projectId, table.sessionId),
    index("session_summaries_created_idx").on(table.projectId, table.createdAt),
  ],
)

export const observationEmbeddings = sqliteTable(
  "observation_embeddings",
  {
    observationId: text("observation_id").primaryKey(),
    projectId: text("project_id").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    embeddingDimensions: integer("embedding_dimensions").notNull(),
    embeddingInput: text("embedding_input").notNull(),
    embeddingVector: text("embedding_vector").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("observation_embeddings_project_created_idx").on(table.projectId, table.createdAt),
    index("observation_embeddings_model_idx").on(table.embeddingModel),
  ],
)

export const pendingMessages = sqliteTable(
  "pending_messages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectRoot: text("project_root").notNull(),
    sessionId: text("session_id").notNull(),
    toolName: text("tool_name").notNull(),
    title: text("title"),
    rawContent: text("raw_content").notNull(),
    rawMetadata: text("raw_metadata"),
    status: text("status").notNull().default("pending"),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    processedAt: integer("processed_at"),
  },
  (table) => [
    index("pending_messages_status_created_idx").on(table.projectId, table.status, table.createdAt),
    index("pending_messages_session_idx").on(table.sessionId),
  ],
)

export const userPrompts = sqliteTable(
  "user_prompts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectRoot: text("project_root").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("user_prompts_message_unique_idx").on(table.messageId),
    index("user_prompts_session_idx").on(table.projectId, table.sessionId),
  ],
)

export const deletionLog = sqliteTable(
  "deletion_log",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectRoot: text("project_root").notNull(),
    timestamp: integer("timestamp").notNull(),
    criteria: text("criteria").notNull(),
    count: integer("count").notNull(),
    initiator: text("initiator").notNull(),
  },
  (table) => [index("deletion_log_timestamp_idx").on(table.projectId, table.timestamp)],
)

export const toolUsageStats = sqliteTable(
  "tool_usage_stats",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    projectRoot: text("project_root").notNull(),
    sessionId: text("session_id").notNull(),
    toolName: text("tool_name").notNull(),
    callCount: integer("call_count").notNull().default(1),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("tool_usage_stats_session_tool_idx").on(table.projectId, table.sessionId, table.toolName)],
)

export const personaMemory = sqliteTable(
  "persona_memory",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
)

export const schema = {
  deletionLog,
  observationEmbeddings,
  observations,
  pendingMessages,
  personaMemory,
  sessionSummaries,
  toolUsageStats,
  userPrompts,
}

export type ObservationRow = typeof observations.$inferSelect

export type PendingMessageRow = typeof pendingMessages.$inferSelect

export type ObservationEmbeddingRow = typeof observationEmbeddings.$inferSelect

export type SessionSummaryRow = typeof sessionSummaries.$inferSelect

export type DeletionLogRow = typeof deletionLog.$inferSelect

export type ToolUsageStatRow = typeof toolUsageStats.$inferSelect

export type UserPromptRow = typeof userPrompts.$inferSelect

export type PersonaMemoryRow = typeof personaMemory.$inferSelect
