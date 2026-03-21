import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { loadConfig } from "./config"
import { LanguageModelObservationCompressor, SessionPromptObservationCompressor } from "./compression/compressor"
import { PersonaExtractor } from "./compression/persona-extractor"
import { CompressionPipeline } from "./compression/pipeline"
import { createCompactionHook } from "./hooks/compaction"
import { createEventHook, registerShutdown } from "./hooks/events"
import { createChatMessageHook } from "./hooks/chat-message"
import { createSystemTransformHook } from "./hooks/system-transform"
import { createToolExecuteAfterHook } from "./hooks/tool-after"
import { LocalEmbeddingProvider } from "./embeddings/local-provider"
import { MemoryLogger } from "./logger"
import { createMemoryDatabase } from "./storage/db"
import { MemoryStore } from "./storage/store"
import { PersonaStore } from "./storage/persona"
import { createMemoryGetTool } from "./tools/memory-get"
import { createMemoryForgetTool } from "./tools/memory-forget"
import { createMemorySearchTool } from "./tools/memory-search"
import { createMemoryStatsTool } from "./tools/memory-stats"
import { createMemoryTimelineTool } from "./tools/memory-timeline"
import { createMemoryAddTool } from "./tools/memory-add"
import { createMemoryPersonaGetTool } from "./tools/memory-persona-get"
import { createMemoryPersonaUpdateTool } from "./tools/memory-persona-update"
import { createMemoryPersonaPatchTool } from "./tools/memory-persona-patch"
import { createMemoryPersonaClearTool } from "./tools/memory-persona-clear"
import type { MemoryPluginOptions, RuntimeState } from "./types"

/**
 * Creates the OpenCode persistent memory plugin.
 *
 * @param options - Optional advanced overrides for testing or custom models.
 * @returns A plugin function compatible with OpenCode.
 */
export function createMemoryPlugin(options: MemoryPluginOptions = {}): Plugin {
  return async (input: PluginInput) => {
    const now = options.now ?? Date.now
    const pluginConfig = await loadConfig({
      directory: input.directory,
      worktree: input.worktree,
    })
    const scope = {
      projectId: input.project.id,
      projectRoot: input.worktree,
      directory: input.directory,
    }
    const database = await createMemoryDatabase(pluginConfig)
    const store = new MemoryStore(database, scope, now)
    const personaStore = new PersonaStore(database, now)
    const logger = new MemoryLogger(input.client, input.directory, pluginConfig.logLevel)
    const state: RuntimeState = {
      internalSessionIds: new Set(),
      injectedSessionIds: new Set(),
      knownSessionIds: new Set(),
      summaryTimers: new Map(),
      personaLearnCount: 0,
      shutdownRegistered: false,
      disposed: false,
    }

    const compressor =
      options.compressor ??
      (options.languageModel
        ? new LanguageModelObservationCompressor(options.languageModel)
        : new SessionPromptObservationCompressor(input, state))

    const extractor = new PersonaExtractor(input, state)

    const embeddingProvider = options.embeddingProvider ?? (pluginConfig.enableSemanticSearch
      ? new LocalEmbeddingProvider(
        pluginConfig.embeddingModel,
        pluginConfig.embeddingDimensions,
      )
      : null)

    const pipeline = new CompressionPipeline(
      store,
      compressor,
      input.client,
      input.directory,
      pluginConfig,
      embeddingProvider,
      logger,
      now,
    )

    await pipeline.recoverOrphans()
    await store.cleanupOldData(pluginConfig.retentionDays)
    queueMicrotask(() => {
      void pipeline.processQueue()
    })

    registerShutdown(pipeline, state, logger)

    void logger.info("Persistent memory plugin initialized", {
      dbPath: pluginConfig.dbPath,
      compressionModel: pluginConfig.compressionModel,
      configPaths: pluginConfig.configPaths,
    })

    return {
      tool: {
        memory_search: createMemorySearchTool(store, pluginConfig, embeddingProvider, now),
        memory_timeline: createMemoryTimelineTool(store),
        memory_get: createMemoryGetTool(store),
        memory_add: createMemoryAddTool(store, scope, embeddingProvider, now),
        memory_forget: createMemoryForgetTool(store, now),
        memory_stats: createMemoryStatsTool(store, now),
        memory_persona_get: createMemoryPersonaGetTool(personaStore, now),
        memory_persona_update: createMemoryPersonaUpdateTool(personaStore),
        memory_persona_patch: createMemoryPersonaPatchTool(personaStore),
        memory_persona_clear: createMemoryPersonaClearTool(personaStore),
      },
      event: createEventHook(pipeline, pluginConfig, state, logger),
      "chat.message": createChatMessageHook(store, scope, personaStore, extractor, state, now, logger),
      "tool.execute.after": createToolExecuteAfterHook(
        store,
        pipeline,
        scope,
        pluginConfig,
        state,
        logger,
        now,
      ),
      "experimental.chat.system.transform": createSystemTransformHook(store, pluginConfig, embeddingProvider, personaStore, state, now),
      "experimental.session.compacting": createCompactionHook(store, state, now),
    }
  }
}

export const MemoryPlugin: Plugin = createMemoryPlugin()
