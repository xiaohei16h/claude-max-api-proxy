/**
 * Structured JSON logger — zero dependencies.
 *
 * Control via LOG_LEVEL env: "debug" | "info" (default) | "error"
 * Outputs one JSON line per log entry to stdout (info/debug) or stderr (error).
 */

type LogLevel = "debug" | "info" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, error: 2 };

function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "").trim().toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "error") return raw;
  return "info";
}

export function log(
  level: LogLevel,
  tag: string,
  data?: Record<string, unknown>,
): void {
  if (LEVELS[level] < LEVELS[resolveLevel()]) return;
  const entry = { ts: new Date().toISOString(), level, tag, ...data };
  const line = JSON.stringify(entry) + "\n";
  if (level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

/**
 * Truncate base64 image data in a raw NDJSON line to avoid log bloat.
 * Replaces long base64 strings with a length marker.
 */
export function truncateBase64(raw: string, maxLen = 100): string {
  return raw.replace(
    /"data"\s*:\s*"([A-Za-z0-9+/=]{100,})"/g,
    (_match, b64: string) =>
      `"data":"<base64:${b64.length} chars>"`,
  );
}
