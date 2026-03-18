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
  const severeFlags: string[] = []
  const warningFlags: string[] = []
  const normalizedRaw = rawContent.toLowerCase()

  for (const filePath of observation.filesInvolved) {
    if (!containsVerbatim(rawContent, filePath)) {
      severeFlags.push(`hallucinated_path:${filePath}`)
    }
  }

  let ungroundedConcepts = 0
  for (const concept of observation.concepts) {
    if (!isGroundedConcept(concept, normalizedRaw)) {
      ungroundedConcepts += 1
      warningFlags.push(`ungrounded_concept:${concept}`)
    }
  }

  let unmatchedFacts = 0
  for (const fact of observation.facts) {
    if (!isGroundedFact(fact, normalizedRaw)) {
      unmatchedFacts += 1
      warningFlags.push("ungrounded_fact")
    }
  }

  if (observation.title.trim().toLowerCase() === observation.narrative.trim().toLowerCase()) {
    severeFlags.push("low_integrity:title_equals_narrative")
  }

  if (rawContent.length > 500 && observation.facts.length === 0) {
    warningFlags.push("low_integrity:missing_facts")
  }

  const hallucinationRatio = observation.facts.length > 0 ? unmatchedFacts / observation.facts.length : 0
  if (hallucinationRatio > 0.6) {
    severeFlags.push("hallucination_ratio_exceeded")
  } else if (hallucinationRatio > 0.3) {
    warningFlags.push("partial_hallucination_risk")
  }

  const conceptRatio = observation.concepts.length > 0 ? ungroundedConcepts / observation.concepts.length : 0
  if (conceptRatio > 0.7) {
    warningFlags.push("concept_grounding_weak")
  }

  const flags = [...severeFlags, ...warningFlags]

  if (severeFlags.length > 0) {
    return {
      quality: "low",
      flags,
    }
  }

  if (warningFlags.length >= 1) {
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

  const conceptTokens = tokenizeGroundingText(normalizedConcept).filter((token) => token.length > 3)
  if (conceptTokens.length > 0 && conceptTokens.some((token) => normalizedRaw.includes(token))) {
    return true
  }

  for (const group of SYNONYM_GROUPS) {
    const matchesGroup = group.includes(normalizedConcept)
      || conceptTokens.some((token) => group.includes(token))

    if (!matchesGroup) {
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

  const matches = keywords.filter((keyword) => normalizedRaw.includes(keyword)).length
  return matches >= 1
}

/**
 * Extracts meaningful keywords from a fact sentence.
 *
 * @param fact - Fact sentence.
 * @returns Distinct normalized keywords.
 */
export function extractFactKeywords(fact: string): string[] {
  const tokens = tokenizeGroundingText(fact)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 4)

  return [...new Set(tokens)].slice(0, 12)
}

/**
 * Tokenizes text for grounding checks.
 *
 * @param value - Raw text.
 * @returns Lowercase tokens.
 */
export function tokenizeGroundingText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter(Boolean)
}
