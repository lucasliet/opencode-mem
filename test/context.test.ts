import { describe, expect, test } from "bun:test"
import { generateSessionContext } from "../src/context/generator"
import { createMemoryDatabase } from "../src/storage/db"
import { MemoryStore } from "../src/storage/store"
import { PersonaStore } from "../src/storage/persona"
import type { EmbeddingProvider, Observation, PluginConfig, ProjectScope, UserPromptRecord } from "../src/types"

function createPluginConfig(): PluginConfig {
  return {
    dbPath: ":memory:",
    indexSize: 50,
    sampleSize: 2,
    maxPendingRetries: 3,
    compressionModel: null,
    maxRawContentSize: 50_000,
    enableSemanticSearch: true,
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    embeddingDimensions: 4,
    semanticSearchMaxResults: 8,
    semanticContextMaxResults: 2,
    semanticMinScore: 0.1,
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
    narrative: "Updated authentication middleware and tests.",
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

function createPrompt(overrides: Partial<UserPromptRecord> = {}): UserPromptRecord {
  return {
    id: crypto.randomUUID(),
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    messageId: crypto.randomUUID(),
    content: "How did we fix JWT auth before?",
    createdAt: 1_100,
    ...overrides,
  }
}

describe("context generator", () => {
  test("shouldIncludeSemanticObservationsWhenPromptAndEmbeddingsExist", async () => {
    const config = createPluginConfig()
    const database = await createMemoryDatabase(config)
    const store = new MemoryStore(database, createScope(), () => 2_000)
    const observation = createObservation({ id: "obs_semantic" })
    const embeddingProvider: EmbeddingProvider = {
      getModel: () => "test-embedding-model",
      getDimensions: () => 4,
      embed: async () => [0.1, 0.2, 0.3, 0.4],
    }

    await store.saveObservation(observation)
    await store.saveObservationEmbedding({
      observationId: observation.id,
      projectId: observation.projectId,
      embeddingModel: "test-embedding-model",
      embeddingDimensions: 4,
      embeddingInput: "jwt auth fix",
      createdAt: observation.createdAt,
      updatedAt: observation.createdAt,
    }, observation, [0.1, 0.2, 0.3, 0.4])
    await store.saveUserPrompt(createPrompt())
    const personaStore = new PersonaStore(database, () => 2_000)

    const context = await generateSessionContext(store, "session_1", config, embeddingProvider, personaStore, () => 2_000)

    expect(context).toContain("Semantically Relevant Observations")
    expect(context).toContain("obs_semantic")
  })

  test("shouldSkipSemanticBlockWhenPromptIsUnavailable", async () => {
    const config = createPluginConfig()
    const database = await createMemoryDatabase(config)
    const store = new MemoryStore(database, createScope(), () => 2_000)
    const observation = createObservation({ id: "obs_recent" })
    const embeddingProvider: EmbeddingProvider = {
      getModel: () => "test-embedding-model",
      getDimensions: () => 4,
      embed: async () => [0.1, 0.2, 0.3, 0.4],
    }

    await store.saveObservation(observation)
    const personaStore = new PersonaStore(database, () => 2_000)

    const context = await generateSessionContext(store, "session_1", config, embeddingProvider, personaStore, () => 2_000)

    expect(context).not.toContain("Semantically Relevant Observations")
    expect(context).toContain("Recent Observation Index")
  })
})
