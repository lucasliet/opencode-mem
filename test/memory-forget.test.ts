import { describe, expect, test } from "bun:test"
import { createMemoryForgetTool } from "../src/tools/memory-forget"
import { createMemoryDatabase } from "../src/storage/db"
import { MemoryStore } from "../src/storage/store"
import type { Observation, PluginConfig, ProjectScope } from "../src/types"

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
    embeddingDimensions: 384,
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
    queuePollIntervalMs: 250,
    sessionSummaryDebounceMs: 1_500,
    logLevel: "error",
    configPaths: [],
  }
}

function createScope(): ProjectScope {
  return {
    projectId: "project_1",
    projectRoot: "/tmp/project",
    directory: "/tmp/project",
  }
}

function createObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    type: "tool_output",
    title: "JWT auth fix",
    subtitle: "Updated middleware",
    narrative: "Updated auth middleware and tests.",
    facts: ["Auth middleware updated"],
    concepts: ["jwt", "auth"],
    filesInvolved: ["src/index.ts"],
    rawTokenCount: 120,
    compressedTokenCount: 30,
    toolName: "bash",
    modelUsed: "anthropic/claude-haiku-4-5",
    quality: "high",
    rawFallback: null,
    createdAt: 1_000,
    ...overrides,
  }
}

function createToolContext(messageID: string): {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: { [key: string]: any }
  }): Promise<void>
} {
  return {
    sessionID: "session_1",
    messageID,
    agent: "default",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: AbortSignal.timeout(5_000),
    metadata() {},
    ask: async () => {},
  }
}

describe("memory_forget tool", () => {
  test("shouldRequireConfirmationTokenWhenConfirmingDeletion", async () => {
    let nowValue = 10_000
    const now = () => nowValue
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, createScope(), now)
    await store.saveObservation(createObservation({ id: "obs_1", createdAt: 9_000 }))

    const tool = createMemoryForgetTool(store, now)
    const response = await tool.execute(
      {
        query: "jwt",
        confirm: true,
      },
      createToolContext("msg_2"),
    )

    expect(response).toContain("confirmationToken")
    expect(await store.countObservations()).toBe(1)
  })

  test("shouldBlockDeletionOnSameTurnAsPreview", async () => {
    let nowValue = 10_000
    const now = () => nowValue
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, createScope(), now)
    await store.saveObservation(createObservation({ id: "obs_1", createdAt: 9_000 }))

    const tool = createMemoryForgetTool(store, now)
    const preview = await tool.execute(
      {
        query: "jwt",
      },
      createToolContext("msg_same"),
    )

    const token = extractToken(preview)
    expect(token).not.toBeNull()

    const confirm = await tool.execute(
      {
        query: "jwt",
        confirm: true,
        confirmationToken: token ?? undefined,
      },
      createToolContext("msg_same"),
    )

    expect(confirm).toContain("must happen in a new user turn")
    expect(await store.countObservations()).toBe(1)
  })

  test("shouldDeleteAfterPreviewWhenConfirmedOnLaterTurn", async () => {
    let nowValue = 10_000
    const now = () => nowValue
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, createScope(), now)
    await store.saveObservation(createObservation({ id: "obs_1", createdAt: 9_000 }))
    await store.saveObservation(createObservation({ id: "obs_2", title: "Database migration", concepts: ["sqlite"], createdAt: 8_000 }))

    const tool = createMemoryForgetTool(store, now)
    const preview = await tool.execute(
      {
        query: "jwt",
      },
      createToolContext("msg_preview"),
    )

    const token = extractToken(preview)
    expect(token).not.toBeNull()

    nowValue += 2_000

    const confirm = await tool.execute(
      {
        query: "jwt",
        confirm: true,
        confirmationToken: token ?? undefined,
      },
      createToolContext("msg_confirm"),
    )

    expect(confirm).toContain("Deleted 1 observations")
    expect(await store.countObservations()).toBe(1)
  })

  test("shouldBlockDeletionWhenCriteriaDoNotMatchPreview", async () => {
    let nowValue = 10_000
    const now = () => nowValue
    const database = await createMemoryDatabase(createPluginConfig())
    const store = new MemoryStore(database, createScope(), now)
    await store.saveObservation(createObservation({ id: "obs_1", createdAt: 9_000 }))

    const tool = createMemoryForgetTool(store, now)
    const preview = await tool.execute(
      {
        query: "jwt",
      },
      createToolContext("msg_preview"),
    )

    const token = extractToken(preview)
    expect(token).not.toBeNull()

    nowValue += 2_000

    const confirm = await tool.execute(
      {
        query: "different-query",
        confirm: true,
        confirmationToken: token ?? undefined,
      },
      createToolContext("msg_confirm"),
    )

    expect(confirm).toContain("criteria do not match")
    expect(await store.countObservations()).toBe(1)
  })
})

/**
 * Extracts a confirmation token from memory_forget preview output.
 *
 * @param output - Preview tool output.
 * @returns Token string or null.
 */
function extractToken(output: string): string | null {
  const match = output.match(/Confirmation token: ([a-z0-9]+)/i)
  return match?.[1] ?? null
}
