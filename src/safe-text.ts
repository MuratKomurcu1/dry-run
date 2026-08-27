const CREDENTIAL_SCHEMES = ["postgresql://", "postgres://", "https://", "http://", "nats://"] as const;

export function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(start, end);
}

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 45) end -= 1;
  return value.slice(start, end);
}

/** Redacts URL userinfo in arbitrary error text without backtracking regular expressions. */
export function redactUrlCredentials(value: string): string {
  const lower = value.toLowerCase();
  let cursor = 0;
  const output: string[] = [];
  while (cursor < value.length) {
    let schemeIndex = -1;
    let scheme = "";
    for (const candidate of CREDENTIAL_SCHEMES) {
      const index = lower.indexOf(candidate, cursor);
      if (index !== -1 && (schemeIndex === -1 || index < schemeIndex)) {
        schemeIndex = index;
        scheme = candidate;
      }
    }
    if (schemeIndex === -1) {
      output.push(value.slice(cursor));
      break;
    }

    const authorityStart = schemeIndex + scheme.length;
    output.push(value.slice(cursor, authorityStart));
    let authorityEnd = authorityStart;
    let at = -1;
    while (authorityEnd < value.length) {
      const code = value.charCodeAt(authorityEnd);
      const character = value[authorityEnd];
      if (code <= 32 || character === "/" || character === "\\" || character === "?" || character === "#") break;
      if (character === "@") at = authorityEnd;
      authorityEnd += 1;
    }
    if (at >= authorityStart) {
      output.push("[redacted]@");
      cursor = at + 1;
    } else {
      cursor = authorityStart;
    }
  }
  return output.join("");
}

export function isStackTraceField(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "stack" || normalized === "stacktrace" || normalized === "exception.stacktrace" || normalized === "error.stack";
}

export interface MarkdownTextOptions {
  escapeTable?: boolean;
  neutralizeMentions?: boolean;
  code?: boolean;
  maxLength?: number;
}

/**
 * Produces single-line Markdown without regex backtracking or partial escaping.
 * Backslashes are escaped before table separators so an input backslash cannot
 * cancel an escape inserted by this function.
 */
export function sanitizeMarkdownText(value: string, options: MarkdownTextOptions = {}): string {
  const limit = options.maxLength == null ? Number.MAX_SAFE_INTEGER : Math.max(0, options.maxLength);
  let output = "";
  for (let index = 0; index < value.length && output.length < limit; index += 1) {
    const character = value[index];
    let replacement: string;
    if (character === "\r" || character === "\n") {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      replacement = " ";
    } else if (options.code && character === "`") {
      replacement = "'";
    } else if (options.neutralizeMentions && character === "@") {
      replacement = "@\u200b";
    } else if (options.escapeTable && (character === "\\" || character === "|")) {
      replacement = `\\${character}`;
    } else {
      replacement = character;
    }
    if (output.length + replacement.length > limit) break;
    output += replacement;
  }
  return output;
}
