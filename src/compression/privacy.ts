const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["']?[\w\-./+=]+["']?/gi,
  /(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/g,
  /-----BEGIN\s+[\w\s]+-----[\s\S]*?-----END\s+[\w\s]+-----/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)\b/g,
  /(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi,
]

const PRIVATE_TAGS = [
  /<private>[\s\S]*?<\/private>/gi,
  /<claude-mem-context>[\s\S]*?<\/claude-mem-context>/gi,
]

/**
 * Redacts secrets and privacy tags from tool output before persistence.
 *
 * @param content - Raw tool output.
 * @returns Sanitized content safe for compression.
 */
export function stripSensitiveTokens(content: string): string {
  let sanitized = content

  for (const pattern of PRIVATE_TAGS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]")
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]")
  }

  return sanitized
}
