import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, loadOpenCodeConfig } from "./config"
import { LanguageModelObservationCompressor, SessionPromptObservationCompressor } from "./compression/compressor"
import { CompressionPipeline } from "./compression/pipeline"
import { createCompactionHook } from "./hooks/compaction"
import { createEventHook, registerShutdown } from "./hooks/events"
import { createChatMessageHook } from "./hooks/chat-message"
import { createSystemTransformHook } from "./hooks/system-transform"
import { createToolExecuteAfterHook } from "./hooks/tool-after"
import { MemoryLogger } from "./logger"
import { createMemoryDatabase } from "./storage/db"
import { MemoryStore } from "./storage/store"
import { createMemoryGetTool } from "./tools/memory-get"
import { createMemorySearchTool } from "./tools/memory-search"
import { createMemoryTimelineTool } from "./tools/memory-timeline"
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
      client: input.client,
      directory: input.directory,
      worktree: input.worktree,
    })
    const runtimeConfig = await loadOpenCodeConfig(input.client, input.directory)
    const scope = {
      projectId: input.project.id,
      projectRoot: input.worktree,
      directory: input.directory,
    }
    const database = await createMemoryDatabase(pluginConfig.dbPath)
    const store = new MemoryStore(database, scope, now)
    const logger = new MemoryLogger(input.client, input.directory, pluginConfig.logLevel)
    const state: RuntimeState = {
      internalSessionIds: new Set(),
      injectedSessionIds: new Set(),
      knownSessionIds: new Set(),
      summaryTimers: new Map(),
      shutdownRegistered: false,
      disposed: false,
    }

    const compressor =
      options.compressor ??
      (options.languageModel
        ? new LanguageModelObservationCompressor(options.languageModel)
        : new SessionPromptObservationCompressor(input, state))

    const pipeline = new CompressionPipeline(
      store,
      compressor,
      input.client,
      input.directory,
      pluginConfig,
      logger,
      now,
    )

    await pipeline.recoverOrphans()
    await store.cleanupOldData(pluginConfig.retentionDays)
    queueMicrotask(() => {
      void pipeline.processQueue()
    })

    registerShutdown(pipeline, state, logger)

    await logger.info("Persistent memory plugin initialized", {
      dbPath: pluginConfig.dbPath,
      compressionModel: pluginConfig.compressionModel,
      runtimeModel: runtimeConfig.model,
      configPaths: pluginConfig.configPaths,
    })

    return {
      tool: {
        memory_search: createMemorySearchTool(store, now),
        memory_timeline: createMemoryTimelineTool(store),
        memory_get: createMemoryGetTool(store),
      },
      event: createEventHook(pipeline, pluginConfig, state, logger),
      "chat.message": createChatMessageHook(store, scope, state, now),
      "tool.execute.after": createToolExecuteAfterHook(
        store,
        pipeline,
        scope,
        pluginConfig,
        state,
        logger,
        now,
      ),
      "experimental.chat.system.transform": createSystemTransformHook(store, pluginConfig, state, now),
      "experimental.session.compacting": createCompactionHook(store, state, now),
    }
  }
}

export const MemoryPlugin: Plugin = createMemoryPlugin()
