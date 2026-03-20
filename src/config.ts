import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { join } from "node:path"
import type { Config, OpencodeClient } from "@opencode-ai/sdk"
import type { LogLevel, PluginConfig } from "./types"
import { ensureParentDirectory, getOpenCodeConfigDirectory, parseModelString, readJsonFile, resolveHomePath } from "./utils"

interface PartialPluginConfig extends Partial<Omit<PluginConfig, "configPaths">> {}

const DEFAULT_CONFIG: Omit<PluginConfig, "configPaths"> = {
  dbPath: "~/.config/opencode/memory/memory.db",
  indexSize: 50,
  sampleSize: 5,
  maxPendingRetries: 3,
  compressionModel: null,
  maxRawContentSize: 50_000,
  enableSemanticSearch: true,
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  embeddingDimensions: 384,
  semanticSearchMaxResults: 8,
  semanticContextMaxResults: 3,
  semanticMinScore: 0.55,
  hybridSearchAlpha: 0.65,
  privacyStrip: true,
  minContentLength: 100,
  compressionBatchSize: 10,
  retentionDays: 90,
  contextMaxTokens: 2_000,
  summaryLookback: 3,
  orphanThresholdMs: 5 * 60_000,
  queuePollIntervalMs: 250,
  sessionSummaryDebounceMs: 1_500,
  logLevel: "info",
}

/**
 * Loads the memory plugin configuration from project files, global files, and environment variables.
 *
 * @param input - Context needed to resolve configuration files and defaults.
 * @returns The merged plugin configuration.
 */
export async function loadConfig(input: {
  directory: string
  worktree: string
}): Promise<PluginConfig> {
  const configPaths = await findConfigPaths(input.worktree)
  const fileConfig = await loadConfigFiles(configPaths)
  const envConfig = loadEnvironmentConfig()
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    ...compactConfig(fileConfig),
    ...compactConfig(envConfig),
  })

  await ensureParentDirectory(config.dbPath)

  return {
    ...config,
    configPaths,
  }
}

/**
 * Selects the model string that should be used for background compression.
 *
 * @param pluginConfig - Plugin configuration.
 * @param runtimeConfig - OpenCode runtime configuration.
 * @returns The preferred model string or null.
 */
export function selectCompressionModelString(
  pluginConfig: PluginConfig,
  runtimeConfig: Config,
): string | null {
  return pluginConfig.compressionModel ?? runtimeConfig.small_model ?? runtimeConfig.model ?? null
}

/**
 * Parses the configured compression model into the SDK shape.
 *
 * @param pluginConfig - Plugin configuration.
 * @param runtimeConfig - OpenCode runtime configuration.
 * @returns The parsed model selection or null.
 */
export function selectCompressionModel(
  pluginConfig: PluginConfig,
  runtimeConfig: Config,
): ReturnType<typeof parseModelString> {
  return parseModelString(selectCompressionModelString(pluginConfig, runtimeConfig))
}

/**
 * Reads the merged OpenCode runtime configuration for the current project.
 *
 * @param client - OpenCode SDK client.
 * @param directory - Project directory.
 * @returns The merged runtime configuration.
 */
export async function loadOpenCodeConfig(client: OpencodeClient, directory: string): Promise<Config> {
  const result = await client.config.get({ query: { directory } })
  if (result.error || !result.data) {
    return {}
  }

  return result.data
}

/**
 * Resolves the ordered set of plugin config files that should be read.
 *
 * @param worktree - Project root.
 * @returns A list of existing config file paths.
 */
export async function findConfigPaths(worktree: string): Promise<string[]> {
  const globalRoot = getOpenCodeConfigDirectory()
  const candidates = [
    process.env.OPENCODE_MEMORY_CONFIG,
    join(globalRoot, "memory", "config.json"),
    join(globalRoot, "memory", "config.jsonc"),
    join(worktree, ".opencode", "memory.json"),
    join(worktree, ".opencode", "memory.jsonc"),
    join(worktree, "opencode-memory.json"),
    join(worktree, "opencode-memory.jsonc"),
  ].filter((value): value is string => Boolean(value))

  const existing: string[] = []
  for (const candidate of candidates) {
    const resolved = resolveHomePath(candidate)
    if (await fileExists(resolved)) {
      existing.push(resolved)
    }
  }

  return existing
}

/**
 * Merges a list of config files in order.
 *
 * @param configPaths - Existing config file paths.
 * @returns The merged partial configuration.
 */
