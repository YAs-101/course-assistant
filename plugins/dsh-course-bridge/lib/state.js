/**
 * dsh-course-bridge: reading dsh-video-coursemap state and keeping the
 * bridge's own delivery ledger.
 *
 * Everything here except the file helpers is a pure function over plain
 * objects, so the module is unit testable without a host.
 *
 * @module dsh-course-bridge/lib/state
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { keyOf } from './util.js'

/** Ledger schema version written into bridge.json. */
export const BRIDGE_VERSION = 1

/** Delivery attempts before a video is abandoned. */
export const DEFAULT_MAX_ATTEMPTS = 5

/** A fresh, empty ledger. */
export function emptyBridge() {
  return {
    version: BRIDGE_VERSION,
    initialized: false,
    delivered: {},
    pending: {},
    abandoned: {},
    sessions: {},
  }
}

/**
 * Parse the state.json that dsh-video-coursemap writes.
 *
 * A partial or corrupt file is reported instead of thrown so the caller can
 * simply skip this scan: coursemap rewrites the whole file after every
 * successful chain, so the next scan sees a complete document again.
 *
 * @param text - raw file contents.
 * @returns ok flag plus a normalized state object (or null).
 */
export function parseStateText(text) {
  let raw
  try {
    raw = JSON.parse(String(text === undefined || text === null ? '' : text))
  } catch (error) {
    return { ok: false, state: null, reason: 'state.json is not valid JSON: ' + String(error && error.message ? error.message : error) }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, state: null, reason: 'state.json is not an object' }
  }
  const subjects = {}
  const sourceSubjects = raw.subjects && typeof raw.subjects === 'object' && !Array.isArray(raw.subjects) ? raw.subjects : {}
  for (const name of Object.keys(sourceSubjects)) {
    if (!name) continue
    const entry = sourceSubjects[name] && typeof sourceSubjects[name] === 'object' ? sourceSubjects[name] : {}
    const videos = Array.isArray(entry.videos) ? entry.videos.filter((t) => typeof t === 'string' && t.trim() !== '') : []
    subjects[name] = { createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0, videos }
  }
  return {
    ok: true,
    state: {
      subjects,
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
      lastTitle: typeof raw.lastTitle === 'string' ? raw.lastTitle : '',
      lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : 0,
    },
    reason: '',
  }
}

/**
 * Read and parse state.json.
 * @param file - absolute path of state.json.
 */
export function readState(file) {
  if (!existsSync(file)) return { ok: false, state: null, reason: 'state.json does not exist yet' }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, state: null, reason: 'state.json is unreadable: ' + String(error && error.message ? error.message : error) }
  }
  return parseStateText(text)
}

/**
 * Coerce an on-disk ledger into the expected shape, dropping unknown fields
 * from older versions but keeping every known record.
 * @param raw - parsed JSON (any shape).
 */
export function normalizeBridge(raw) {
  const out = emptyBridge()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (typeof raw.version === 'number') out.version = raw.version
  out.initialized = raw.initialized === true
  for (const bucket of ['delivered', 'pending', 'abandoned', 'sessions']) {
    const source = raw[bucket]
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    for (const key of Object.keys(source)) {
      const value = source[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) out[bucket][key] = value
    }
  }
  return out
}

/**
 * Read the bridge ledger, falling back to an empty one when it is missing or
 * unreadable (the ledger is a cache, never the source of truth).
 * @param file - absolute path of bridge.json.
 */
export function readBridge(file) {
  if (!existsSync(file)) return emptyBridge()
  try {
    return normalizeBridge(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return emptyBridge()
  }
}

/**
 * Persist the ledger atomically (temp file + rename) so a crash never leaves a
 * half-written bridge.json behind.
 * @param file - absolute path of bridge.json.
 * @param value - ledger to write.
 */
export function writeBridge(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/**
 * Flatten coursemap's subject → videos map into a stable ordered list.
 * @param state - normalized state.
 */
export function listVideos(state) {
  const out = []
  const subjects = state && state.subjects ? state.subjects : {}
  for (const subject of Object.keys(subjects)) {
    const entry = subjects[subject] || {}
    const videos = Array.isArray(entry.videos) ? entry.videos : []
    for (const title of videos) {
      if (typeof title !== 'string' || title.trim() === '') continue
      out.push({ subject, title, key: keyOf(subject, title), createdAt: entry.createdAt || 0 })
    }
  }
  return out
}

/**
 * Report whether one video already reached a terminal state.
 * @param bridge - normalized ledger.
 * @param key - composite key from {@link keyOf}.
 */
export function isSettled(bridge, key) {
  if (bridge.delivered[key]) return true
  if (bridge.abandoned[key]) return true
  return false
}

/**
 * Videos this scan should deliver, oldest subject order first.
 *
 * A pending record whose nextTryAt lies in the future is skipped, and a
 * record that exhausted its attempts is abandoned instead of retried forever.
 *
 * @param options - videos, ledger, clock, and attempt ceiling.
 * @returns the due entries (never includes settled videos).
 */
export function selectDue({ videos, bridge, now, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const due = []
  for (const video of videos) {
    if (isSettled(bridge, video.key)) continue
    const pending = bridge.pending[video.key]
    const attempts = pending && typeof pending.attempts === 'number' ? pending.attempts : 0
    if (attempts >= maxAttempts) continue
    if (pending && typeof pending.nextTryAt === 'number' && pending.nextTryAt > now) continue
    due.push({ ...video, attempts, nextTryAt: pending && pending.nextTryAt })
  }
  return due
}

/**
 * Record every currently known video as already handled, used for the first
 * run when historical backfill is disabled.
 * @param bridge - ledger to mutate.
 * @param videos - videos to mark.
 * @param now - epoch millis.
 */
export function markAllDelivered(bridge, videos, now) {
  for (const video of videos) {
    if (isSettled(bridge, video.key)) continue
    bridge.delivered[video.key] = {
      subject: video.subject,
      title: video.title,
      sessionId: '',
      docxPath: '',
      at: now,
      skipped: true,
      reason: 'initialBackfill=false: existing video was recorded before the bridge started',
    }
    delete bridge.pending[video.key]
  }
  return bridge
}
