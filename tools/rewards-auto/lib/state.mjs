/**
 * "Already earned today" marker.
 *
 * The scheduled task fires two minutes after login and then repeats every 30
 * minutes for two hours, so a skipped attempt has a second chance. But a retry
 * that is only there to *read* a score already banked would still launch a real,
 * visible Edge window and close it a few seconds later -- on this machine that
 * looked like the browser randomly popping up an hour after boot, which is worse
 * than not earning the points at all.
 *
 * So a confirmed "today's search pool is full" result is written here and later
 * attempts stop before touching Edge. The retry chain keeps its only remaining
 * purpose: the first attempt was skipped because the user had a window open.
 *
 * Two rules make the marker safe rather than a way to silently lose a day:
 *
 *   - it is keyed by local calendar date, because the daily counter resets at a
 *     fixed point in Microsoft's day and yesterday's marker says nothing about
 *     today;
 *   - it is ignored, and not written, before `TRUST_AFTER_MINUTES` past
 *     midnight, because a machine that boots at 00:05 can still read the
 *     previous day's "15/15" and would then skip the whole day.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Minutes past midnight before a "full" reading is trusted as today's. */
export const TRUST_AFTER_MINUTES = 30

/** Local `yyyy-MM-dd`, the key the daily counter is bucketed by. */
export function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Whole minutes elapsed since local midnight. */
export function minutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * Is it late enough in the day that a "full" reading belongs to today?
 *
 * Before this point a fresh boot may still see the counter Microsoft has not
 * reset yet, so a cached full result would cost the whole day's points.
 */
export function isTrustWindowOpen(date = new Date()) {
  return minutesSinceMidnight(date) >= TRUST_AFTER_MINUTES
}

/**
 * Read the marker, tolerating everything.
 *
 * A missing, empty, torn or foreign file all mean "nothing is known", never an
 * error: this file is an optimisation, and a scheduled run must not fail
 * because of it.
 *
 * @returns the parsed object, or `null`.
 */
export function readDailyState(file) {
  if (!file || !existsSync(file)) return null
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Does the marker say today's points are already earned?
 *
 * `full` must be exactly `true` (a truthy string is not enough -- this file is
 * JSON written by an older or hand-edited version often enough to be strict),
 * the date must match, and the trust window must be open.
 */
export function isKnownFullToday(state, date = new Date()) {
  if (!state || typeof state !== 'object') return false
  if (state.full !== true) return false
  if (state.date !== dayKey(date)) return false
  return isTrustWindowOpen(date)
}

/**
 * Statuses in which a full counter reading is trustworthy enough to cache.
 *
 * All four mean "the endpoint was read and it said the pool was full". The ones
 * left out matter just as much: `no-progress` and `not-signed-in` never observe
 * a full counter, and `failed` is excluded so that one broken run cannot turn
 * into a silently skipped day.
 */
const CACHEABLE_STATUS = new Set([
  'ok',
  'already-full',
  'closed-with-extra-targets',
  'edge-left-running',
])

/**
 * Should this finished run be remembered as "today is done"?
 *
 * Requires both a status that proves the reading happened and a counter that is
 * actually at its maximum.
 *
 * @param status - the run's final status string.
 * @param state - the last rewards state that was read, or null.
 */
export function shouldCacheFull(status, state) {
  if (!CACHEABLE_STATUS.has(status)) return false
  const progress = Number(state?.pcSearch?.progress ?? 0)
  const max = Number(state?.pcSearch?.max ?? 0)
  if (!Number.isFinite(progress) || !Number.isFinite(max) || max <= 0) return false
  return progress >= max
}

/**
 * Coerce a value to a finite number, or null.
 *
 * `Number(null)` and `Number('')` are both `0`, which would silently record a
 * missing balance as zero points. Absence must stay distinguishable from a real
 * zero, so those two inputs are rejected before the numeric check.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Write the marker for `date`.
 *
 * Throws on I/O errors so the caller can log a warning; nothing here should
 * turn a successful run into a failed one.
 */
export function writeDailyState(file, { balance = null, progress = null, max = null } = {}, date = new Date()) {
  if (!file) throw new Error('writeDailyState: file is required')
  const record = {
    date: dayKey(date),
    full: true,
    progress: numberOrNull(progress),
    max: numberOrNull(max),
    balance: numberOrNull(balance),
    at: date.toISOString(),
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8')
  return record
}