export async function loadConfigFiles(configPaths: string[]): Promise<PartialPluginConfig> {
  let merged: PartialPluginConfig = {}

  for (const configPath of configPaths) {
    const parsed = await readJsonFile<PartialPluginConfig>(configPath)
    merged = {
      ...merged,
      ...parsed,
    }
  }

  return merged
}

/**
 * Reads plugin configuration from environment variables.
 *
 * @returns The environment-derived partial configuration.
 */
export function loadEnvironmentConfig(): PartialPluginConfig {
  return {
    dbPath: process.env.OPENCODE_MEMORY_DB_PATH,
    compressionModel: process.env.OPENCODE_MEMORY_COMPRESSION_MODEL,
    indexSize: parseInteger(process.env.OPENCODE_MEMORY_INDEX_SIZE),
    sampleSize: parseInteger(process.env.OPENCODE_MEMORY_SAMPLE_SIZE),
    maxPendingRetries: parseInteger(process.env.OPENCODE_MEMORY_MAX_PENDING_RETRIES),
    maxRawContentSize: parseInteger(process.env.OPENCODE_MEMORY_MAX_RAW_CONTENT_SIZE),
    enableSemanticSearch: parseBoolean(process.env.OPENCODE_MEMORY_ENABLE_SEMANTIC_SEARCH),
    embeddingModel: process.env.OPENCODE_MEMORY_EMBEDDING_MODEL,
    embeddingDimensions: parseInteger(process.env.OPENCODE_MEMORY_EMBEDDING_DIMENSIONS),
    semanticSearchMaxResults: parseInteger(process.env.OPENCODE_MEMORY_SEMANTIC_SEARCH_MAX_RESULTS),
    semanticContextMaxResults: parseInteger(process.env.OPENCODE_MEMORY_SEMANTIC_CONTEXT_MAX_RESULTS),
    semanticMinScore: parseNumber(process.env.OPENCODE_MEMORY_SEMANTIC_MIN_SCORE),
    hybridSearchAlpha: parseNumber(process.env.OPENCODE_MEMORY_HYBRID_SEARCH_ALPHA),
    privacyStrip: parseBoolean(process.env.OPENCODE_MEMORY_PRIVACY_STRIP),
    minContentLength: parseInteger(process.env.OPENCODE_MEMORY_MIN_CONTENT_LENGTH),
    compressionBatchSize: parseInteger(process.env.OPENCODE_MEMORY_BATCH_SIZE),
    retentionDays: parseInteger(process.env.OPENCODE_MEMORY_RETENTION_DAYS),
    contextMaxTokens: parseInteger(process.env.OPENCODE_MEMORY_CONTEXT_MAX_TOKENS),
    summaryLookback: parseInteger(process.env.OPENCODE_MEMORY_SUMMARY_LOOKBACK),
    orphanThresholdMs: parseInteger(process.env.OPENCODE_MEMORY_ORPHAN_THRESHOLD_MS),
    queuePollIntervalMs: parseInteger(process.env.OPENCODE_MEMORY_QUEUE_POLL_INTERVAL_MS),
    sessionSummaryDebounceMs: parseInteger(process.env.OPENCODE_MEMORY_SUMMARY_DEBOUNCE_MS),
    logLevel: parseLogLevel(process.env.OPENCODE_MEMORY_LOG_LEVEL),
  }
}

/**
 * Removes keys with undefined values from a partial plugin config.
 *
 * @param value - Partial configuration object.
 * @returns A copy without undefined values.
 */
export function compactConfig(value: PartialPluginConfig): PartialPluginConfig {
  const entries = Object.entries(value).filter((entry): entry is [string, Exclude<unknown, undefined>] => entry[1] !== undefined)
  return Object.fromEntries(entries) as PartialPluginConfig
}

/**
 * Validates and normalizes the merged configuration.
 *
 * @param value - Raw merged plugin configuration.
 * @param runtimeConfig - Current OpenCode runtime config.
 * @returns The normalized plugin configuration.
 */
