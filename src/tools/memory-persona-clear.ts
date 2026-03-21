import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PersonaStore } from "../storage/persona"

/**
 * Creates the persona clear tool.
 *
 * @param personaStore - Persona storage.
 * @returns Tool definition.
 */
export function createMemoryPersonaClearTool(
  personaStore: PersonaStore,
): ToolDefinition {
  return tool({
    description: "Clear the global user persona memory.",
    args: {},
    async execute() {
      await personaStore.clearPersona()
      return "Persona memory cleared."
    },
  })
}
