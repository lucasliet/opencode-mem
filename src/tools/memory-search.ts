import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { OBSERVATION_TYPES } from "../types"
import { formatRelativeTime } from "../utils"

/**
 * Creates the keyword-based memory search tool.
 *
 * @param store - Memory store.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemorySearchTool(store: MemoryStore, now: () => number): ToolDefinition {
  return tool({
    description:
      "Search persistent project memory from previous OpenCode sessions. Returns compact index entries that can be expanded with memory_get.",
    args: {
      query: tool.schema.string().min(1),
      limit: tool.schema.number().int().min(1).max(50).optional(),
      type: tool.schema.enum(OBSERVATION_TYPES).optional(),
    },
    async execute(args) {
      const results = await store.searchFTS(args.query, args.limit ?? 10, args.type)
      if (!results.length) {
        return "No memory results found. Try broader keywords, a different observation type, or use memory_timeline."
      }

      return results
        .map(
          (result) =>
            `[${result.id}] ${result.title} — ${result.subtitle ?? "No subtitle"} (${result.type}, ${formatRelativeTime(result.createdAt, now)})`,
        )
        .join("\n")
    },
  })
}
