import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PersonaStore } from "../storage/persona"
import { formatRelativeTime } from "../utils"

/**
 * Creates the persona get tool.
 *
 * @param personaStore - Persona storage.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemoryPersonaGetTool(
  personaStore: PersonaStore,
  now: () => number,
): ToolDefinition {
  return tool({
    description: "View the current global user persona memory.",
    args: {},
    async execute() {
      const persona = await personaStore.getPersona()
      if (!persona) {
        return "No persona memory exists yet."
      }

      return [
        `Persona (version ${persona.version}, updated ${formatRelativeTime(persona.updatedAt, now)}):`,
        "",
        persona.content,
      ].join("\n")
    },
  })
}
