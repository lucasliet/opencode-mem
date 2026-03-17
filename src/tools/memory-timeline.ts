import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { formatTimestamp } from "../utils"

/**
 * Creates the chronological memory timeline tool.
 *
 * @param store - Memory store.
 * @returns Tool definition.
 */
export function createMemoryTimelineTool(store: MemoryStore): ToolDefinition {
  return tool({
    description:
      "Browse persistent project memory chronologically. Useful for understanding the sequence of prior work and narrowing by time range.",
    args: {
      limit: tool.schema.number().int().min(1).max(100).optional(),
      before: tool.schema.string().datetime().optional(),
      after: tool.schema.string().datetime().optional(),
      sessionId: tool.schema.string().optional(),
    },
    async execute(args) {
      const before = args.before ? Date.parse(args.before) : undefined
      const after = args.after ? Date.parse(args.after) : undefined
      if ((args.before && Number.isNaN(before)) || (args.after && Number.isNaN(after))) {
        return "Invalid ISO datetime provided to memory_timeline."
      }

      const page = await store.getTimeline({
        limit: args.limit ?? 20,
        before,
        after,
        sessionId: args.sessionId,
      })

      if (!page.observations.length) {
        return "No memories found for the requested timeline filters."
      }

      const sections = new Map<string, string[]>()
      for (const observation of page.observations) {
        const date = new Date(observation.createdAt).toISOString().slice(0, 10)
        const lines = sections.get(date) ?? []
        lines.push(
          `[${observation.id}] ${formatTimestamp(observation.createdAt)} — ${observation.title} (${observation.type}) — ${observation.subtitle ?? "No subtitle"}`,
        )
        sections.set(date, lines)
      }

      const body = [...sections.entries()]
        .map(([date, lines]) => `=== ${date} ===\n${lines.join("\n")}`)
        .join("\n\n")

      return page.nextCursor ? `${body}\n\nNext cursor: ${page.nextCursor}` : body
    },
  })
}
