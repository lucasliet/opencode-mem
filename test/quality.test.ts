import { describe, expect, test } from "bun:test"
import { validateObservation } from "../src/compression/quality"
import type { Observation } from "../src/types"

function createObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs_1",
    projectId: "project_1",
    projectRoot: "/tmp/project",
    sessionId: "session_1",
    type: "tool_output",
    title: "Fix JWT authentication",
    subtitle: "Adjusted auth middleware",
    narrative: "Updated token validation flow in middleware.",
    facts: ["Updated JWT token validation middleware"],
    concepts: ["jwt", "authentication"],
    filesInvolved: ["src/auth/middleware.ts"],
    rawTokenCount: 100,
    compressedTokenCount: 25,
    toolName: "bash",
    modelUsed: "anthropic/claude-haiku-4-5",
    quality: "high",
    rawFallback: null,
    createdAt: 1,
    ...overrides,
  }
}

describe("quality gate", () => {
  test("shouldReturnHighQualityForGroundedObservation", () => {
    const observation = createObservation()
    const raw = "Edited src/auth/middleware.ts and updated JWT authentication token validation middleware logic."

    const result = validateObservation(observation, raw)
    expect(result.quality).toBe("high")
    expect(result.flags.length).toBe(0)
  })

  test("shouldReturnMediumQualityWhenConceptIsUngrounded", () => {
    const observation = createObservation({
      concepts: ["jwt", "quantum-computing"],
    })
    const raw = "Edited src/auth/middleware.ts and updated JWT token validation logic."

    const result = validateObservation(observation, raw)
    expect(result.quality).toBe("medium")
    expect(result.flags.some((flag) => flag.startsWith("ungrounded_concept:"))).toBe(true)
  })

  test("shouldReturnLowQualityWhenFactsAreMostlyUngrounded", () => {
    const observation = createObservation({
      facts: [
        "Updated JWT validation middleware",
        "Refactored payment gateway integration",
        "Migrated Redis cluster to sentinel mode",
      ],
    })
    const raw = "Updated JWT validation middleware in src/auth/middleware.ts."

    const result = validateObservation(observation, raw)
    expect(result.quality).toBe("low")
    expect(result.flags).toContain("hallucination_ratio_exceeded")
  })

  test("shouldFlagHallucinatedFilePath", () => {
    const observation = createObservation({
      filesInvolved: ["src/does/not/exist.ts"],
    })
    const raw = "Updated src/auth/middleware.ts for JWT auth handling."

    const result = validateObservation(observation, raw)
    expect(result.flags.some((flag) => flag.startsWith("hallucinated_path:"))).toBe(true)
  })

  test("shouldAcceptMultiWordConceptsWhenKeyTermsExistInRawContent", () => {
    const observation = createObservation({
      title: "Captura saída de ferramentas",
      facts: ["Implementa função createToolExecuteAfterHook para registrar outputs"],
      concepts: ["tool output capture", "privacy stripping", "binary detection"],
      filesInvolved: ["src/hooks/tool-after.ts"],
    })
    const raw = "export function createToolExecuteAfterHook() { const rawOutput = output.output ?? \"\"; if (isProbablyBinary(rawOutput)) { const content = stripSensitiveTokens(rawOutput) } } src/hooks/tool-after.ts"

    const result = validateObservation(observation, raw)
    expect(result.quality).toBe("medium")
  })
})
