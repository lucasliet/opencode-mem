import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { formatTimestamp } from "../utils"

/**
 * Creates the detailed observation retrieval tool.
 *
 * @param store - Memory store.
 * @returns Tool definition.
 */
export function createMemoryGetTool(store: MemoryStore): ToolDefinition {
  return tool({
    description:
      "Fetch full persistent memory observations by ID. Use after memory_search or memory_timeline when full details are needed.",
    args: {
      ids: tool.schema.array(tool.schema.string()).min(1).max(10),
    },
    async execute(args, context) {
      await store.incrementToolUsage(context.sessionID, "memory_get")

      const observations = await store.getObservationsBatch(args.ids)
      const found = new Set(observations.map((observation) => observation.id))
      const missing = args.ids.filter((id) => !found.has(id))

      if (!observations.length) {
        return `No observations found. Missing: ${missing.join(", ")}`
      }

      const body = observations
        .map((observation) => {
          const facts = observation.facts.length
            ? observation.facts.map((fact) => `- ${fact}`).join("\n")
            : "- none"
          const files = observation.filesInvolved.length
            ? observation.filesInvolved.join(", ")
            : "none"

          return [
            `## [${observation.id}] ${observation.title}`,
            `Type: ${observation.type} | Created: ${formatTimestamp(observation.createdAt)}`,
            `Tool: ${observation.toolName ?? "unknown"} | Files: ${files}`,
            `Quality: ${observation.quality}`,
            observation.subtitle ?? "No subtitle",
            observation.narrative,
            observation.rawFallback ? `Raw fallback:\n${observation.rawFallback}` : "",
            "Facts:",
            facts,
            `Concepts: ${observation.concepts.join(", ") || "none"}`,
          ].join("\n")
        })
        .join("\n\n")

      return missing.length ? `${body}\n\nNot found: ${missing.join(", ")}` : body
    },
  })
}
