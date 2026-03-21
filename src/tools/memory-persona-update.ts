import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PersonaStore } from "../storage/persona"

/**
 * Creates the persona update tool.
 *
 * @param personaStore - Persona storage.
 * @returns Tool definition.
 */
export function createMemoryPersonaUpdateTool(
  personaStore: PersonaStore,
): ToolDefinition {
  return tool({
    description: "Replace the global user persona memory with new content.",
    args: {
      content: tool.schema.string().min(1),
    },
    async execute(args) {
      const result = await personaStore.updatePersona(args.content)
      return `Persona updated (version ${result.version}).`
    },
  })
}
