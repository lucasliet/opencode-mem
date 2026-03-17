import type { Hooks } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import type { ProjectScope, RuntimeState } from "../types"

/**
 * Creates the hook that captures user prompts for later summarization.
 *
 * @param store - Memory store.
 * @param scope - Project scope.
 * @param state - Runtime state.
 * @param now - Clock function.
 * @returns Hook implementation.
 */
export function createChatMessageHook(
  store: MemoryStore,
  scope: ProjectScope,
  state: RuntimeState,
  now: () => number,
): NonNullable<Hooks["chat.message"]> {
  return async (input, output) => {
    if (state.internalSessionIds.has(input.sessionID)) {
      return
    }

    const content = output.parts
      .filter((part): part is import("@opencode-ai/sdk").TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()

    if (!content) {
      return
    }

    await store.saveUserPrompt({
      id: store.createId(),
      projectId: scope.projectId,
      projectRoot: scope.projectRoot,
      sessionId: input.sessionID,
      messageId: output.message.id,
      content,
      createdAt: now(),
    })
  }
}
