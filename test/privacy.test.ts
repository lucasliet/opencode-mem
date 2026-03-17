import { describe, expect, test } from "bun:test"
import { stripSensitiveTokens } from "../src/compression/privacy"

describe("privacy stripping", () => {
  test("shouldRedactCommonSecrets", () => {
    const input = [
      "api_key=abc123",
      "Authorization: Bearer very-secret-token",
      "email: user@example.com",
      "AWS key AKIA1234567890ABCD12",
      "jwt eyJabc.def.ghi",
    ].join("\n")

    const output = stripSensitiveTokens(input)
    expect(output.includes("[REDACTED]")).toBe(true)
    expect(output.includes("very-secret-token")).toBe(false)
    expect(output.includes("user@example.com")).toBe(false)
  })

  test("shouldPreserveNormalText", () => {
    const output = stripSensitiveTokens("No credentials here. Just a normal log line.")
    expect(output).toBe("No credentials here. Just a normal log line.")
  })
})
