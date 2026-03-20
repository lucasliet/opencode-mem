import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { buildSemanticQueryText } from "../embeddings/text"
import type { EmbeddingProvider, PluginConfig } from "../types"
import { OBSERVATION_TYPES } from "../types"
import { formatRelativeTime } from "../utils"

/**
 * Creates the keyword-based memory search tool.
 *
 * @param store - Memory store.
 * @param config - Plugin configuration.
 * @param embeddingProvider - Optional local embedding provider.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemorySearchTool(
  store: MemoryStore,
  config: PluginConfig,
  embeddingProvider: EmbeddingProvider | null,
  now: () => number,
): ToolDefinition {
  return tool({
    description:
      "Search persistent project memory from previous OpenCode sessions. Returns compact index entries that can be expanded with memory_get.",
    args: {
      query: tool.schema.string().min(1),
      limit: tool.schema.number().int().min(1).max(50).optional(),
      type: tool.schema.enum(OBSERVATION_TYPES).optional(),
    },
    async execute(args, context) {
      await store.incrementToolUsage(context.sessionID, "memory_search")

      const limit = args.limit ?? 10
      const semanticLimit = Math.max(limit, config.semanticSearchMaxResults)
      const embedding = config.enableSemanticSearch && embeddingProvider
        ? await safeEmbedQuery(embeddingProvider, args.query)
        : null
      const results = config.enableSemanticSearch
        ? await store.searchHybrid(buildSemanticQueryText(args.query), embedding, {
          limit,
          semanticLimit,
          typeFilter: args.type,
          semanticMinScore: config.semanticMinScore,
          hybridSearchAlpha: config.hybridSearchAlpha,
        })
        : await store.searchFTS(args.query, limit, args.type)

      if (!results.length) {
        return "No memory results found. Try broader keywords, a different observation type, or use memory_timeline."
      }

      return results
        .map(
          (result) => {
            const marker = result.quality === "low" ? "[?] " : ""
            const suffix = result.quality === "low"
              ? " -> low-confidence summary, use memory_get for raw fallback context"
              : result.source === "semantic"
                ? " -> semantic match"
                : result.source === "hybrid"
                  ? " -> hybrid match"
                  : ""
            return `[${result.id}] ${marker}${result.title} — ${result.subtitle ?? "No subtitle"} (${result.type}, ${formatRelativeTime(result.createdAt, now)})${suffix}`
          },
        )
        .join("\n")
    },
  })
}

/**
 * Embeds a search query without letting provider failures break the tool.
 *
 * @param embeddingProvider - Local embedding provider.
 * @param query - User-entered search text.
 * @returns Query embedding or null when semantic search cannot run.
 */
async function safeEmbedQuery(embeddingProvider: EmbeddingProvider, query: string): Promise<number[] | null> {
  try {
    return await embeddingProvider.embed(buildSemanticQueryText(query))
  } catch {
    return null
  }
}
