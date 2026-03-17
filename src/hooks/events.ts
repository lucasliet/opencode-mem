import type { Hooks } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { CompressionPipeline } from "../compression/pipeline"
import type { MemoryLogger } from "../logger"
import type { PluginConfig, RuntimeState } from "../types"

/**
 * Creates the event hook that manages session lifecycle and queue recovery.
 *
 * @param pipeline - Compression pipeline.
 * @param config - Plugin configuration.
 * @param state - Runtime state.
 * @param logger - Structured logger.
 * @returns Hook implementation.
 */
export function createEventHook(
  pipeline: CompressionPipeline,
  config: PluginConfig,
  state: RuntimeState,
  logger: MemoryLogger,
): NonNullable<Hooks["event"]> {
  return async ({ event }) => {
    if (isInternalEvent(event, state)) {
      return
    }

    switch (event.type) {
      case "session.created": {
        state.knownSessionIds.add(event.properties.info.id)
        break
      }

      case "session.idle": {
        scheduleSummary(event.properties.sessionID, pipeline, config, state, logger)
        break
      }

      case "session.deleted": {
        clearSummaryTimer(event.properties.info.id, state)
        state.injectedSessionIds.delete(event.properties.info.id)
        state.knownSessionIds.delete(event.properties.info.id)
        break
      }

      case "session.compacted": {
        scheduleSummary(event.properties.sessionID, pipeline, config, state, logger)
        break
      }

      default:
        break
    }
  }
}

/**
 * Registers a graceful shutdown handler once for the plugin process.
 *
 * @param pipeline - Compression pipeline.
 * @param state - Runtime state.
 * @param logger - Structured logger.
 * @returns Nothing.
 */
export function registerShutdown(
  pipeline: CompressionPipeline,
  state: RuntimeState,
  logger: MemoryLogger,
): void {
  if (state.shutdownRegistered) {
    return
  }

  state.shutdownRegistered = true

  const shutdown = async () => {
    if (state.disposed) {
      return
    }
    state.disposed = true

    try {
      await pipeline.processQueue()
      await logger.info("Memory plugin shutdown complete")
    } catch (error) {
      await logger.error("Memory plugin shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  process.on("SIGTERM", () => void shutdown())
  process.on("SIGINT", () => void shutdown())
  process.on("beforeExit", () => void shutdown())
}

/**
 * Schedules summary generation after a debounce interval.
 *
 * @param sessionId - OpenCode session identifier.
 * @param pipeline - Compression pipeline.
 * @param config - Plugin configuration.
 * @param state - Runtime state.
 * @param logger - Structured logger.
 * @returns Nothing.
 */
export function scheduleSummary(
  sessionId: string,
  pipeline: CompressionPipeline,
  config: PluginConfig,
  state: RuntimeState,
  logger: MemoryLogger,
): void {
  clearSummaryTimer(sessionId, state)

  const timer = setTimeout(() => {
    void (async () => {
      try {
        await pipeline.flushSession(sessionId, 30_000)
        await pipeline.generateSessionSummary(sessionId)
      } catch (error) {
        await logger.warn("Failed to generate session summary", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        clearSummaryTimer(sessionId, state)
      }
    })()
  }, config.sessionSummaryDebounceMs)

  state.summaryTimers.set(sessionId, timer)
}

/**
 * Clears a scheduled summary timer.
 *
 * @param sessionId - OpenCode session identifier.
 * @param state - Runtime state.
 * @returns Nothing.
 */
export function clearSummaryTimer(sessionId: string, state: RuntimeState): void {
  const timer = state.summaryTimers.get(sessionId)
  if (!timer) {
    return
  }

  clearTimeout(timer)
  state.summaryTimers.delete(sessionId)
}

/**
 * Checks whether an event belongs to an internal compressor session.
 *
 * @param event - OpenCode event.
 * @param state - Runtime state.
 * @returns True when the event should be ignored.
 */
export function isInternalEvent(event: Event, state: RuntimeState): boolean {
  switch (event.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return state.internalSessionIds.has(event.properties.info.id)
    case "session.idle":
    case "session.compacted":
    case "session.status":
      return state.internalSessionIds.has(event.properties.sessionID)
    default:
      return false
  }
}
