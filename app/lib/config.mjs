/**
 * Persistent settings for the course-assistant app.
 *
 * The file lives next to the code (`app/config.json`) so the whole directory can
 * be copied around as one deliverable. Every write is atomic (temp + rename) and
 * followed by a read-back check, because a half-written config would leave the
 * app unable to start.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CONFIG_PATH, DEFAULT_OUTPUT_DIR } from './paths.mjs'

/**
 * Poll interval bounds, in milliseconds.
 *
 * The lower bound is not arbitrary: one foreground probe spawns PowerShell and
 * takes 1.5-1.7s on this machine, so anything below ~2s makes probes queue up
 * behind each other and the UI would report a cadence the app cannot honour.
 */
export const MIN_POLL_MS = 2000
export const MAX_POLL_MS = 120000

/** Stable defaults; `null` means "detect at runtime". */
export const DEFAULTS = Object.freeze({
  version: 1,
  enabled: false,
  pollIntervalMs: 10000,
  stablePolls: 2,
  titleMinLen: 4,
  fetchContent: true,
  maxTokens: 4096,
  outputDir: DEFAULT_OUTPUT_DIR,
  pythonPath: null,
  coursemapModule: null,
  model: 'deepseek-flash',
  apiKeyFile: null,
  port: 7788,
  enableDeepSplit: false,
  openBrowserOnStart: true,
})

/** Keys the HTTP layer accepts; everything else is rejected instead of silently stored. */
export const EDITABLE_KEYS = Object.freeze([
  'enabled',
  'pollIntervalMs',
  'stablePolls',
  'titleMinLen',
  'fetchContent',
  'maxTokens',
  'outputDir',
  'pythonPath',
  'coursemapModule',
  'model',
  'enableDeepSplit',
])

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Accept an integer inside an inclusive range, or explain why not.
 *
 * Note that this rejects `2.5` outright instead of rounding it: a silent round
 * would let the UI show a value the user never typed, and `stablePolls: 2.5`
 * almost certainly means a typo rather than an intent.
 */
function intInRange(value, min, max, label) {
  if (value === null || value === '' || typeof value === 'boolean') {
    return { ok: false, message: `${label}必须是数字` }
  }
  const n = Number(value)
  if (!Number.isFinite(n)) return { ok: false, message: `${label}必须是数字` }
  if (!Number.isInteger(n)) return { ok: false, message: `${label}必须是整数` }
  if (n < min || n > max) return { ok: false, message: `${label}需在 ${min}–${max} 之间` }
  return { ok: true, value: n }
}

/**
 * Validate one editable setting.
 *
 * @param key - setting name; must be in EDITABLE_KEYS.
 * @param value - raw value from JSON.
 * @returns `{ ok: true, value }` with the normalized value, or `{ ok: false, message }`.
 */
export function validateSetting(key, value) {
  switch (key) {
    case 'enabled':
    case 'fetchContent':
    case 'enableDeepSplit': {
      if (typeof value !== 'boolean') return { ok: false, message: `${key} 必须是 true 或 false` }
      return { ok: true, value }
    }
    case 'pollIntervalMs': {
      const result = intInRange(value, MIN_POLL_MS, MAX_POLL_MS, '轮询间隔（毫秒）')
      if (!result.ok && result.message === '轮询间隔（毫秒）需在 2000–120000 之间') {
        return { ok: false, message: `轮询间隔需在 ${MIN_POLL_MS}–${MAX_POLL_MS} ms 之间` }
      }
      return result
    }
    case 'stablePolls':
      return intInRange(value, 1, 10, '稳定轮数')
    case 'titleMinLen':
      return intInRange(value, 1, 80, '标题最短长度')
    case 'maxTokens':
      return intInRange(value, 256, 32768, 'maxTokens')
    case 'outputDir': {
      if (typeof value !== 'string' || !value.trim()) return { ok: false, message: '输出目录不能为空' }
      return { ok: true, value: value.trim() }
    }
    case 'pythonPath':
    case 'coursemapModule':
    case 'model': {
      if (value === null || value === '') return { ok: true, value: null }
      if (typeof value !== 'string') return { ok: false, message: `${key} 必须是字符串或 null` }
      return { ok: true, value: value.trim() }
    }
    default:
      return { ok: false, message: `未知配置项 "${key}"` }
  }
}

