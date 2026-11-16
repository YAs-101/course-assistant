/**
 * dsh-course-bridge: shared helpers.
 *
 * Pure functions only -- no host services, no fs, so they are directly unit
 * testable from node:test.
 *
 * @module dsh-course-bridge/lib/util
 */
import { createHash } from 'node:crypto'

/** Characters Windows forbids in a file name, plus control characters. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Turn an arbitrary title into a Windows-safe file name stem.
 *
 * Truncation counts code points (not UTF-16 units) so a surrogate pair such as
 * an emoji is never cut in half; a stem that collapses to nothing falls back to
 * "untitled" so callers always get a usable name.
 *
 * @param raw - the title to sanitize.
 * @param maxLen - maximum number of code points to keep.
 * @returns a non-empty file name stem.
 */
export function safeName(raw, maxLen = 40) {
  let s = String(raw === undefined || raw === null ? '' : raw)
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return 'untitled'
  const points = Array.from(s)
  if (points.length > maxLen) s = points.slice(0, maxLen).join('').trim()
  return s || 'untitled'
}

/**
 * Stable short digest for a string, used to keep long paths bounded.
 * @param raw - input value.
 * @returns the first 8 hex characters of its sha256.
 */
export function hash8(raw) {
  return createHash('sha256').update(String(raw === undefined || raw === null ? '' : raw), 'utf8').digest('hex').slice(0, 8)
}

/**
 * Minute-resolution local timestamp, e.g. 20261116-1930.
 * @param when - date or epoch millis; defaults to now.
 */
export function stamp(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when)
  return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes())
}

/**
 * Second-resolution local timestamp, e.g. 20261116-193045.
 * @param when - date or epoch millis; defaults to now.
 */
export function stampFull(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when)
  return stamp(d) + pad2(d.getSeconds())
}

/** Separator that never occurs in a subject or a video title. */
export const KEY_SEP = '\u0000'

/**
 * Composite identity of one (subject, title) pair.
 * @param subject - subject name as recorded by coursemap.
 * @param title - video title as recorded by coursemap.
 */
export function keyOf(subject, title) {
  return String(subject || '') + KEY_SEP + String(title || '')
}

/**
 * Split a composite key back into its parts.
 * @param key - value produced by {@link keyOf}.
 */
export function splitKey(key) {
  const s = String(key || '')
  const at = s.indexOf(KEY_SEP)
  if (at < 0) return { subject: s, title: '' }
  return { subject: s.slice(0, at), title: s.slice(at + KEY_SEP.length) }
}

/**
 * Normalize an unknown thrown value into a bounded log-safe message.
 * @param error - anything that was thrown.
 * @param maxLen - maximum characters to keep.
 */
export function errText(error, maxLen = 500) {
  const s = error && error.message ? String(error.message) : String(error)
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}
