import type { Observation } from "../types"
import { normalizeWhitespace } from "../utils"

/**
 * Builds the canonical text used for observation embeddings.
 *
 * @param observation - Observation that will be embedded.
 * @returns Stable text representation for semantic search.
 */
export function buildObservationEmbeddingText(observation: Observation): string {
  const sections = [
    `Title: ${observation.title}`,
    observation.subtitle ? `Subtitle: ${observation.subtitle}` : null,
    `Type: ${observation.type}`,
    `Narrative: ${observation.narrative}`,
    observation.facts.length ? `Facts: ${observation.facts.join(" | ")}` : null,
    observation.concepts.length ? `Concepts: ${observation.concepts.join(" | ")}` : null,
    observation.filesInvolved.length ? `Files: ${observation.filesInvolved.join(" | ")}` : null,
    observation.toolName ? `Tool: ${observation.toolName}` : null,
  ].filter((value): value is string => Boolean(value))

  return normalizeWhitespace(sections.join("\n"))
}

/**
 * Normalizes a raw semantic query before embedding.
 *
 * @param query - User-entered query.
 * @returns Normalized semantic query text.
 */
export function buildSemanticQueryText(query: string): string {
  return normalizeWhitespace(query)
}
