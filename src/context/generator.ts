import { formatSummaryBlock } from "../compression/prompts"
import { buildSemanticQueryText } from "../embeddings/text"
import { MemoryStore } from "../storage/store"
import type { EmbeddingProvider, PluginConfig } from "../types"
import { formatRelativeTime, normalizeWhitespace } from "../utils"

/**
 * Generates the memory context injected into the system prompt.
 *
 * @param store - Memory store.
 * @param sessionId - Active OpenCode session identifier.
 * @param config - Plugin configuration.
 * @param embeddingProvider - Optional local embedding provider.
 * @param now - Clock function.
 * @returns A context block or an empty string.
 */
export async function generateSessionContext(
  store: MemoryStore,
  sessionId: string,
  config: PluginConfig,
  embeddingProvider: EmbeddingProvider | null,
  now: () => number,
): Promise<string> {
  const recentObservations = await store.getRecentObservations(config.indexSize)
  if (!recentObservations.length) {
    return ""
  }

  const summaries = await store.getRecentSummaries(config.summaryLookback)
  const semanticObservations = await getSemanticContextObservations(store, sessionId, config, embeddingProvider)
  const indexLines = recentObservations.map(
    (observation) =>
      `- [${observation.id}] ${observation.title} — ${observation.subtitle ?? "No subtitle"} (${observation.type}, ${formatRelativeTime(observation.createdAt, now)})`,
  )

  const detailedSamples = recentObservations.slice(0, config.sampleSize).map((observation) => {
    const facts = observation.facts.map((fact) => `  - ${fact}`).join("\n") || "  - none"
    const files = observation.filesInvolved.join(", ") || "none"
    return `### ${observation.title}\n${observation.narrative}\nFacts:\n${facts}\nFiles: ${files}`
  })

  const summaryBlock = summaries.length
    ? `## Recent Session Summaries\n${formatSummaryBlock(summaries)}`
    : ""

  const semanticBlock = semanticObservations.length
    ? [
      "## Semantically Relevant Observations",
      ...semanticObservations.map(
        (observation) =>
          `- [${observation.id}] ${observation.title} — ${observation.subtitle ?? "No subtitle"} (${observation.type}, ${formatRelativeTime(observation.createdAt, now)})`,
      ),
    ].join("\n")
    : ""

  const sections = [
    "<memory_context>",
    "You have access to persistent memory from previous OpenCode sessions for this project.",
    "",
    `## Recent Observation Index (${recentObservations.length} entries)`,
    indexLines.join("\n"),
    "",
    detailedSamples.length
      ? "## Detailed Recent Observations"
      : "",
    detailedSamples.join("\n\n"),
    semanticBlock,
    summaryBlock,
    "",
    "## Available Memory Tools",
    "- memory_search: search prior observations by keyword and type.",
    "- memory_timeline: browse memories chronologically with filters.",
    "- memory_get: fetch full details for specific observation IDs.",
    "- memory_forget: preview and delete observations by criteria.",
    "- memory_stats: inspect memory health and usage metrics.",
    "Use memory tools when the user references prior work, asks what changed before, or when historical context could improve correctness.",
    "</memory_context>",
  ].filter(Boolean)

  return truncateToBudget(sections.join("\n"), config.contextMaxTokens)
}

/**
 * Retrieves a conservative semantic sample for automatic context injection.
 *
 * @param store - Memory store.
 * @param sessionId - Active OpenCode session identifier.
 * @param config - Plugin configuration.
 * @param embeddingProvider - Optional local embedding provider.
 * @returns Compact semantically relevant observations.
 */
async function getSemanticContextObservations(
  store: MemoryStore,
  sessionId: string,
  config: PluginConfig,
  embeddingProvider: EmbeddingProvider | null,
) {
  if (!config.enableSemanticSearch || !embeddingProvider || config.semanticContextMaxResults <= 0) {
    return []
  }

  const prompt = await store.getLatestUserPrompt(sessionId)
  if (!prompt) {
    return []
  }

  try {
    const embedding = await embeddingProvider.embed(buildSemanticQueryText(prompt))
    return store.searchSemantic(embedding, {
      limit: config.semanticContextMaxResults,
      semanticLimit: config.semanticContextMaxResults,
      semanticMinScore: config.semanticMinScore,
      hybridSearchAlpha: config.hybridSearchAlpha,
    })
  } catch {
    return []
  }
}

/**
 * Generates a shorter context block used during compaction.
 *
 * @param store - Memory store.
 * @param now - Clock function.
 * @returns Compaction context.
 */
export async function generateCompactionContext(store: MemoryStore, now: () => number): Promise<string> {
  const recent = await store.getRecentObservations(8)
  if (!recent.length) {
    return ""
  }

  return [
    "Persistent project memory highlights:",
    ...recent.map(
      (observation) =>
        `- ${observation.title} (${observation.type}, ${formatRelativeTime(observation.createdAt, now)}): ${normalizeWhitespace(observation.narrative)}`,
    ),
  ].join("\n")
}

/**
 * Truncates a context string to a token budget using a simple heuristic.
 *
 * @param value - Context text.
 * @param maxTokens - Maximum allowed tokens.
 * @returns Truncated or original text.
 */
export function truncateToBudget(value: string, maxTokens: number): string {
  const maxCharacters = maxTokens * 4
  if (value.length <= maxCharacters) {
    return value
  }

  return `${value.slice(0, maxCharacters - 32).trim()}\n...`
}
