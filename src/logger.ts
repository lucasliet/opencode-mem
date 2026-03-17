import type { OpencodeClient } from "@opencode-ai/sdk"
import type { LogLevel } from "./types"

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

/**
 * Writes structured log entries through the OpenCode SDK client.
 */
export class MemoryLogger {
  constructor(
    private readonly client: OpencodeClient,
    private readonly directory: string,
    private readonly level: LogLevel,
  ) {}

  /**
   * Writes a debug log entry.
   *
   * @param message - Human readable message.
   * @param extra - Additional structured metadata.
   * @returns A promise that resolves when the log attempt completes.
   */
  async debug(message: string, extra?: Record<string, unknown>): Promise<void> {
    await this.write("debug", message, extra)
  }

  /**
   * Writes an info log entry.
   *
   * @param message - Human readable message.
   * @param extra - Additional structured metadata.
   * @returns A promise that resolves when the log attempt completes.
   */
  async info(message: string, extra?: Record<string, unknown>): Promise<void> {
    await this.write("info", message, extra)
  }

  /**
   * Writes a warning log entry.
   *
   * @param message - Human readable message.
   * @param extra - Additional structured metadata.
   * @returns A promise that resolves when the log attempt completes.
   */
  async warn(message: string, extra?: Record<string, unknown>): Promise<void> {
    await this.write("warn", message, extra)
  }

  /**
   * Writes an error log entry.
   *
   * @param message - Human readable message.
   * @param extra - Additional structured metadata.
   * @returns A promise that resolves when the log attempt completes.
   */
  async error(message: string, extra?: Record<string, unknown>): Promise<void> {
    await this.write("error", message, extra)
  }

  /**
   * Writes a log entry if the requested level is enabled.
   *
   * @param level - Log level for the entry.
   * @param message - Human readable message.
   * @param extra - Additional structured metadata.
   * @returns A promise that resolves when the log attempt completes.
   */
  async write(level: LogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.shouldLog(level)) {
      return
    }

    await this.client.app.log({
      query: { directory: this.directory },
      body: {
        service: "plugin-memory",
        level,
        message,
        extra,
      },
    })
  }

  /**
   * Checks whether a log level should be emitted.
   *
   * @param level - Candidate log level.
   * @returns True when the entry should be logged.
   */
  shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level]
  }
}
