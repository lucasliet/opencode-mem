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
        compressionBatchSize: 999,
        logLevel: "debug",
      },
      {},
    )

    expect(config.dbPath.endsWith("/tmp/memory.db")).toBe(true)
    expect(config.indexSize).toBe(200)
    expect(config.sampleSize).toBe(0)
    expect(config.maxPendingRetries).toBe(1)
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
