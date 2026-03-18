import { describe, expect, test } from "bun:test"
import { createMemoryDatabase } from "../src/storage/db"
import { MemoryStore } from "../src/storage/store"
import type { Observation, PendingMessage, ProjectScope, SessionSummary, UserPromptRecord } from "../src/types"

function createStore(now = () => Date.now()): Promise<MemoryStore> {
  const scope: ProjectScope = {
    projectId: "project_1",
    projectRoot: "/tmp/project",
    directory: "/tmp/project",
  }

  return createMemoryDatabase(":memory:").then((database) => new MemoryStore(database, scope, now))
}

function createObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    type: "tool_output",
    title: "Observation title",
    subtitle: "Observation subtitle",
    narrative: "Observation narrative",
    facts: ["Fact one"],
    concepts: ["concept"],
    filesInvolved: ["src/index.ts"],
    rawTokenCount: 100,
    compressedTokenCount: 20,
    toolName: "bash",
    modelUsed: "anthropic/claude-haiku-4-5",
    quality: "high",
    rawFallback: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

function createPending(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    toolName: "bash",
    title: "Bash output",
    rawContent: "Command output",
    rawMetadata: null,
    status: "pending",
    retryCount: 0,
    errorMessage: null,
    createdAt: Date.now(),
    processedAt: null,
    ...overrides,
  }
}

function createSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    requested: "Requested",
    investigated: "Investigated",
    learned: "Learned",
    completed: "Completed",
    nextSteps: "Next",
    observationCount: 1,
    modelUsed: "anthropic/claude-haiku-4-5",
    createdAt: Date.now(),
    ...overrides,
  }
}

function createPrompt(overrides: Partial<UserPromptRecord> = {}): UserPromptRecord {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    messageId: crypto.randomUUID(),
    content: "Please implement feature X",
    createdAt: Date.now(),
    ...overrides,
  }
}

