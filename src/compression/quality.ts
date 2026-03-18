import type { Observation, QualityResult } from "../types"

const SYNONYM_GROUPS = [
  ["authentication", "auth", "jwt", "token", "session", "oauth", "oidc"],
  ["database", "db", "sqlite", "postgres", "mysql", "migration", "schema"],
  ["typescript", "ts", "javascript", "js"],
  ["error", "exception", "stacktrace", "failure", "failed"],
  ["build", "compile", "typecheck", "lint", "test"],
  ["api", "endpoint", "http", "request", "response"],
  ["cache", "caching", "memoization"],
]

/**
 * Validates compressed observations against the raw tool output.
 *
 * @param observation - Parsed observation.
 * @param rawContent - Raw tool output content.
 * @returns Quality bucket and validation flags.
 */
export function validateObservation(observation: Observation, rawContent: string): QualityResult {
  const flags: string[] = []
  const normalizedRaw = rawContent.toLowerCase()

  for (const filePath of observation.filesInvolved) {
    if (!containsVerbatim(rawContent, filePath)) {
      flags.push(`hallucinated_path:${filePath}`)
    }
  }

  for (const concept of observation.concepts) {
    if (!isGroundedConcept(concept, normalizedRaw)) {
      flags.push(`ungrounded_concept:${concept}`)
    }
  }

  let unmatchedFacts = 0
  for (const fact of observation.facts) {
    if (!isGroundedFact(fact, normalizedRaw)) {
      unmatchedFacts += 1
      flags.push("ungrounded_fact")
    }
  }

  if (observation.title.trim().toLowerCase() === observation.narrative.trim().toLowerCase()) {
    flags.push("low_integrity:title_equals_narrative")
  }

  if (rawContent.length > 500 && observation.facts.length === 0) {
    flags.push("low_integrity:missing_facts")
  }

  const hallucinationRatio = observation.facts.length > 0 ? unmatchedFacts / observation.facts.length : 0
  if (hallucinationRatio > 0.3) {
    flags.push("hallucination_ratio_exceeded")
  }

  if (flags.includes("hallucination_ratio_exceeded") || flags.length >= 3) {
    return {
      quality: "low",
      flags,
    }
  }

  if (flags.length >= 1) {
    return {
      quality: "medium",
      flags,
    }
  }

  return {
    quality: "high",
    flags,
  }
}

/**
 * Checks whether a file path appears exactly in the raw output.
 *
 * @param rawContent - Raw output.
 * @param filePath - Candidate file path.
 * @returns True if present verbatim.
 */
export function containsVerbatim(rawContent: string, filePath: string): boolean {
  if (!filePath) {
    return false
  }

  return rawContent.includes(filePath)
}

/**
 * Checks whether a concept appears in the raw output directly or via known synonyms.
 *
 * @param concept - Candidate concept.
 * @param normalizedRaw - Lowercase raw content.
 * @returns True when concept is grounded.
 */
export function isGroundedConcept(concept: string, normalizedRaw: string): boolean {
  const normalizedConcept = concept.toLowerCase().trim()
  if (!normalizedConcept) {
    return false
  }

  if (normalizedRaw.includes(normalizedConcept)) {
    return true
  }

  for (const group of SYNONYM_GROUPS) {
    if (!group.includes(normalizedConcept)) {
      continue
    }

    if (group.some((alias) => normalizedRaw.includes(alias))) {
      return true
    }
  }

  return false
}

/**
 * Checks whether a fact has enough keyword overlap with the raw content.
 *
 * @param fact - Candidate fact sentence.
 * @param normalizedRaw - Lowercase raw content.
 * @returns True when fact is grounded.
 */
export function isGroundedFact(fact: string, normalizedRaw: string): boolean {
  const keywords = extractFactKeywords(fact)
  if (!keywords.length) {
    return false
  }

  return keywords.some((keyword) => normalizedRaw.includes(keyword))
}

/**
 * Extracts meaningful keywords from a fact sentence.
 *
 * @param fact - Fact sentence.
 * @returns Distinct normalized keywords.
 */
export function extractFactKeywords(fact: string): string[] {
  const tokens = fact
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 4)

  return [...new Set(tokens)].slice(0, 12)
}
