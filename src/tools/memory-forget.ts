import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { formatRelativeTime } from "../utils"

const DELETE_PREVIEW_LIMIT = 50

/**
 * Creates the memory deletion tool with preview and confirm flow.
 *
 * @param store - Memory store.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemoryForgetTool(store: MemoryStore, now: () => number): ToolDefinition {
  return tool({
    description:
      "Delete persistent memory observations by IDs, query, session, or date. Use confirm=true to execute deletion after reviewing the preview.",
    args: {
      ids: tool.schema.array(tool.schema.string()).max(50).optional(),
      query: tool.schema.string().min(1).optional(),
      sessionId: tool.schema.string().min(1).optional(),
      before: tool.schema.string().datetime().optional(),
      confirm: tool.schema.boolean().optional(),
    },
    async execute(args, context) {
      const hasCriteria = Boolean(args.ids?.length || args.query || args.sessionId || args.before)
      if (!hasCriteria) {
        return "memory_forget requires at least one of: ids, query, sessionId, or before."
      }

      await store.incrementToolUsage(context.sessionID, "memory_forget")

      const preview = await buildPreview(store, {
        ids: args.ids,
        query: args.query,
        sessionId: args.sessionId,
        before: args.before,
      }, now)

      if (!args.confirm) {
        if (!preview.matches.length) {
          return "No observations match the provided deletion criteria."
        }

        const lines = preview.matches
          .slice(0, DELETE_PREVIEW_LIMIT)
          .map(
            (observation) =>
              `[${observation.id}] ${observation.title} (${observation.type}, ${formatRelativeTime(observation.createdAt, now)})`,
          )

        const extra = preview.matches.length > DELETE_PREVIEW_LIMIT
          ? `\n... and ${preview.matches.length - DELETE_PREVIEW_LIMIT} more.`
          : ""

        return [
          `Will delete ${preview.matches.length} observations:`,
          ...lines,
          extra,
          "",
          "Run memory_forget again with confirm=true to execute.",
        ]
          .filter(Boolean)
          .join("\n")
      }

      const criteria = JSON.stringify({
        ids: args.ids,
        query: args.query,
        sessionId: args.sessionId,
        before: args.before,
      })

      let deletedCount = 0
      if (args.ids?.length) {
        deletedCount += await store.deleteObservations(args.ids)
      }

      if (args.query) {
        deletedCount += await store.deleteByQuery(args.query)
      }

      if (args.sessionId) {
        deletedCount += await store.deleteBySession(args.sessionId)
      }

      if (args.before) {
        const beforeDate = new Date(args.before)
        if (!Number.isNaN(beforeDate.getTime())) {
          deletedCount += await store.deleteBefore(beforeDate)
        }
      }

      await store.logDeletion(criteria, deletedCount, "user")

      return `Deleted ${deletedCount} observations from persistent memory.`
    },
  })
}

/**
 * Builds a deletion preview for the selected criteria.
 *
 * @param store - Memory store.
 * @param criteria - Deletion filters.
 * @param now - Clock function.
 * @returns Matching observations.
 */
async function buildPreview(
  store: MemoryStore,
  criteria: {
    ids?: string[]
    query?: string
    sessionId?: string
    before?: string
  },
  now: () => number,
): Promise<{ matches: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>> }> {
  const candidates: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>> = []
  const seenIds = new Set<string>()

  if (criteria.ids?.length) {
    const rows = await store.getObservationsBatch(criteria.ids)
    addUnique(candidates, rows, seenIds)
  }

  if (criteria.query) {
    const matches = await store.searchFTS(criteria.query, DELETE_PREVIEW_LIMIT)
    const rows = await store.getObservationsBatch(matches.map((match) => match.id))
    addUnique(candidates, rows, seenIds)
  }

  if (criteria.sessionId) {
    const rows = await store.getSessionObservations(criteria.sessionId)
    addUnique(candidates, rows, seenIds)
  }

  if (criteria.before) {
    const beforeDate = new Date(criteria.before)
    if (!Number.isNaN(beforeDate.getTime())) {
      const rows = await store.searchByDateRange(new Date(0), beforeDate, 5_000)
      addUnique(candidates, rows, seenIds)
    }
  }

  return {
    matches: candidates.sort((left, right) => right.createdAt - left.createdAt),
  }
}

/**
 * Adds observations into a list without duplicates.
 *
 * @param target - Destination array.
 * @param rows - Source observations.
 * @param seenIds - Seen IDs set.
 * @returns Nothing.
 */
function addUnique(
  target: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>>,
  rows: Awaited<ReturnType<MemoryStore["getObservationsBatch"]>>,
  seenIds: Set<string>,
): void {
  for (const row of rows) {
    if (seenIds.has(row.id)) {
      continue
    }

    seenIds.add(row.id)
    target.push(row)
  }
}
