import { describe, expect, test } from "bun:test"
import type { EmbeddingProvider, ObservationCompressor, PendingMessage, PluginConfig, RuntimeState } from "../src/types"
import { CompressionPipeline } from "../src/compression/pipeline"
import { createMemoryDatabase } from "../src/storage/db"
import { MemoryStore } from "../src/storage/store"
import { MemoryLogger } from "../src/logger"

const BASE_NOW = 1_000_000

function createPending(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    toolName: "bash",
    title: "Tool output",
    rawContent: "Updated src/index.ts and fixed JWT authentication flow",
    rawMetadata: null,
    status: "pending",
    retryCount: 0,
    errorMessage: null,
    createdAt: BASE_NOW,
    processedAt: null,
    ...overrides,
  }
}

function createPluginConfig(): PluginConfig {
  return {
    dbPath: ":memory:",
    indexSize: 50,
    sampleSize: 5,
    maxPendingRetries: 3,
    compressionModel: null,
    maxRawContentSize: 50_000,
    enableSemanticSearch: false,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDimensions: 4,
    semanticSearchMaxResults: 8,
    semanticContextMaxResults: 3,
    semanticMinScore: 0.55,
    hybridSearchAlpha: 0.65,
    privacyStrip: true,
    minContentLength: 100,
    compressionBatchSize: 10,
    retentionDays: 90,
    contextMaxTokens: 2_000,
    summaryLookback: 3,
    orphanThresholdMs: 5 * 60_000,
    queuePollIntervalMs: 10,
    sessionSummaryDebounceMs: 50,
    logLevel: "error",
    configPaths: [],
  }
}

function createMockClient(): any {
  return {
    config: {
      get: async () => ({ data: {} }),
    },
    app: {
      log: async () => ({ data: {} }),
    },
  }
}

function createNoopState(): RuntimeState {
  return {
    internalSessionIds: new Set(),
    injectedSessionIds: new Set(),
    knownSessionIds: new Set(),
    summaryTimers: new Map(),
    shutdownRegistered: false,
    disposed: false,
  }
}

function createPipeline(
  store: MemoryStore,
  compressor: ObservationCompressor,
  embeddingProvider: EmbeddingProvider | null,
  now: () => number,
): CompressionPipeline {
  const logger = new MemoryLogger(createMockClient(), "/tmp/project", "error")
  return new CompressionPipeline(
    store,
    compressor,
      createMockClient(),
      "/tmp/project",
      createPluginConfig(),
      embeddingProvider,
      logger,
      now,
    )
}

