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
