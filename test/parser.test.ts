import { describe, expect, test } from "bun:test"
import { parseObservation, parseSessionSummary } from "../src/compression/parser"
import type { PendingMessage } from "../src/types"

const pendingMessage: PendingMessage = {
  id: "obs_1",
  projectId: "project_1",
  projectRoot: "/tmp/project",
  sessionId: "session_1",
  toolName: "bash",
  title: "Bash command",
  rawContent: "error: file not found in src/index.ts",
  rawMetadata: null,
  status: "pending",
  retryCount: 0,
  errorMessage: null,
  createdAt: 1,
  processedAt: null,
}

describe("observation parser", () => {
  test("shouldParseValidJsonObservation", () => {
    const observation = parseObservation(
      `{
        "title": "Fixed read path",
        "subtitle": "Adjusted file lookup",
        "narrative": "The command failed due to a missing path. The correct path was then used.",
        "facts": ["Path mismatch", "File found after correction"],
        "concepts": ["path", "filesystem"],
        "filesInvolved": ["src/index.ts"],
        "type": "error"
      }`,
      pendingMessage,
      "anthropic/claude-sonnet-4-5",
    )

    expect(observation.title).toBe("Fixed read path")
    expect(observation.type).toBe("error")
    expect(observation.filesInvolved).toEqual(["src/index.ts"])
    expect(observation.modelUsed).toBe("anthropic/claude-sonnet-4-5")
  })

  test("shouldFallbackWhenJsonIsInvalid", () => {
    const observation = parseObservation("not-json", pendingMessage, null)

    expect(observation.title.length).toBeGreaterThan(0)
    expect(observation.narrative.length).toBeGreaterThan(0)
    expect(observation.type).toBe("tool_output")
  })

  test("shouldParseSessionSummary", () => {
    const summary = parseSessionSummary(
      `{
        "requested": "Implement persistent memory.",
        "investigated": "Reviewed plugin hooks.",
        "learned": "tool.execute.after works for capture.",
        "completed": "Built storage and queue.",
        "nextSteps": "Add benchmarks."
      }`,
      {
        id: "summary_1",
        projectId: "project_1",
        projectRoot: "/tmp/project",
        sessionId: "session_1",
        observationCount: 4,
        createdAt: 100,
        modelUsed: "anthropic/claude-haiku-4-5",
      },
    )

    expect(summary.sessionId).toBe("session_1")
    expect(summary.completed).toBe("Built storage and queue.")
    expect(summary.observationCount).toBe(4)
  })
})
