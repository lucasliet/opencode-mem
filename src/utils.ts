import { mkdir, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { homedir } from "node:os"
import type { ModelSelection } from "./types"

const COMMENT_BLOCK_START = "/*"
const COMMENT_BLOCK_END = "*/"
const COMMENT_LINE = "//"

/**
 * Creates a sortable identifier using the current timestamp and a UUID.
 *
 * @param now - Function that returns the current epoch time in milliseconds.
 * @returns A lexicographically sortable identifier.
 */
export function createSortableId(now: () => number): string {
  const prefix = now().toString(36).padStart(10, "0")
  return `${prefix}-${crypto.randomUUID()}`
}

/**
 * Estimates token usage using a simple character-based heuristic.
 *
 * @param value - Text that should be converted into an estimated token count.
 * @returns The estimated token count.
 */
export function estimateTokenCount(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

/**
 * Resolves a path that may start with `~` into an absolute filesystem path.
 *
 * @param value - Path to resolve.
 * @returns The resolved absolute or original path.
 */
export function resolveHomePath(value: string): string {
  if (!value.startsWith("~")) {
    return value
  }

  if (value === "~") {
    return homedir()
  }

  return join(homedir(), value.slice(2))
}

/**
 * Returns the default OpenCode config directory using XDG semantics.
 *
 * @returns The resolved OpenCode config directory.
 */
export function getOpenCodeConfigDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) {
    return join(xdg, "opencode")
  }

  return join(homedir(), ".config", "opencode")
}

/**
 * Ensures that the parent directory of a file path exists.
 *
 * @param filePath - File path whose parent should be created.
 * @returns A promise that resolves after the directory exists.
 */
export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

/**
 * Parses a JSON or JSONC file into a typed object.
 *
 * @param filePath - File path to read.
 * @returns The parsed object.
 */
export async function readJsonFile<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, "utf8")
  return JSON.parse(stripJsonComments(contents)) as T
}

/**
 * Removes JSONC line and block comments while preserving string contents.
 *
 * @param value - Raw JSONC string.
 * @returns A JSON string without comments.
 */
export function stripJsonComments(value: string): string {
  let output = ""
  let index = 0
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let quote = '"'

  while (index < value.length) {
    const current = value[index] ?? ""
    const next = value[index + 1] ?? ""

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false
        output += current
      }
      index += 1
      continue
    }

    if (inBlockComment) {
      if (`${current}${next}` === COMMENT_BLOCK_END) {
        inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }

    if (inString) {
      output += current
      if (current === "\\") {
        output += next
        index += 2
        continue
      }
      if (current === quote) {
        inString = false
      }
      index += 1
      continue
    }

    if (`${current}${next}` === COMMENT_LINE) {
      inLineComment = true
      index += 2
      continue
    }

    if (`${current}${next}` === COMMENT_BLOCK_START) {
      inBlockComment = true
      index += 2
      continue
    }

    if (current === '"' || current === "'") {
      inString = true
      quote = current
    }

    output += current
    index += 1
  }

  return output
}

/**
 * Parses a JSON value with a typed fallback.
 *
 * @param value - JSON text or nullish value.
 * @param fallback - Fallback value when parsing fails.
 * @returns The parsed value or the fallback.
 */
export function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback
  }

  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * Serializes any JSON-compatible value.
 *
 * @param value - Value to serialize.
 * @returns A JSON string.
 */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Strips markdown code fences from an LLM response.
 *
 * @param value - Raw model output.
 * @returns The unfenced content.
 */
export function stripMarkdownFences(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("```")) {
    return trimmed
  }

  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/\s*```$/, "").trim()
}

/**
 * Collapses repeated whitespace for more compact storage and prompts.
 *
 * @param value - Raw string.
 * @returns Normalized text.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * Delays execution for a fixed number of milliseconds.
 *
 * @param milliseconds - Delay duration.
 * @returns A promise that resolves after the delay.
 */
export async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Formats a relative time label from a timestamp.
 *
 * @param value - Epoch time in milliseconds.
 * @param now - Reference clock.
 * @returns A relative time label.
 */
export function formatRelativeTime(value: number, now: () => number): string {
  const delta = Math.max(0, now() - value)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (delta < minute) {
    return "just now"
  }

  if (delta < hour) {
    return `${Math.floor(delta / minute)}m ago`
  }

  if (delta < day) {
    return `${Math.floor(delta / hour)}h ago`
  }

  return `${Math.floor(delta / day)}d ago`
}

/**
 * Formats a timestamp as a local ISO-like date time string.
 *
 * @param value - Epoch time in milliseconds.
 * @returns A formatted date time string.
 */
export function formatTimestamp(value: number): string {
  const date = new Date(value)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

/**
 * Builds a safe FTS5 MATCH query from arbitrary user text.
 *
 * @param value - Raw user query.
 * @returns A sanitized FTS5 query string.
 */
export function sanitizeFtsQuery(value: string): string {
  const tokens = value
    .split(/\s+/)
    .map((part) => part.replace(/["*()]/g, " "))
    .flatMap((part) => part.split(/[\/.:_-]+/))
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8)

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" AND ")
}

/**
 * Parses a `provider/model` string into the model object expected by the SDK.
 *
 * @param value - Model string from configuration.
 * @returns A parsed model selection or null when invalid.
 */
export function parseModelString(value: string | null | undefined): ModelSelection | null {
  if (!value) {
    return null
  }

  const separator = value.indexOf("/")
  if (separator <= 0 || separator >= value.length - 1) {
    return null
  }

  return {
    raw: value,
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

/**
 * Converts an absolute path into a worktree-relative path when possible.
 *
 * @param value - Path to normalize.
 * @param worktree - Project root.
 * @returns A relative or original path.
 */
export function normalizeProjectPath(value: string, worktree: string): string {
  if (!value) {
    return value
  }

  if (!isAbsolute(value)) {
    return value
  }

  if (!value.startsWith(worktree)) {
    return value
  }

  return value.slice(worktree.length + Number(!worktree.endsWith("/")))
}

/**
 * Checks whether a string likely contains binary-like output.
 *
 * @param value - Output text to inspect.
 * @returns True when the content should be skipped.
 */
export function isProbablyBinary(value: string): boolean {
  if (!value) {
    return false
  }

  if (value.includes("\u0000")) {
    return true
  }

  const sample = value.slice(0, 2048)
  const controlCharacters = [...sample].filter((character) => {
    const code = character.charCodeAt(0)
    return code < 9 || (code > 13 && code < 32)
  }).length

  return controlCharacters / sample.length > 0.1
}
