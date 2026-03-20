import type { Hooks } from "@opencode-ai/plugin"
import { generateSessionContext } from "../context/generator"
import { MemoryStore } from "../storage/store"
import type { EmbeddingProvider, PluginConfig, RuntimeState } from "../types"

/**
 * Creates the system prompt transform that injects memory context once per session.
 *
 * @param store - Memory store.
 * @param config - Plugin configuration.
 * @param embeddingProvider - Optional local embedding provider.
 * @param state - Runtime state.
 * @param now - Clock function.
 * @returns Hook implementation.
 */
export function createSystemTransformHook(
  store: MemoryStore,
  config: PluginConfig,
  embeddingProvider: EmbeddingProvider | null,
  state: RuntimeState,
  now: () => number,
): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (input, output) => {
    const sessionId = input.sessionID
    if (!sessionId || state.internalSessionIds.has(sessionId) || state.injectedSessionIds.has(sessionId)) {
      return
    }

    const context = await generateSessionContext(store, sessionId, config, embeddingProvider, now)
    if (!context) {
      return
    }

    output.system.unshift(context)
    state.injectedSessionIds.add(sessionId)
  }
}
