import path from "node:path"
import type { Observation, PendingMessage, SessionSummary, UserPromptRecord } from "../types"
import { formatTimestamp, normalizeWhitespace } from "../utils"

/**
 * Derives a short project label from the project root path.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns A human-readable project label.
 */
function deriveProjectLabel(projectRoot: string): string {
  return path.basename(projectRoot) || projectRoot
}

/**
 * Derives a feature context description from the session's user prompts and observations.
 * Falls back to project directory name when no content is available.
 *
 * @param prompts - Captured user prompts from the session.
 * @param observations - Compressed observations from the session.
 * @param fallbackRoot - Project root path used as final fallback.
 * @returns A human-readable feature context string.
 */
function deriveSessionContext(
  prompts: UserPromptRecord[],
  observations: Observation[],
  fallbackRoot: string,
): string {
  const firstPrompt = prompts[0]
  if (firstPrompt) {
    const cleaned = normalizeWhitespace(firstPrompt.content)
    const truncated = cleaned.length > 150 ? cleaned.slice(0, 150).trimEnd() + "..." : cleaned
    return truncated
  }

  if (observations.length > 0) {
    const titles = observations
      .slice(0, 3)
      .map((o) => o.title)
      .filter(Boolean)
      .join("; ")
    if (titles) {
      return titles.length > 150 ? titles.slice(0, 150).trimEnd() + "..." : titles
    }
  }

  return deriveProjectLabel(fallbackRoot)
}

/**
 * Derives a context snippet from a pending tool output message.
 * Uses the title or first lines of raw content, falling back to project directory name.
 *
 * @param pendingMessage - Pending tool output waiting for compression.
 * @returns A human-readable context string.
 */
function deriveToolContext(pendingMessage: PendingMessage): string {
  if (pendingMessage.title) {
    return pendingMessage.title.length > 150
      ? pendingMessage.title.slice(0, 150).trimEnd() + "..."
      : pendingMessage.title
  }

  const firstLine = pendingMessage.rawContent.split("\n")[0]?.trim()
  if (firstLine) {
    return firstLine.length > 150
      ? firstLine.slice(0, 150).trimEnd() + "..."
      : firstLine
  }

  return deriveProjectLabel(pendingMessage.projectRoot)
}

/**
 * Builds the prompt used to compress a raw tool execution into a structured observation.
 *
 * @param pendingMessage - Pending tool output waiting for compression.
 * @param projectContext - Optional project name or label for contextual framing.
 * @returns A prompt string for the compression model.
 */
export function buildCompressionPrompt(pendingMessage: PendingMessage, projectContext?: string): string {
  const metadata = pendingMessage.rawMetadata
    ? JSON.stringify(pendingMessage.rawMetadata, null, 2)
    : "{}"

  const contextLabel = projectContext ?? deriveToolContext(pendingMessage)

  return `You are compressing tool execution output in the context of "${contextLabel}".

Produce a compact persistent memory observation for a coding agent.

Return ONLY valid JSON with this exact shape:
{
  "title": "short title, max 10 words",
  "subtitle": "one-line context, max 20 words",
  "narrative": "2-3 concise sentences describing what happened and why it matters",
  "facts": ["specific fact"],
  "concepts": ["searchable keyword"],
  "filesInvolved": ["relative/path.ts"],
  "type": "tool_output"
}

Rules:
- Keep only durable facts, decisions, failures, and code changes.
- Ignore boilerplate and repeated command noise.
- Prefer exact file paths when available.
- In the "concepts" field, include synonyms and related technical concepts that a developer might search for.
- Example: if output mentions JWT tokens, include related terms like authentication, auth, session, and token rotation.
- If this is an error, emphasize root cause and resolution clues.
- If no useful files are present, return an empty array.
- Only include file paths that appear verbatim in the raw output.
- Only include facts that are explicitly stated in the raw output.
- Never infer, extrapolate, or invent details.
- Never use markdown fences.

Tool: ${pendingMessage.toolName}
Title: ${pendingMessage.title ?? "(none)"}
Project root: ${pendingMessage.projectRoot}
Session: ${pendingMessage.sessionId}
Captured at: ${formatTimestamp(pendingMessage.createdAt)}

Metadata:
${metadata}

Raw tool output:
---
${pendingMessage.rawContent}
---`
}

/**
 * Builds the prompt used to summarize a session from prompts and observations.
 *
 * @param prompts - Captured prompts from the session.
 * @param observations - Compressed observations from the session.
 * @param projectContext - Optional project name or label for contextual framing.
 * @returns A prompt string for the summarization model.
 */
export function buildSessionSummaryPrompt(
  prompts: UserPromptRecord[],
  observations: Observation[],
  projectContext?: string,
): string {
  const promptLines = prompts
    .slice(-8)
    .map((prompt, index) => `- Prompt ${index + 1}: ${normalizeWhitespace(prompt.content)}`)
    .join("\n")

  const observationLines = observations
    .map(
      (observation, index) =>
        `[${index + 1}] ${observation.title} | ${observation.type} | ${observation.narrative}`,
    )
    .join("\n")

  const contextLabel = projectContext
    ?? deriveSessionContext(
      prompts,
      observations,
      observations[0]?.projectRoot ?? prompts[0]?.projectRoot ?? "unknown project",
    )

  return `You are summarizing a coding session about "${contextLabel}".

Return ONLY valid JSON with this exact shape:
{
  "requested": "what the user asked for in 1-2 sentences",
  "investigated": "what was explored or analyzed in 1-2 sentences",
  "learned": "important findings or decisions in 1-2 sentences",
  "completed": "what was actually done in 1-2 sentences",
  "nextSteps": "the most likely follow-up actions in 1-2 sentences"
}

Rules:
- Be concise and specific.
- Prefer facts over speculation.
- If there is no clear next step, say so briefly.
- Never use markdown fences.

User prompts:
${promptLines || "- No prompts captured"}

Observations:
${observationLines || "- No observations captured"}`
}

/**
 * Formats a summary for compaction or context injection.
 *
 * @param summaries - Summaries to format.
 * @returns Plain text summary block.
 */
export function formatSummaryBlock(summaries: SessionSummary[]): string {
  return summaries
    .map((summary) => {
      const parts = [summary.requested, summary.completed, summary.nextSteps].filter(Boolean)
      return `- Session ${summary.sessionId}: ${parts.join(" ")}`
    })
    .join("\n")
}
