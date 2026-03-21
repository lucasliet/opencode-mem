import type { Hooks } from "@opencode-ai/plugin"
import type { PersonaExtractor } from "../compression/persona-extractor"
import { MemoryStore } from "../storage/store"
import type { PersonaStore } from "../storage/persona"
import type { ProjectScope, RuntimeState } from "../types"

const LEARN_INTERVAL = 3

/**
 * Creates the hook that captures user prompts and learns persona facts.
 *
 * @param store - Memory store.
 * @param scope - Project scope.
 * @param personaStore - Persona storage.
 * @param extractor - Persona fact extractor.
 * @param state - Runtime state.
 * @param now - Clock function.
 * @param logger - Logger for debugging.
 * @returns Hook implementation.
 */
export function createChatMessageHook(
  store: MemoryStore,
  scope: ProjectScope,
  personaStore: PersonaStore,
  extractor: PersonaExtractor,
  state: RuntimeState,
  now: () => number,
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void },
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

    state.personaLearnCount++

    if (state.personaLearnCount % LEARN_INTERVAL !== 1) {
      return
    }

    const persona = await personaStore.getPersona()

    try {
      const facts = await extractor.extract({
        userMessage: content,
        assistantMessage: "",
        currentPersona: persona?.content ?? "",
      })

      if (facts.length === 0) {
        return
      }

      await personaStore.mergeFacts(facts)

      const updated = await personaStore.getPersona()
      if (updated && updated.content.length > 10_000) {
        const summarized = await extractor.summarize(updated.content)
        await personaStore.updatePersona(summarized)
      }
    } catch {
      void logger.warn("Persona extraction failed, continuing silently")
    }
  }
}
