import type { MemoryStore } from "../storage/store"

/**
 * Generates a context block summarizing the most recent prior session.
 *
 * Uses existing session summaries to provide continuity between sessions
 * without reading transcript files.
 *
 * @param store - Memory store.
 * @param currentSessionId - Active session to exclude from results.
 * @returns A formatted "Where You Left Off" block or empty string.
 */
export async function getPriorSessionContext(
  store: MemoryStore,
  currentSessionId: string,
): Promise<string> {
  const recentSummaries = await store.getRecentSummaries(5)
  const priorSummary = recentSummaries.find((summary) => summary.sessionId !== currentSessionId)

  if (!priorSummary) {
    return ""
  }

  const lines: string[] = ["## Where You Left Off"]

  if (priorSummary.completed) {
    lines.push(`**Completed:** ${priorSummary.completed}`)
  }

  if (priorSummary.learned) {
    lines.push(`**Learned:** ${priorSummary.learned}`)
  }

  if (priorSummary.nextSteps) {
    lines.push(`**Next steps:** ${priorSummary.nextSteps}`)
  }

  if (lines.length === 1) {
    return ""
  }

  return lines.join("\n")
}
