import type { Hooks } from "@opencode-ai/plugin"
import { generateSessionContext } from "../context/generator"
import { MemoryStore } from "../storage/store"
import type { PersonaStore } from "../storage/persona"
import type { EmbeddingProvider, PluginConfig, RuntimeState } from "../types"

/**
 * Creates the system prompt transform that injects memory context once per session.
 *
 * @param store - Memory store.
 * @param config - Plugin configuration.
 * @param embeddingProvider - Optional local embedding provider.
 * @param personaStore - Persona storage.
 * @param state - Runtime state.
 * @param now - Clock function.
 * @param allProjectIds - Project ID list for worktree multi-project queries.
 * @returns Hook implementation.
 */
export function createSystemTransformHook(
  store: MemoryStore,
  config: PluginConfig,
  embeddingProvider: EmbeddingProvider | null,
  personaStore: PersonaStore,
  state: RuntimeState,
  now: () => number,
  allProjectIds: string[],
): NonNullable<Hooks["experimental.chat.system.transform"]> {
  return async (input, output) => {
    const sessionId = input.sessionID
    if (!sessionId || state.internalSessionIds.has(sessionId) || state.injectedSessionIds.has(sessionId)) {
      return
    }

    const context = await generateSessionContext(store, sessionId, config, embeddingProvider, personaStore, now, allProjectIds)
    if (!context) {
      return
    }

    output.system.unshift(context)
    state.injectedSessionIds.add(sessionId)
  }
}
