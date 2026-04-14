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

  const contextLabel = projectContext ?? deriveProjectLabel(pendingMessage.projectRoot)

  return `You are compressing tool execution output in the context of the project "${contextLabel}".

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
    ?? deriveProjectLabel(
      observations[0]?.projectRoot ?? prompts[0]?.projectRoot ?? "unknown project",
    )

  return `You are summarizing a coding session for the project "${contextLabel}".

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
