import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import type { RuntimeState } from "../src/types"
import { PersonaExtractor } from "../src/compression/persona-extractor"

interface ExtractorHarness {
  extractor: PersonaExtractor
  state: RuntimeState
  counters: {
    createCalls: number
    promptCalls: number
    deleteCalls: number
  }
  getLastPromptText: () => string
}

/**
 * Creates a clean runtime state for persona extractor tests.
 *
 * @returns Runtime state with empty collections and default counters.
 */
function createRuntimeState(): RuntimeState {
  return {
    internalSessionIds: new Set(),
    injectedSessionIds: new Set(),
    knownSessionIds: new Set(),
    summaryTimers: new Map(),
    personaLearnCount: 0,
    shutdownRegistered: false,
    disposed: false,
  }
}

/**
 * Builds a persona extractor harness with mocked session APIs.
 *
 * @param responseText - Mocked text returned by prompt.
 * @returns Harness exposing the extractor and call counters.
 */
function createExtractorHarness(responseText: string): ExtractorHarness {
  const state = createRuntimeState()
  const counters = {
    createCalls: 0,
    promptCalls: 0,
    deleteCalls: 0,
  }
  let lastPromptText = ""

  const input = {
    directory: "/tmp/project",
    client: {
      session: {
        create: async () => {
          counters.createCalls++
          return { data: { id: "session_internal" }, error: null }
        },
        prompt: async ({ body }: { body: { parts: Array<{ text: string }> } }) => {
          counters.promptCalls++
          lastPromptText = body.parts[0]?.text ?? ""
          return {
            data: { parts: [{ type: "text", text: responseText }] },
            error: null,
          }
        },
        delete: async () => {
          counters.deleteCalls++
          return { data: {}, error: null }
        },
      },
    },
  } as unknown as PluginInput

  return {
    extractor: new PersonaExtractor(input, state),
    state,
    counters,
    getLastPromptText: () => lastPromptText,
  }
}

describe("persona extractor", () => {
  test("shouldReturnEmptyWhenUserMessageIsMissing", async () => {
    const harness = createExtractorHarness("[]")

    const facts = await harness.extractor.extract({
      userMessage: "   ",
      assistantMessage: "ok",
      currentPersona: "",
    })

    expect(facts).toEqual([])
    expect(harness.counters.createCalls).toBe(0)
    expect(harness.counters.promptCalls).toBe(0)
    expect(harness.counters.deleteCalls).toBe(0)
  })

  test("shouldExtractFactsWhenAssistantMessageIsMissing", async () => {
    const harness = createExtractorHarness('["Prefers concise responses"]')

    const facts = await harness.extractor.extract({
      userMessage: "Please keep answers brief.",
      assistantMessage: "",
      currentPersona: "",
    })

    expect(facts).toEqual(["Prefers concise responses"])
    expect(harness.counters.createCalls).toBe(1)
    expect(harness.counters.promptCalls).toBe(1)
    expect(harness.counters.deleteCalls).toBe(1)
    expect(harness.getLastPromptText()).toContain("Assistant: (none)")
    expect(harness.state.internalSessionIds.size).toBe(0)
  })

  test("shouldReturnEmptyWhenPersonaExceedsMaxLength", async () => {
    const harness = createExtractorHarness('["Prefers concise responses"]')

    const facts = await harness.extractor.extract({
      userMessage: "Please keep answers brief.",
      assistantMessage: "sure",
      currentPersona: "x".repeat(10_001),
    })

    expect(facts).toEqual([])
    expect(harness.counters.createCalls).toBe(0)
    expect(harness.counters.promptCalls).toBe(0)
    expect(harness.counters.deleteCalls).toBe(0)
  })
})
