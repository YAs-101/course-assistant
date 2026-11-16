/**
 * Path resolution for the course-assistant app.
 *
 * Everything here is pure except the two "discover" helpers, which only read
 * the filesystem. No writes happen in this module so it stays trivially
 * testable and cannot damage the knowledge map by being imported.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The `app/` directory itself (this file lives in `app/lib/`). */
export const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Default knowledge-map directory: a sibling of `app/`, which is where the
 * coursemap plugin in this workspace already writes.
 */
export const DEFAULT_OUTPUT_DIR = join(dirname(APP_DIR), '课程知识地图')

/** Where the app keeps its own state: lock, log, port, probe output. */
export const RUNTIME_DIR = join(APP_DIR, '.runtime')

/** Persistent user settings. */
export const CONFIG_PATH = join(APP_DIR, 'config.json')

/** Static assets served at the site root. */
export const PUBLIC_DIR = join(APP_DIR, 'public')

/**
 * Bundled copy of the coursemap plugin.
 *
 * The app ships the upstream plugin (MIT) so that a fresh clone works on a
 * machine that has never installed DeepSeek Harness.
 */
export const VENDOR_DIR = join(APP_DIR, 'vendor')

/** Fallback knowledge-map location used by the coursemap plugin defaults. */
export function homeOutputDir(home = homedir()) {
  return join(home, '课程知识地图')
}

/**
 * Resolve a user-supplied relative path against a root directory.
 *
 * Returns `{ ok: true, path }` when the result stays inside `root`, and
 * `{ ok: false, reason }` otherwise. Both `..` traversal and absolute inputs
 * are rejected: the HTTP layer only ever hands over relative paths.
 *
 * @param root - absolute directory that acts as the boundary.
 * @param rel - untrusted relative path from a query string or JSON body.
 * @returns resolution result with an absolute path when allowed.
 */
export function resolveInside(root, rel) {
  if (typeof root !== 'string' || !root.trim()) return { ok: false, reason: '根目录未配置' }
  if (typeof rel !== 'string') return { ok: false, reason: '路径必须是字符串' }
  const cleaned = rel.replace(/^[\\/]+/, '').replace(/\//g, sep)
  if (!cleaned.trim()) return { ok: false, reason: '路径为空' }
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return { ok: false, reason: '不允许绝对路径' }
  if (cleaned.split(sep).includes('..')) return { ok: false, reason: '不允许上级目录' }
  const base = resolve(root)
  const target = resolve(base, cleaned)
  if (!isInside(base, target)) return { ok: false, reason: '路径越出允许范围' }
  return { ok: true, path: target }
}

/**
 * Is `target` the same as, or below, `base`?
 *
 * Comparison is case-insensitive on Windows and uses a separator-aware prefix
 * test so `/a/bc` is not treated as inside `/a/b`.
 *
 * @param base - boundary directory.
 * @param target - candidate absolute path.
 * @returns true when target is inside base.
 */
export function isInside(base, target) {
  const a = normalize(resolve(base))
  const b = normalize(resolve(target))
  const rel = relative(a, b)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return !rel.split(sep).includes('..')
}

/**
 * Join a root with path segments, refusing anything that escapes.
 *
 * @param root - boundary directory.
 * @param segments - path segments (may contain Chinese or emoji).
 * @returns absolute path, or null when the join would escape the root.
 */
export function joinInside(root, ...segments) {
  const rel = segments.filter((s) => s !== undefined && s !== null && String(s) !== '').join(sep)
  const result = resolveInside(root, rel)
  return result.ok ? result.path : null
}

/**
 * Locate the coursemap plugin module.
 *
 * Order: an explicit override from config wins; then the copy bundled inside
 * `app/vendor/` (so a fresh clone works without DSH); then whatever the host
 * profile installed under `~/.dsh/profiles/<name>/node_modules/`.
 *
 * @param override - explicit module path from config, or null.
 * @param home - home directory (injectable for tests).
 * @param appDir - the app directory holding `vendor/` (injectable for tests).
 * @returns the module path and the list of candidates that were probed.
 */
export function findCoursemapModule(override = null, home = homedir(), appDir = APP_DIR) {
  const candidates = []
  if (override && String(override).trim()) candidates.push(String(override).trim())
  // Bundled copy before the profile copy: it is the only candidate that exists
  // on a machine that has never run DeepSeek Harness.
  candidates.push(join(appDir, 'vendor', 'dsh-video-coursemap', 'lib', 'index.js'))
  const profilesDir = join(home, '.dsh', 'profiles')
  if (existsSync(profilesDir)) {
    let names = []
    try { names = readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { names = [] }
    // `desktop` first: that is the profile in use on this machine, and probing
    // it first keeps the picked module stable if other profiles appear.
    names.sort((a, b) => (a === 'desktop' ? -1 : b === 'desktop' ? 1 : a.localeCompare(b)))
    for (const name of names) {
      candidates.push(join(profilesDir, name, 'node_modules', 'dsh-video-coursemap', 'lib', 'index.js'))
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { ok: true, path: candidate, candidates }
  }
  return { ok: false, path: null, candidates }
}

/**
 * Locate the `dsh-course-bridge` plugin (used for B站素材 + AI 总结).
 *
 * The sibling `plugins/` folder is where this workspace keeps it; the vendored
 * copy inside the app is a fallback for a standalone clone.
 *
 * @param appDir - the app directory; its parent holds `plugins/`.
 * @returns absolute plugin directory, or null.
 */
export function findBridgeDir(appDir = APP_DIR) {
  const candidates = [
    join(dirname(appDir), 'plugins', 'dsh-course-bridge'),
    join(appDir, 'vendor', 'dsh-course-bridge')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