describe("compression pipeline", () => {
  test("shouldProcessQueueAndPersistObservation", async () => {
    const now = () => BASE_NOW
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, {
      projectId: "project_1",
      projectRoot: "/tmp/project",
      directory: "/tmp/project",
    }, now)

    const compressor: ObservationCompressor = {
      compressObservation: async () => ({
        text: JSON.stringify({
          title: "JWT auth fix",
          subtitle: "Updated middleware",
          narrative: "Updated src/index.ts for authentication.",
          facts: ["Updated authentication middleware"],
          concepts: ["authentication", "jwt"],
          filesInvolved: ["src/index.ts"],
          type: "tool_output",
        }),
        modelUsed: "anthropic/claude-haiku-4-5",
      }),
      summarizeSession: async () => ({
        text: JSON.stringify({
          requested: "Requested",
          investigated: "Investigated",
          learned: "Learned",
          completed: "Completed",
          nextSteps: "Next",
        }),
        modelUsed: null,
      }),
    }

    const pipeline = createPipeline(store, compressor, null, now)
    await store.enqueuePending(createPending({ id: "pending_1" }))

    await pipeline.processQueue()

    const observation = await store.getObservation("pending_1")
    expect(observation).not.toBeNull()
    expect(observation?.title).toBe("JWT auth fix")
    expect(observation?.quality).toBe("high")

    const pending = await store.getPendingMessages(["processed"], 10)
    expect(pending.some((item) => item.id === "pending_1")).toBe(true)
  })

  test("shouldRetryAndEventuallyFailWhenCompressorThrows", async () => {
    let nowValue = BASE_NOW
    const now = () => nowValue
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, {
      projectId: "project_1",
      projectRoot: "/tmp/project",
      directory: "/tmp/project",
    }, now)

    const compressor: ObservationCompressor = {
      compressObservation: async () => {
        throw new Error("compression failed")
      },
      summarizeSession: async () => ({ text: "{}", modelUsed: null }),
    }

    const pipeline = createPipeline(store, compressor, null, now)
    await store.enqueuePending(createPending({ id: "pending_fail", retryCount: 2 }))

    await pipeline.processSingle(createPending({ id: "pending_fail", retryCount: 2 }))

    const failed = await store.getPendingMessages(["failed"], 10)
    expect(failed.some((item) => item.id === "pending_fail")).toBe(true)

    nowValue += 10
  })

  test("shouldRecoverOrphanedMessages", async () => {
    const now = () => BASE_NOW
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, {
      projectId: "project_1",
      projectRoot: "/tmp/project",
      directory: "/tmp/project",
    }, now)

    await store.enqueuePending(createPending({
      id: "pending_orphan",
      status: "processing",
      createdAt: BASE_NOW - 10 * 60_000,
    }))

    const compressor: ObservationCompressor = {
      compressObservation: async () => ({ text: "{}", modelUsed: null }),
      summarizeSession: async () => ({ text: "{}", modelUsed: null }),
    }

    const pipeline = createPipeline(store, compressor, null, now)
    await pipeline.recoverOrphans()

    const pending = await store.getPendingMessages(["pending"], 10)
    expect(pending.some((item) => item.id === "pending_orphan")).toBe(true)
  })

  test("shouldStoreRawFallbackForLowQualityObservations", async () => {
    const now = () => BASE_NOW
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, {
      projectId: "project_1",
      projectRoot: "/tmp/project",
      directory: "/tmp/project",
    }, now)

    const compressor: ObservationCompressor = {
      compressObservation: async () => ({
        text: JSON.stringify({
          title: "Low quality output",
          subtitle: "Incomplete",
          narrative: "Narrative unrelated to raw",
          facts: ["Unrelated payment gateway change"],
          concepts: ["blockchain"],
          filesInvolved: ["src/not-present.ts"],
          type: "tool_output",
        }),
        modelUsed: "local/model",
      }),
      summarizeSession: async () => ({ text: "{}", modelUsed: null }),
    }

    const pipeline = createPipeline(store, compressor, null, now)
    const pending = createPending({
      id: "pending_low",
      rawContent: "Updated src/index.ts and fixed authentication token validation.",
    })
    await store.enqueuePending(pending)
    await pipeline.processQueue()

    const observation = await store.getObservation("pending_low")
    expect(observation?.quality).toBe("low")
    expect(observation?.rawFallback).not.toBeNull()
  })

  test("shouldPersistEmbeddingsWithoutBlockingObservationPersistence", async () => {
    const now = () => BASE_NOW
    const config = {
      ...createPluginConfig(),
      enableSemanticSearch: true,
    }
    const database = await createMemoryDatabase(config)
    const store = new MemoryStore(database, {
      projectId: "project_1",
      projectRoot: "/tmp/project",
      directory: "/tmp/project",
    }, now)

    const compressor: ObservationCompressor = {
      compressObservation: async () => ({
        text: JSON.stringify({
          title: "JWT auth fix",
          subtitle: "Updated middleware",
          narrative: "Updated src/index.ts for authentication.",
          facts: ["Updated authentication middleware"],
          concepts: ["authentication", "jwt"],
          filesInvolved: ["src/index.ts"],
          type: "tool_output",
        }),
        modelUsed: "anthropic/claude-haiku-4-5",
      }),
      summarizeSession: async () => ({ text: "{}", modelUsed: null }),
    }
    const embeddingProvider: EmbeddingProvider = {
      getModel: () => "test-embedding-model",
      getDimensions: () => 4,
      embed: async () => [0.1, 0.2, 0.3, 0.4],
    }
    const logger = new MemoryLogger(createMockClient(), "/tmp/project", "error")
    const pipeline = new CompressionPipeline(
      store,
      compressor,
      createMockClient(),
      "/tmp/project",
      config,
      embeddingProvider,
      logger,
      now,
    )

    await store.enqueuePending(createPending({ id: "pending_embed" }))
    await pipeline.processQueue()

    const observation = await store.getObservation("pending_embed")
    const embeddingStats = await store.getEmbeddingStats()

    expect(observation).not.toBeNull()
    expect(embeddingStats.totalEmbeddings).toBe(1)
  })

  void createNoopState()
})
