import { describe, expect, test } from "bun:test"
import { compactConfig, normalizeConfig } from "../src/config"

describe("config normalization", () => {
  test("shouldMergeDefaultsAndClampValues", () => {
    const config = normalizeConfig(
      {
        dbPath: "~/tmp/memory.db",
        indexSize: 999,
        sampleSize: -4,
        maxPendingRetries: 0,
        embeddingDimensions: 99999,
        semanticSearchMaxResults: 999,
        semanticContextMaxResults: 999,
        semanticMinScore: 2,
        hybridSearchAlpha: -1,
        compressionBatchSize: 999,
        logLevel: "debug",
      },
      {},
    )

    expect(config.dbPath.endsWith("/tmp/memory.db")).toBe(true)
    expect(config.indexSize).toBe(200)
    expect(config.sampleSize).toBe(0)
    expect(config.maxPendingRetries).toBe(1)
    expect(config.embeddingDimensions).toBe(4096)
    expect(config.semanticSearchMaxResults).toBe(50)
    expect(config.semanticContextMaxResults).toBe(10)
    expect(config.semanticMinScore).toBe(1)
    expect(config.hybridSearchAlpha).toBe(0)
    expect(config.compressionBatchSize).toBe(50)
    expect(config.logLevel).toBe("debug")
  })

  test("shouldPreferRuntimeModelWhenCompressionModelIsMissing", () => {
    const config = normalizeConfig(
      {
        compressionModel: null,
      },
      {
        small_model: "anthropic/claude-haiku-4-5",
      },
    )

    expect(config.compressionModel).toBe("anthropic/claude-haiku-4-5")
  })

  test("shouldDropUndefinedValuesFromCompactConfig", () => {
    const compacted = compactConfig({
      dbPath: undefined,
      indexSize: 10,
      compressionModel: null,
    })

    expect("dbPath" in compacted).toBe(false)
    expect(compacted.indexSize).toBe(10)
    expect(compacted.compressionModel).toBeNull()
  })
})
