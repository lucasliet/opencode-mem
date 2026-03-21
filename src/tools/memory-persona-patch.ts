import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { PersonaStore } from "../storage/persona"

/**
 * Creates the persona patch tool.
 *
 * @param personaStore - Persona storage.
 * @returns Tool definition.
 */
export function createMemoryPersonaPatchTool(
  personaStore: PersonaStore,
): ToolDefinition {
  return tool({
    description: "Append new facts to the existing user persona memory.",
    args: {
      facts: tool.schema.string().min(1),
    },
    async execute(args) {
      const lines = args.facts
        .split("\n")
        .map((f: string) => f.trim())
        .filter(Boolean)

      const result = await personaStore.mergeFacts(lines)
      return `Persona patched (version ${result.version}).`
    },
  })
}
