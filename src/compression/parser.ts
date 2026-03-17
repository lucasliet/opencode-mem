import type { Observation, ObservationType, PendingMessage, SessionSummary } from "../types"
import { OBSERVATION_TYPES } from "../types"
import { estimateTokenCount, normalizeWhitespace, parseJsonValue, stripMarkdownFences } from "../utils"

interface ObservationPayload {
  title?: unknown
  subtitle?: unknown
  narrative?: unknown
  facts?: unknown
  concepts?: unknown
  filesInvolved?: unknown
  type?: unknown
}

interface SessionSummaryPayload {
  requested?: unknown
  investigated?: unknown
  learned?: unknown
  completed?: unknown
  nextSteps?: unknown
}

/**
 * Parses the compressor output into a normalized observation.
 *
 * @param llmOutput - Raw model output.
 * @param pendingMessage - Source pending message.
 * @param modelUsed - Model identifier used for the compression.
 * @returns A normalized observation.
 */
export function parseObservation(
  llmOutput: string,
  pendingMessage: PendingMessage,
  modelUsed: string | null,
): Observation {
  const payload = parseObject<ObservationPayload>(llmOutput)
  const title = sanitizeText(payload?.title, 100) || fallbackTitle(pendingMessage)
  const narrative =
    sanitizeText(payload?.narrative, 2_000) || normalizeWhitespace(pendingMessage.rawContent).slice(0, 500)

  return {
    id: pendingMessage.id,
    projectId: pendingMessage.projectId,
    projectRoot: pendingMessage.projectRoot,
    sessionId: pendingMessage.sessionId,
    type: normalizeObservationType(payload?.type),
    title,
    subtitle: sanitizeNullableText(payload?.subtitle, 160),
    narrative,
    facts: sanitizeStringArray(payload?.facts, 20, 200),
    concepts: sanitizeStringArray(payload?.concepts, 20, 80),
    filesInvolved: sanitizeStringArray(payload?.filesInvolved, 20, 260),
    rawTokenCount: estimateTokenCount(pendingMessage.rawContent),
    compressedTokenCount: estimateTokenCount(JSON.stringify(payload ?? { title, narrative })),
    toolName: pendingMessage.toolName,
    modelUsed,
    createdAt: pendingMessage.createdAt,
  }
}

/**
 * Parses the summarizer output into a normalized session summary.
 *
 * @param llmOutput - Raw model output.
 * @param input - Summary metadata.
 * @returns A normalized session summary.
 */
export function parseSessionSummary(
  llmOutput: string,
  input: {
    id: string
    projectId: string
    projectRoot: string
    sessionId: string
    observationCount: number
    createdAt: number
    modelUsed: string | null
  },
): SessionSummary {
  const payload = parseObject<SessionSummaryPayload>(llmOutput)

  return {
    id: input.id,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    requested: sanitizeNullableText(payload?.requested, 600),
    investigated: sanitizeNullableText(payload?.investigated, 600),
    learned: sanitizeNullableText(payload?.learned, 600),
    completed: sanitizeNullableText(payload?.completed, 600),
    nextSteps: sanitizeNullableText(payload?.nextSteps, 600),
    observationCount: input.observationCount,
    modelUsed: input.modelUsed,
    createdAt: input.createdAt,
  }
}

/**
 * Extracts a JSON object from model output.
 *
 * @param value - Raw model output.
 * @returns A parsed object or null.
 */
export function parseObject<T>(value: string): T | null {
  const unfenced = stripMarkdownFences(value)
  const firstBrace = unfenced.indexOf("{")
  const lastBrace = unfenced.lastIndexOf("}")
  const candidate = firstBrace >= 0 && lastBrace >= 0 ? unfenced.slice(firstBrace, lastBrace + 1) : unfenced
  return parseJsonValue<T | null>(candidate, null)
}

/**
 * Normalizes an arbitrary value into a supported observation type.
 *
 * @param value - Candidate observation type.
 * @returns A supported observation type.
 */
export function normalizeObservationType(value: unknown): ObservationType {
  if (typeof value !== "string") {
    return "tool_output"
  }

  const normalized = value.trim().toLowerCase()
  return OBSERVATION_TYPES.includes(normalized as ObservationType)
    ? (normalized as ObservationType)
    : "tool_output"
}

/**
 * Sanitizes a value into a compact string.
 *
 * @param value - Candidate input value.
 * @param maxLength - Maximum output length.
 * @returns A sanitized string or an empty string.
 */
export function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return ""
  }

  return normalizeWhitespace(value).slice(0, maxLength)
}

/**
 * Sanitizes a nullable text field.
 *
 * @param value - Candidate input value.
 * @param maxLength - Maximum output length.
 * @returns The sanitized string or null.
 */
export function sanitizeNullableText(value: unknown, maxLength: number): string | null {
  const result = sanitizeText(value, maxLength)
  return result || null
}

/**
 * Sanitizes an array-like input into a list of compact strings.
 *
 * @param value - Candidate array value.
 * @param maxItems - Maximum number of items to keep.
 * @param maxLength - Maximum length per item.
 * @returns A normalized list of strings.
 */
export function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeWhitespace(item).slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems)
}

/**
 * Creates a fallback title when parsing fails.
 *
 * @param pendingMessage - Pending tool output.
 * @returns A descriptive fallback title.
 */
export function fallbackTitle(pendingMessage: PendingMessage): string {
  return pendingMessage.title?.slice(0, 100) || `${pendingMessage.toolName} output`
}
