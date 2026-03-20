import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { MemoryStore } from "../storage/store"
import { formatRelativeTime } from "../utils"
import type { PluginConfig } from "../types"

/**
 * Creates the readonly memory statistics tool.
 *
 * @param store - Memory store.
 * @param now - Clock function.
 * @returns Tool definition.
 */
export function createMemoryStatsTool(store: MemoryStore, now: () => number): ToolDefinition {
  return tool({
    description:
      "Show memory plugin statistics including observation counts, quality distribution, queue status, deletion activity, and tool usage.",
    args: {},
    async execute(_, context) {
      await store.incrementToolUsage(context.sessionID, "memory_stats")

      const [
        totalObservations,
        observations24h,
        summariesCount,
        pendingCounts,
        qualityDistribution,
        compression,
        embeddingStats,
        toolUsage,
        deletionStats,
        dbSize,
      ] = await Promise.all([
        store.countObservations(),
        store.countObservationsSince(now() - 86_400_000),
        store.countSessionSummaries(),
        store.getPendingStatusCounts(),
        store.getQualityDistribution(),
        store.getCompressionStats(),
        store.getEmbeddingStats(),
        store.getToolUsageStats(7),
        store.getDeletionStats(30),
        store.getDatabaseSizeBytes(),
      ])

      const lowQuality = qualityDistribution.low
      const totalQuality = qualityDistribution.high + qualityDistribution.medium + qualityDistribution.low
      const highPct = percentage(qualityDistribution.high, totalQuality)
      const mediumPct = percentage(qualityDistribution.medium, totalQuality)
      const lowPct = percentage(qualityDistribution.low, totalQuality)

      const toolCounts = summarizeToolUsage(toolUsage)
      const compressionRatio = compression.averageRatio > 0 ? `${compression.averageRatio.toFixed(1)}:1` : "n/a"
      const embeddingCoverage = percentage(embeddingStats.totalEmbeddings, totalObservations)
      const lastCompression = compression.lastCompressedAt
        ? formatRelativeTime(compression.lastCompressedAt, now)
        : "never"

      const vectorState = await store.getVectorBackendState()

      return [
        `Observations: ${totalObservations} (last 24h: ${observations24h}, low-quality: ${lowQuality})`,
        `Session summaries: ${summariesCount}`,
        `Pending messages: ${pendingCounts.pending} pending, ${pendingCounts.processing} processing, ${pendingCounts.failed} failed`,
        `Database size: ${formatBytes(dbSize)}`,
        `Avg compression ratio: ${compressionRatio}`,
        `Semantic search: ${embeddingStats.semanticEnabled ? "enabled" : "disabled"}`,
        `Embeddings: ${embeddingStats.totalEmbeddings} (${embeddingCoverage}% coverage, backend ${embeddingStats.backendMode})`,
        `Embedding model: ${embeddingStats.model ?? "n/a"} (${embeddingStats.dimensions ?? 0} dims)`,
        `Quality: ${highPct}% high, ${mediumPct}% medium, ${lowPct}% low`,
        `Tool usage (last 7d): search ${toolCounts.search}, timeline ${toolCounts.timeline}, get ${toolCounts.get}, forget ${toolCounts.forget}, stats ${toolCounts.stats}`,
        `Deletions (last 30d): ${deletionStats.operations} operations, ${deletionStats.removed} observations removed`,
        `Last compression: ${lastCompression}`,
        embeddingStats.vectorError ? `Vector backend note: ${embeddingStats.vectorError}` : null,
      ].filter((value): value is string => Boolean(value)).join("\n")
    },
  })
}

/**
 * Converts bytes into a compact human-readable unit.
 *
 * @param value - Byte count.
 * @returns Formatted size string.
 */
export function formatBytes(value: number): string {
  if (value <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }

  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/**
 * Calculates a safe percentage.
 *
 * @param value - Partial value.
 * @param total - Total value.
 * @returns Rounded percentage.
 */
export function percentage(value: number, total: number): number {
  if (total <= 0) {
    return 0
  }

  return Math.round((value / total) * 100)
}

/**
 * Aggregates tool usage by known tool names.
 *
 * @param stats - Tool usage rows.
 * @returns Aggregated counts.
 */
export function summarizeToolUsage(stats: Awaited<ReturnType<MemoryStore["getToolUsageStats"]>>): {
  search: number
  timeline: number
  get: number
  forget: number
  stats: number
} {
  const counters = {
    search: 0,
    timeline: 0,
    get: 0,
    forget: 0,
    stats: 0,
  }

  for (const row of stats) {
    if (row.toolName === "memory_search") {
      counters.search += row.callCount
      continue
    }

    if (row.toolName === "memory_timeline") {
      counters.timeline += row.callCount
      continue
    }

    if (row.toolName === "memory_get") {
      counters.get += row.callCount
      continue
    }

    if (row.toolName === "memory_forget") {
      counters.forget += row.callCount
      continue
    }

    if (row.toolName === "memory_stats") {
      counters.stats += row.callCount
    }
  }

  return counters
}