describe("memory store", () => {
  test("shouldSaveAndRetrieveObservationWithQualityFields", async () => {
    const store = await createStore()
    const observation = createObservation({
      id: "obs_1",
      quality: "low",
      rawFallback: "raw fallback",
    })

    await store.saveObservation(observation)
    const loaded = await store.getObservation("obs_1")

    expect(loaded?.quality).toBe("low")
    expect(loaded?.rawFallback).toBe("raw fallback")
  })

  test("shouldSearchFTSAndReturnQuality", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({
      id: "obs_fts",
      title: "JWT auth fix",
      narrative: "Updated JWT authentication middleware.",
      concepts: ["jwt", "auth"],
      quality: "medium",
    }))

    const results = await store.searchFTS("jwt auth", 10)
    expect(results.length).toBe(1)
    expect(results[0]?.quality).toBe("medium")
  })

  test("shouldDeleteObservationsByIds", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({ id: "obs_del_1" }))
    await store.saveObservation(createObservation({ id: "obs_del_2" }))

    const deleted = await store.deleteObservations(["obs_del_1", "obs_del_2"])
    const count = await store.countObservations()

    expect(deleted).toBe(2)
    expect(count).toBe(0)
  })

  test("shouldDeleteObservationsByQuery", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({
      id: "obs_query_1",
      title: "JWT token issue",
      narrative: "Fix JWT token handling",
    }))
    await store.saveObservation(createObservation({
      id: "obs_query_2",
      title: "Database migration",
      narrative: "Run migration",
    }))

    const deleted = await store.deleteByQuery("jwt")
    const remaining = await store.countObservations()

    expect(deleted).toBe(1)
    expect(remaining).toBe(1)
  })

  test("shouldDeleteBySessionAndSummary", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({ id: "obs_sess_1", sessionId: "session_x" }))
    await store.saveObservation(createObservation({ id: "obs_sess_2", sessionId: "session_x" }))
    await store.saveSessionSummary(createSummary({ id: "sum_x", sessionId: "session_x" }))

    const deleted = await store.deleteBySession("session_x")
    const summary = await store.getSessionSummary("session_x")

    expect(deleted).toBe(2)
    expect(summary).toBeNull()
  })

  test("shouldDeleteBeforeDate", async () => {
    const now = 1_000_000
    const store = await createStore(() => now)
    await store.saveObservation(createObservation({ id: "obs_old", createdAt: now - 10_000 }))
    await store.saveObservation(createObservation({ id: "obs_new", createdAt: now + 10_000 }))

    const deleted = await store.deleteBefore(new Date(now))
    const count = await store.countObservations()

    expect(deleted).toBe(1)
    expect(count).toBe(1)
  })

  test("shouldLogDeletionEntries", async () => {
    const now = 1_000_000
    const store = await createStore(() => now)

    await store.logDeletion(JSON.stringify({ query: "jwt" }), 3, "user")
    const logs = await store.getDeletionLog(30)

    expect(logs.length).toBe(1)
    expect(logs[0]?.count).toBe(3)
    expect(logs[0]?.initiator).toBe("user")
  })

  test("shouldTrackToolUsageStats", async () => {
    const now = 1_000_000
    const store = await createStore(() => now)

    await store.incrementToolUsage("session_1", "memory_search")
    await store.incrementToolUsage("session_1", "memory_search")
    await store.incrementToolUsage("session_1", "memory_get")

    const stats = await store.getToolUsageStats(7)
    const search = stats.find((row) => row.toolName === "memory_search")
    const get = stats.find((row) => row.toolName === "memory_get")

    expect(search?.callCount).toBe(2)
    expect(get?.callCount).toBe(1)
  })

  test("shouldComputeQualityDistribution", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({ id: "obs_q1", quality: "high" }))
    await store.saveObservation(createObservation({ id: "obs_q2", quality: "medium" }))
    await store.saveObservation(createObservation({ id: "obs_q3", quality: "low" }))

    const distribution = await store.getQualityDistribution()
    expect(distribution.high).toBe(1)
    expect(distribution.medium).toBe(1)
    expect(distribution.low).toBe(1)
  })

  test("shouldComputeModelSuccessRate", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({ id: "obs_m1", modelUsed: "model_a", quality: "high" }))
    await store.saveObservation(createObservation({ id: "obs_m2", modelUsed: "model_a", quality: "medium" }))
    await store.saveObservation(createObservation({ id: "obs_m3", modelUsed: "model_a", quality: "low" }))

    const rate = await store.getModelSuccessRate("model_a")
    expect(rate.total).toBe(3)
    expect(rate.success).toBe(2)
    expect(rate.rate).toBeCloseTo(2 / 3)
  })

  test("shouldSearchByDateRange", async () => {
    const now = 1_000_000
    const store = await createStore(() => now)
    await store.saveObservation(createObservation({ id: "obs_d1", createdAt: now - 1_000 }))
    await store.saveObservation(createObservation({ id: "obs_d2", createdAt: now + 1_000 }))

    const rows = await store.searchByDateRange(new Date(now - 2_000), new Date(now), 10)
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe("obs_d1")
  })

  test("shouldSearchByFiles", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({ id: "obs_f1", filesInvolved: ["src/a.ts"] }))
    await store.saveObservation(createObservation({ id: "obs_f2", filesInvolved: ["src/b.ts"] }))

    const rows = await store.searchByFiles(["src/a.ts"])
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe("obs_f1")
  })

  test("shouldHandlePendingStatusCounts", async () => {
    const store = await createStore()
    await store.enqueuePending(createPending({ id: "p1", status: "pending" }))
    await store.enqueuePending(createPending({ id: "p2", status: "failed" }))

    const counts = await store.getPendingStatusCounts()
    expect(counts.pending).toBe(1)
    expect(counts.failed).toBe(1)
  })

  test("shouldComputeCompressionStats", async () => {
    const store = await createStore()
    await store.saveObservation(createObservation({
      id: "obs_c1",
      rawTokenCount: 100,
      compressedTokenCount: 20,
      createdAt: 100,
    }))

    const stats = await store.getCompressionStats()
    expect(stats.averageRatio).toBeCloseTo(5)
    expect(stats.lastCompressedAt).toBe(100)
  })

  test("shouldComputeDatabaseSize", async () => {
    const store = await createStore()
    const size = await store.getDatabaseSizeBytes()
    expect(size).toBeGreaterThan(0)
  })

  test("shouldComputeDeletionStats", async () => {
    const now = 1_000_000
    const store = await createStore(() => now)
    await store.logDeletion(JSON.stringify({ ids: ["a"] }), 2, "user")
    await store.logDeletion(JSON.stringify({ ids: ["b"] }), 4, "retention_cleanup")

    const stats = await store.getDeletionStats(30)
    expect(stats.operations).toBe(2)
    expect(stats.removed).toBe(6)
  })

  test("shouldPersistAndReadSummariesAndPrompts", async () => {
    const store = await createStore()
    await store.saveSessionSummary(createSummary({ sessionId: "session_z" }))
    await store.saveUserPrompt(createPrompt({ sessionId: "session_z", messageId: "msg_z" }))

    const summary = await store.getSessionSummary("session_z")
    const prompts = await store.getSessionUserPrompts("session_z")

    expect(summary?.sessionId).toBe("session_z")
    expect(prompts.length).toBe(1)
  })

  test("shouldCleanupOldDataAndLogDeletion", async () => {
    const now = 1_000_000_000
    const store = await createStore(() => now)

    await store.saveObservation(createObservation({
      id: "obs_cleanup_old",
      createdAt: now - 100 * 86_400_000,
    }))
    await store.saveObservation(createObservation({
      id: "obs_cleanup_new",
      createdAt: now,
    }))

    await store.cleanupOldData(90)

    const count = await store.countObservations()
    const logs = await store.getDeletionLog(30)

    expect(count).toBe(1)
    expect(logs.length).toBeGreaterThan(0)
  })
})
