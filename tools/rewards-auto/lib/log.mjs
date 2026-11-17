/**
 * Append-only JSONL run log.
 *
 * A scheduled task runs with no console, so the log file is the only evidence
 * of what happened. That makes two properties worth pinning down:
 *
 *   - one JSON object per line, so `Get-Content | ConvertFrom-Json` and any
 *     tail-based reader work;
 *   - a final `summary` record carrying status and point deltas, written even
 *     when the run throws, so a failure is never silent.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Status values a run can end with. Kept as a frozen list for the tests. */
export const RUN_STATUS = Object.freeze([
  'ok',
  'already-full',
  'skipped-edge-busy',
  'not-signed-in',
  'no-progress',
  'closed-with-extra-targets',
  'edge-left-running',
  'failed',
])

/** Compact `yyyyMMdd-HHmmss` stamp, local time. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/** Default log file path for a run starting now. */
export function defaultLogPath(logDir, date = new Date()) {
  return `${logDir}\\run-${stamp(date)}.jsonl`
}

/**
 * Create a logger that appends one JSON object per line.
 *
 * `write` never throws: a logging failure must not turn a successful run into a
 * failed one. The record keeps whatever fields the caller passed, plus `at`.
 *
 * @param options - `file` is required; `onError` receives write failures.
 * @returns `{ file, write, warn, info, error, close }`.
 */
export function createLogger({ file, onError } = {}) {
  if (!file) throw new Error('createLogger: file is required')
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {
    /* the write below will surface the real problem */
  }
  let closed = false
  const write = (record) => {
    if (closed) return false
    const line = JSON.stringify({ at: new Date().toISOString(), ...record })
    try {
      appendFileSync(file, line + '\n', 'utf8')
      return true
    } catch (error) {
      if (typeof onError === 'function') onError(error)
      return false
    }
  }
  return {
    file,
    write,
    info: (message, extra) => write({ level: 'info', message, ...extra }),
    warn: (message, extra) => write({ level: 'warn', message, ...extra }),
    error: (message, extra) => write({ level: 'error', message, ...extra }),
    close: () => {
      closed = true
    },
  }
}

/**
 * Build the final summary record.
 *
 * Kept a pure function so the field set can be asserted without touching disk:
 * `status`, the point deltas and the search count are the four things a human
 * needs to judge a run.
 */
export function summaryRecord({
  status,
  preBalance = null,
  postBalance = null,
  preProgress = null,
  postProgress = null,
  searches = 0,
  durationMs = 0,
  reason = null,
  extra = null,
} = {}) {
  const delta =
    Number.isFinite(preBalance) && Number.isFinite(postBalance) ? postBalance - preBalance : null
  return {
    level: 'summary',
    status,
    preBalance,
    postBalance,
    pointDelta: delta,
    preProgress,
    postProgress,
    searches,
    durationMs,
    reason,
    ...(extra ? { extra } : {}),
  }
}

/**
 * Parse a JSONL log body back into records, skipping unparseable lines.
 *
 * Used by the tests and handy for pointing at a log by hand; a scheduled run
 * never reads its own log.
 */
export function parseLogBody(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      /* a torn last line after a crash is expected; ignore it */
    }
  }
  return out
}

/** Most recent summary record in a parsed log, or null. */
export function lastSummary(records) {
  const list = Array.isArray(records) ? records : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] && list[i].level === 'summary') return list[i]
  }
  return null
}
