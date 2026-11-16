/**
 * Parser for the coursemap `poll.log`.
 *
 * The plugin writes one line per event as `[ISO] message`. The prefix of the
 * message is what identifies the event kind, and the two most interesting kinds
 * are easy to confuse:
 *
 *   fg proc=<进程> title="<标题>"      -- what the foreground window was
 *   browser proc=<进程> cleaned="<标题>" -- a title survived cleaning (a candidate)
 *
 * Only the second one means "this looks like a video worth processing", so the
 * UI must not lump them together.
 */
import { existsSync, readFileSync } from 'node:fs'

/** Event kinds the parser can report. */
export const LOG_KINDS = Object.freeze(['fg', 'browser', 'classify', 'bili', 'error', 'startup', 'done', 'other'])

const LINE_RE = /^\[([^\]]+)\]\s?(.*)$/

/**
 * Classify one log body (the part after the timestamp).
 *
 * @param body - message text without the `[ISO]` prefix.
 * @returns the event kind.
 */
export function kindOf(body) {
  const text = String(body ?? '').trim()
  if (/^fg\b/.test(text)) return 'fg'
  if (/^browser\b/.test(text)) return 'browser'
  if (/^classify\b/.test(text)) return 'classify'
  if (/^bili\b/.test(text)) return 'bili'
  if (/^error\b/.test(text)) return 'error'
  if (/^startup\b/.test(text)) return 'startup'
  if (/^(done|已生成|笔记已生成)\b/.test(text)) return 'done'
  return 'other'
}

/**
 * Pull a `key="value"` field out of a log body.
 *
 * Values may contain quotes escaped as `\"` (the plugin uses JSON.stringify),
 * so this walks the string instead of using a single regex.
 *
 * @param body - message text.
 * @param key - field name such as `title` or `cleaned`.
 * @returns the unescaped value, or null.
 */
export function fieldOf(body, key) {
  const needle = key + '='
  const start = String(body ?? '').indexOf(needle)
  if (start < 0) return null
  let i = start + needle.length
  const text = String(body)
  if (text[i] === '"') {
    i += 1
    let out = ''
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1]
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else out += next
        i += 2
        continue
      }
      if (ch === '"') return out
      out += ch
      i += 1
    }
    return out
  }
  const m = /^([^\s]+)/.exec(text.slice(i))
  return m ? m[1] : null
}

/**
 * Parse one raw log line.
 *
 * @param line - a single line, with or without trailing whitespace.
 * @returns a parsed entry, or null for blank lines.
 */
export function parseLine(line) {
  const raw = String(line ?? '').replace(/\r$/, '')
  if (!raw.trim()) return null
  const m = LINE_RE.exec(raw)
  if (!m) {
    return { at: 0, iso: '', kind: 'other', text: raw.trim(), proc: null, title: null, raw }
  }
  const iso = m[1]
  const body = m[2] ?? ''
  const ms = Date.parse(iso)
  const kind = kindOf(body)
  const proc = fieldOf(body, 'proc')
  const title = fieldOf(body, 'title') ?? fieldOf(body, 'cleaned')
  return {
    at: Number.isFinite(ms) ? ms : 0,
    iso,
    kind,
    text: body.trim(),
    proc: proc || null,
    title: title || null,
    raw,
  }
}

/**
 * Parse a whole log file body.
 *
 * @param text - raw file content.
 * @param options - `limit` keeps only the last N entries.
 * @returns array of parsed entries in file order.
 */
export function parseLog(text, { limit = 0 } = {}) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const entry = parseLine(line)
    if (entry) out.push(entry)
  }
  if (limit > 0 && out.length > limit) return out.slice(out.length - limit)
  return out
}

/**
 * Read and parse the log file, tolerating absence and I/O errors.
 *
 * @param file - absolute log path.
 * @param options - `limit` as in parseLog.
 * @returns `{ entries, size, mtime, missing }`.
 */
export function readLog(file, { limit = 0 } = {}) {
  if (!existsSync(file)) return { entries: [], size: 0, mtime: 0, missing: true }
  let text = ''
  let size = 0
  let mtime = 0
  try {
    text = readFileSync(file, 'utf8')
    size = Buffer.byteLength(text, 'utf8')
    mtime = Date.now()
  } catch {
    return { entries: [], size: 0, mtime: 0, missing: false }
  }
  return { entries: parseLog(text, { limit }), size, mtime, missing: false }
}

/**
 * Summarize what the log says about the near past, for the status bar.
 *
 * `lastForeground` is the most recent `fg` line and `lastCandidate` the most
 * recent `browser` line -- the latter is what the "识别中" indicator follows.
 *
 * @param entries - parsed entries in file order.
 * @returns a compact view.
 */
export function summarize(entries) {
  const list = Array.isArray(entries) ? entries : []
  let lastForeground = null
  let lastCandidate = null
  let lastClassify = null
  let lastBili = null
  let lastError = null
  const counts = Object.create(null)
  for (const entry of list) {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
    if (entry.kind === 'fg') lastForeground = entry
    else if (entry.kind === 'browser') lastCandidate = entry
    else if (entry.kind === 'classify') lastClassify = entry
    else if (entry.kind === 'bili') lastBili = entry
    else if (entry.kind === 'error') lastError = entry
  }
  return { counts, lastForeground, lastCandidate, lastClassify, lastBili, lastError, total: list.length }
}
