/**
 * Runtime configuration for the Rewards auto-runner.
 *
 * The defaults here are what the machine was probed with: a real Edge profile
 * reached through a directory junction, a headed 1280x900 window, and the
 * cn.bing.com rewards flyout endpoint. Everything a user might want to move
 * (paths, timings, port range) lives in `DEFAULTS` so a JSON override file can
 * patch it without editing code.
 *
 * The override file sits outside the repository -- it is machine state, not
 * source -- so `loadConfig` tolerates it being absent, empty, or corrupt.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Absolute path of the config file, under %LOCALAPPDATA%. */
export function defaultConfigPath(env = process.env) {
  const base = env.LOCALAPPDATA || join(env.USERPROFILE || '.', 'AppData', 'Local')
  return join(base, 'ms-rewards-auto', 'config.json')
}

/** Directory for logs, the task XML and the profile junction. */
export function stateDir(env = process.env) {
  const base = env.LOCALAPPDATA || join(env.USERPROFILE || '.', 'AppData', 'Local')
  return join(base, 'ms-rewards-auto')
}

/** Default Edge User Data directory for the current machine. */
export function defaultUserDataDir(env = process.env) {
  const base = env.LOCALAPPDATA || join(env.USERPROFILE || '.', 'AppData', 'Local')
  return join(base, 'Microsoft', 'Edge', 'User Data')
}

/**
 * Defaults chosen by measurement, not taste:
 *
 * - `windowSize` 1280x900: a real sized window is what the rewards backend
 *   accepts; a tiny one was never validated for scoring.
 * - `portRange`: 9333 was verified free; the rest is a retry runway.
 * - `maxSearchesPerRun` 6: five searches cap the daily pool (15 points at +3),
 *   the sixth is slack for a search that scores nothing.
 * - `minSearchGapMs`/`maxSearchGapMs`: paced like a human, not a loop.
 */
export const DEFAULTS = Object.freeze({
  edgeExe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  userDataDir: null, // resolved to defaultUserDataDir() when null
  linkDir: null, // resolved to <stateDir>/udlink when null
  port: 9333,
  portRange: 11,
  windowWidth: 1280,
  windowHeight: 900,
  homeUrl: 'https://cn.bing.com/',
  rewardsUrl: 'https://cn.bing.com/rewards/panelflyout/getuserinfo',
  maxSearchesPerRun: 6,
  maxFailures: 2,
  minSearchGapMs: 2500,
  maxSearchGapMs: 6000,
  startDelayMs: 2000,
  debugPortTimeoutMs: 30000,
  closeTimeoutMs: 15000,
  maxRuntimeMs: 12 * 60 * 1000,
  minimize: true,
  focusEmulation: true,
})

/**
 * Merge a plain object over `base`, ignoring `undefined` values.
 *
 * Arrays are replaced rather than merged: a user overriding the query pool
 * means the whole pool, not a patch of it.
 */
export function mergeConfig(base, patch) {
  const out = { ...base }
  if (!patch || typeof patch !== 'object') return out
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * Resolve the null placeholders into absolute paths.
 *
 * Kept separate from `loadConfig` so tests can call it with a fake env instead
 * of depending on the real machine layout.
 */
export function resolveConfig(config, env = process.env) {
  const out = { ...config }
  if (!out.userDataDir) out.userDataDir = defaultUserDataDir(env)
  if (!out.linkDir) out.linkDir = join(stateDir(env), 'udlink')
  return out
}

/**
 * Load config from disk, falling back to defaults.
 *
 * A broken file must not stop a scheduled run -- the whole point is that it
 * runs unattended -- so every failure becomes a `warning` string instead of a
 * throw. Callers log it and carry on with defaults.
 *
 * @param options - `file` overrides the path; `env` overrides the environment.
 * @returns `{ config, warning, source }` where source is `default` or `file`.
 */
export function loadConfig({ file, env = process.env } = {}) {
  const path = file || defaultConfigPath(env)
  const base = resolveConfig(DEFAULTS, env)
  if (!existsSync(path)) return { config: base, warning: null, source: 'default', file: path }
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return {
      config: base,
      warning: `read failed: ${error.message}`,
      source: 'default',
      file: path,
    }
  }
  // A UTF-8 BOM is legal in the file and fatal to JSON.parse; strip it.
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { config: base, warning: null, source: 'default', file: path }
  let parsed = null
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return {
      config: base,
      warning: `invalid JSON: ${error.message}`,
      source: 'default',
      file: path,
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: base, warning: 'config is not an object', source: 'default', file: path }
  }
  return { config: mergeConfig(base, parsed), warning: null, source: 'file', file: path }
}
