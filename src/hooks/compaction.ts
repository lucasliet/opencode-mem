import type { Hooks } from "@opencode-ai/plugin"
import { generateCompactionContext } from "../context/generator"
import { MemoryStore } from "../storage/store"
import type { RuntimeState } from "../types"

/**
 * Creates the compaction hook that preserves persistent memory context.
 *
 * @param store - Memory store.
 * @param state - Runtime state.
 * @param now - Clock function.
 * @returns Hook implementation.
 */
export function createCompactionHook(
  store: MemoryStore,
  state: RuntimeState,
  now: () => number,
): NonNullable<Hooks["experimental.session.compacting"]> {
  return async (input, output) => {
    if (state.internalSessionIds.has(input.sessionID)) {
      return
    }

    const context = await generateCompactionContext(store, now)
    if (context) {
      output.context.push(context)
    }
  }
}