/**
 * Merge a parsed config object over the defaults.
 *
 * Unknown keys are dropped (with a note) rather than throwing, so an older or
 * hand-edited file still boots. Invalid values fall back to the default.
 *
 * @param raw - parsed JSON from disk.
 * @returns `{ config, warnings }`.
 */
export function normalizeConfig(raw) {
  const warnings = []
  const config = { ...DEFAULTS }
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) warnings.push('配置文件不是对象，已使用默认值')
    return { config, warnings }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'version') {
      if (Number.isInteger(value)) config.version = value
      continue
    }
    if (key === 'apiKeyFile' || key === 'port' || key === 'openBrowserOnStart') {
      config[key] = value
      continue
    }
    if (!EDITABLE_KEYS.includes(key)) {
      warnings.push(`忽略未知配置项 "${key}"`)
      continue
    }
    const result = validateSetting(key, value)
    if (result.ok) config[key] = result.value
    else warnings.push(`${key}: ${result.message}（已用默认值）`)
  }
  return { config, warnings }
}

/**
 * Read the config file, falling back to defaults when it is missing or corrupt.
 *
 * @param file - config path (injectable for tests).
 * @returns `{ config, warnings, existed, corrupt }`.
 */
export function readConfig(file = CONFIG_PATH) {
  if (!existsSync(file)) {
    return { config: { ...DEFAULTS }, warnings: [], existed: false, corrupt: false }
  }
  let text = ''
  try { text = readFileSync(file, 'utf8') } catch (error) {
    return { config: { ...DEFAULTS }, warnings: [`读取配置失败：${error?.message ?? error}`], existed: true, corrupt: true }
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) {
    return { config: { ...DEFAULTS }, warnings: [`配置文件不是合法 JSON：${error?.message ?? error}`], existed: true, corrupt: true }
  }
  const { config, warnings } = normalizeConfig(parsed)
  return { config, warnings, existed: true, corrupt: false }
}

/**
 * Write the config atomically and verify the bytes landed.
 *
 * @param config - complete config object to persist.
 * @param file - config path (injectable for tests).
 * @returns `{ ok: true }` or `{ ok: false, message }`.
 */
export function writeConfig(config, file = CONFIG_PATH) {
  const tmp = join(dirname(file), `.config.${process.pid}.${Date.now()}.tmp`)
  const text = JSON.stringify(config, null, 2) + '\n'
  try {
    writeFileSync(tmp, text, 'utf8')
    const back = readFileSync(tmp, 'utf8')
    if (back !== text) throw new Error('写入校验失败：读回内容不一致')
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `保存配置失败：${error?.message ?? error}` }
  }
}

/**
 * Apply a patch of editable settings, returning the merged config.
 *
 * Callers get an error list instead of exceptions so the HTTP layer can report
 * every bad field in one response.
 *
 * @param current - current config.
 * @param patch - object of candidate settings.
 * @returns `{ ok, config, errors }`.
 */
export function applyPatch(current, patch) {
  const errors = []
  const next = { ...current }
  if (!isPlainObject(patch)) return { ok: false, config: current, errors: ['请求体必须是 JSON 对象'] }
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_KEYS.includes(key)) {
      errors.push(`未知配置项 "${key}"`)
      continue
    }
    const result = validateSetting(key, value)
    if (result.ok) next[key] = result.value
    else errors.push(result.message)
  }
  return { ok: errors.length === 0, config: next, errors }
}

/**
 * Has anything that requires rebuilding the engine changed?
 *
 * coursemap captures its config in a closure, so these keys cannot be hot-swapped:
 * the only way to change them is dispose + apply.
 *
 * @param a - previous config.
 * @param b - next config.
 * @returns the list of changed keys that force a rebuild.
 */
export function rebuildKeys(a, b) {
  const keys = ['enabled', 'pollIntervalMs', 'stablePolls', 'titleMinLen', 'fetchContent', 'maxTokens', 'outputDir', 'pythonPath']
  return keys.filter((key) => a?.[key] !== b?.[key])
}