export function normalizeConfig(
  value: PartialPluginConfig,
  runtimeConfig: Config = {},
): Omit<PluginConfig, "configPaths"> {
  const rawDbPath = value.dbPath ?? DEFAULT_CONFIG.dbPath
  const resolvedDbPath = resolveHomePath(rawDbPath)

  return {
    dbPath: resolvedDbPath,
    indexSize: clampNumber(value.indexSize, 1, 200, DEFAULT_CONFIG.indexSize),
    sampleSize: clampNumber(value.sampleSize, 0, 20, DEFAULT_CONFIG.sampleSize),
    maxPendingRetries: clampNumber(
      value.maxPendingRetries,
      1,
      10,
      DEFAULT_CONFIG.maxPendingRetries,
    ),
    compressionModel:
      value.compressionModel ?? runtimeConfig.small_model ?? runtimeConfig.model ?? null,
    maxRawContentSize: clampNumber(
      value.maxRawContentSize,
      1_000,
      500_000,
      DEFAULT_CONFIG.maxRawContentSize,
    ),
    enableSemanticSearch: value.enableSemanticSearch ?? DEFAULT_CONFIG.enableSemanticSearch,
    embeddingModel: value.embeddingModel?.trim() || DEFAULT_CONFIG.embeddingModel,
    embeddingDimensions: clampNumber(
      value.embeddingDimensions,
      8,
      4_096,
      DEFAULT_CONFIG.embeddingDimensions,
    ),
    semanticSearchMaxResults: clampNumber(
      value.semanticSearchMaxResults,
      1,
      50,
      DEFAULT_CONFIG.semanticSearchMaxResults,
    ),
    semanticContextMaxResults: clampNumber(
      value.semanticContextMaxResults,
      0,
      10,
      DEFAULT_CONFIG.semanticContextMaxResults,
    ),
    semanticMinScore: clampFloat(value.semanticMinScore, 0, 1, DEFAULT_CONFIG.semanticMinScore),
    hybridSearchAlpha: clampFloat(value.hybridSearchAlpha, 0, 1, DEFAULT_CONFIG.hybridSearchAlpha),
    privacyStrip: value.privacyStrip ?? DEFAULT_CONFIG.privacyStrip,
    minContentLength: clampNumber(
      value.minContentLength,
      0,
      10_000,
      DEFAULT_CONFIG.minContentLength,
    ),
    compressionBatchSize: clampNumber(
      value.compressionBatchSize,
      1,
      50,
      DEFAULT_CONFIG.compressionBatchSize,
    ),
    retentionDays: clampNumber(value.retentionDays, 1, 3650, DEFAULT_CONFIG.retentionDays),
    contextMaxTokens: clampNumber(
      value.contextMaxTokens,
      250,
      8_000,
      DEFAULT_CONFIG.contextMaxTokens,
    ),
    summaryLookback: clampNumber(
      value.summaryLookback,
      0,
      20,
      DEFAULT_CONFIG.summaryLookback,
    ),
    orphanThresholdMs: clampNumber(
      value.orphanThresholdMs,
      5_000,
      86_400_000,
      DEFAULT_CONFIG.orphanThresholdMs,
    ),
    queuePollIntervalMs: clampNumber(
      value.queuePollIntervalMs,
      25,
      5_000,
      DEFAULT_CONFIG.queuePollIntervalMs,
    ),
    sessionSummaryDebounceMs: clampNumber(
      value.sessionSummaryDebounceMs,
      0,
      60_000,
      DEFAULT_CONFIG.sessionSummaryDebounceMs,
    ),
    logLevel: value.logLevel ?? DEFAULT_CONFIG.logLevel,
  }
}

/**
 * Parses a numeric environment variable.
 *
 * @param value - Raw environment value.
 * @returns The parsed integer or undefined.
 */
export function parseInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parses a floating-point environment variable.
 *
 * @param value - Raw environment value.
 * @returns The parsed float or undefined.
 */
export function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parses a boolean environment variable.
 *
 * @param value - Raw environment value.
 * @returns The parsed boolean or undefined.
 */
export function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false
  }

  return undefined
}

/**
 * Parses a log level environment variable.
 *
 * @param value - Raw environment value.
 * @returns The normalized log level or undefined.
 */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) {
    return undefined
  }

  const normalized = value.toLowerCase()
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized
  }

  return undefined
}

/**
 * Clamps an optional number into a safe range with a fallback value.
 *
 * @param value - Candidate value.
 * @param minimum - Minimum supported value.
 * @param maximum - Maximum supported value.
 * @param fallback - Fallback when the candidate is invalid.
 * @returns A safe numeric value.
 */
export function clampNumber(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback
  }

  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Clamps an optional float into a safe range with a fallback value.
 *
 * @param value - Candidate value.
 * @param minimum - Minimum supported value.
 * @param maximum - Maximum supported value.
 * @param fallback - Fallback when the candidate is invalid.
 * @returns A safe numeric value.
 */
export function clampFloat(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback
  }

  return Math.max(minimum, Math.min(maximum, value))
}

/**
 * Checks whether a file path exists.
 *
 * @param filePath - Path to inspect.
 * @returns True when the file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
