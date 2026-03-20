import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LanguageModel } from "ai"

export const OBSERVATION_TYPES = ["tool_output", "file_change", "error", "decision"] as const

export const PENDING_STATUSES = ["pending", "processing", "processed", "failed"] as const

export const OBSERVATION_QUALITIES = ["high", "medium", "low"] as const

export type ObservationType = (typeof OBSERVATION_TYPES)[number]

export type PendingStatus = (typeof PENDING_STATUSES)[number]

export type ObservationQuality = (typeof OBSERVATION_QUALITIES)[number]

export type DeletionInitiator = "user" | "retention_cleanup"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface ProjectScope {
  projectId: string
  projectRoot: string
  directory: string
}

export interface PluginConfig {
  dbPath: string
  indexSize: number
  sampleSize: number
  maxPendingRetries: number
  compressionModel: string | null
  maxRawContentSize: number
  enableSemanticSearch: boolean
  embeddingModel: string
  embeddingDimensions: number
  semanticSearchMaxResults: number
  semanticContextMaxResults: number
  semanticMinScore: number
  hybridSearchAlpha: number
  privacyStrip: boolean
  minContentLength: number
  compressionBatchSize: number
  retentionDays: number
  contextMaxTokens: number
  summaryLookback: number
  orphanThresholdMs: number
  queuePollIntervalMs: number
  sessionSummaryDebounceMs: number
  logLevel: LogLevel
  configPaths: string[]
}

export interface ModelSelection {
  raw: string
  providerID: string
  modelID: string
}

export interface Observation {
  id: string
  projectId: string
  projectRoot: string
  sessionId: string
  type: ObservationType
  title: string
  subtitle: string | null
  narrative: string
  facts: string[]
  concepts: string[]
  filesInvolved: string[]
  rawTokenCount: number
  compressedTokenCount: number
  toolName: string | null
  modelUsed: string | null
  quality: ObservationQuality
  rawFallback: string | null
  createdAt: number
}

export interface QualityResult {
  quality: ObservationQuality
  flags: string[]
}

export interface PendingMessage {
  id: string
  projectId: string
  projectRoot: string
  sessionId: string
  toolName: string
  title: string | null
  rawContent: string
  rawMetadata: Record<string, unknown> | null
  status: PendingStatus
  retryCount: number
  errorMessage: string | null
  createdAt: number
  processedAt: number | null
}

export interface SessionSummary {
  id: string
  projectId: string
  projectRoot: string
  sessionId: string
  requested: string | null
  investigated: string | null
  learned: string | null
  completed: string | null
  nextSteps: string | null
  observationCount: number
  modelUsed: string | null
  createdAt: number
}

export interface UserPromptRecord {
  id: string
  projectId: string
  projectRoot: string
  sessionId: string
  messageId: string
  content: string
  createdAt: number
}

export interface DeletionLogEntry {
  id: string
  projectId: string
  projectRoot: string
  timestamp: number
  criteria: string
  count: number
  initiator: DeletionInitiator
}

export interface ToolUsageStat {
  id: string
  projectId: string
  projectRoot: string
  sessionId: string
  toolName: string
  callCount: number
  createdAt: number
}

export interface MemorySearchResult {
  id: string
  title: string
  subtitle: string | null
  type: ObservationType
  createdAt: number
  toolName: string | null
  quality: ObservationQuality
  source: "lexical" | "semantic" | "hybrid"
  score: number | null
}

export interface ObservationEmbedding {
  observationId: string
  projectId: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingInput: string
  createdAt: number
  updatedAt: number
}

export interface VectorBackendState {
  enabled: boolean
  available: boolean
  dimensions: number
  error: string | null
}

export interface EmbeddingSearchOptions {
  limit: number
  semanticLimit?: number
  typeFilter?: ObservationType
  semanticMinScore: number
  hybridSearchAlpha: number
}

export interface TimelineQuery {
  limit: number
  before?: number
  after?: number
  sessionId?: string
}

export interface TimelinePage {
  observations: Observation[]
  nextCursor: string | null
}

export interface CompressionResult {
  text: string
  modelUsed: string | null
}

export interface ObservationCompressor {
  compressObservation(input: {
    pendingMessage: PendingMessage
    prompt: string
    model: ModelSelection | null
    abortSignal?: AbortSignal
  }): Promise<CompressionResult>
  summarizeSession(input: {
    sessionId: string
    prompt: string
    model: ModelSelection | null
    abortSignal?: AbortSignal
  }): Promise<CompressionResult>
}

export interface MemoryPluginOptions {
  compressor?: ObservationCompressor
  languageModel?: LanguageModel
  embeddingProvider?: EmbeddingProvider
  now?: () => number
}

export interface EmbeddingProvider {
  embed(value: string): Promise<number[]>
  getModel(): string
  getDimensions(): number
}

export interface RuntimeState {
  internalSessionIds: Set<string>
  injectedSessionIds: Set<string>
  knownSessionIds: Set<string>
  summaryTimers: Map<string, ReturnType<typeof setTimeout>>
  shutdownRegistered: boolean
  disposed: boolean
}

export interface PluginBootstrapContext {
  client: OpencodeClient
  directory: string
  worktree: string
  projectId: string
  now: () => number
}
