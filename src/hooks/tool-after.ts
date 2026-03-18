import type { Hooks } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import type { MemoryLogger } from "../logger"
import type { CompressionPipeline } from "../compression/pipeline"
import type { PluginConfig, ProjectScope, RuntimeState } from "../types"
import { isProbablyBinary, normalizeWhitespace } from "../utils"
import { stripSensitiveTokens } from "../compression/privacy"

const IGNORED_TOOL_PREFIXES = ["memory_"]
const IGNORED_TOOL_NAMES = new Set(["todowrite"])

/**
 * Creates the hook that captures tool outputs and enqueues them for compression.
 *
 * @param store - Memory store.
 * @param pipeline - Compression pipeline.
 * @param scope - Project scope.
 * @param config - Plugin configuration.
 * @param state - Runtime state.
 * @param logger - Structured logger.
 * @param now - Clock function.
 * @returns Hook implementation.
 */
export function createToolExecuteAfterHook(
  store: MemoryStore,
  pipeline: CompressionPipeline,
  scope: ProjectScope,
  config: PluginConfig,
  state: RuntimeState,
  logger: MemoryLogger,
  now: () => number,
): NonNullable<Hooks["tool.execute.after"]> {
  return async (input, output) => {
    if (state.internalSessionIds.has(input.sessionID)) {
      return
    }

    if (shouldIgnoreTool(input.tool)) {
      return
    }

    const rawOutput = output.output ?? ""
    if (!rawOutput || rawOutput.length < config.minContentLength) {
      return
    }

    if (isProbablyBinary(rawOutput)) {
      await logger.warn("Skipped binary-like tool output", {
        tool: input.tool,
        sessionId: input.sessionID,
      })
      return
    }

    const content = config.privacyStrip ? stripSensitiveTokens(rawOutput) : rawOutput
    const truncated = content.slice(0, config.maxRawContentSize)
    if (!normalizeWhitespace(truncated)) {
      return
    }

    try {
      await store.enqueuePending({
        id: store.createId(),
        projectId: scope.projectId,
        projectRoot: scope.projectRoot,
        sessionId: input.sessionID,
        toolName: input.tool,
        title: output.title || null,
        rawContent: truncated,
        rawMetadata: {
          callID: input.callID,
          args: input.args,
          metadata: output.metadata,
          title: output.title,
        },
        status: "pending",
        retryCount: 0,
        errorMessage: null,
        createdAt: now(),
        processedAt: null,
      })

      queueMicrotask(() => {
        void pipeline.processQueue()
      })
    } catch (error) {
      await logger.error("Failed to enqueue tool output", {
        tool: input.tool,
        sessionId: input.sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Checks whether a tool output should be skipped from persistent memory capture.
 *
 * @param toolName - Executed tool name.
 * @returns True when the tool is intentionally ignored.
 */
export function shouldIgnoreTool(toolName: string): boolean {
  if (IGNORED_TOOL_NAMES.has(toolName)) {
    return true
  }

  return IGNORED_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix))
}
