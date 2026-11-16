/**
 * The polling engine: the coursemap plugin, driven from a plain Node process.
 *
 * `dsh-video-coursemap` is a normal ES module whose `apply(ctx, config)` only
 * touches five host members (`ctx.get('agentDefaultModel')`, `ctx.llm.stream`,
 * `ctx.llm.listProviders`, `ctx.tools.register`, `ctx.effect`). Faking those lets
 * the exact upstream implementation run here -- polling, title cleaning, the
 * browser whitelist, LLM classification, markdown generation, md2docx conversion
 * and the knowledge-map overview -- with no DeepSeek Harness in the loop.
 *
 * Two behaviours of `apply` shape this module:
 *
 * 1. It captures `config` in a closure, so nothing can be hot-swapped: changing
 *    the interval, the output directory or the on/off switch means dispose and
 *    apply again (measured at ~0.5s).
 * 2. It regenerates every subject's Word file on startup, which is slow-ish for
 *    many subjects, so rebuilds are serialized and reported with their duration.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { APP_DIR, findCoursemapModule, RUNTIME_DIR } from './paths.mjs'
import { findPythonSync } from './python.mjs'

/** Lock/heartbeat file that keeps two pollers from corrupting state.json. */
export const LOCK_PATH = join(RUNTIME_DIR, 'app.lock.json')

/** How long a lock may go unrefreshed before another process may steal it. */
export const LOCK_STALE_MS = 15000

/** Liveness window for the bridge's heartbeat file. */
export const BRIDGE_ALIVE_MS = 15000

function ensureRuntimeDir() {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true })
}

function readJsonQuiet(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  ensureRuntimeDir()
  const tmp = file + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/**
 * Is a process with this pid still running?
 *
 * `process.kill(pid, 0)` is the portable check; on Windows a non-existent pid
 * throws ESRCH, which is exactly what we want to detect.
 *
 * @param pid - candidate pid.
 * @returns true when it looks alive.
 */
export function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (n === process.pid) return true
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Acquire the single-writer lock.
 *
 * @param options - now(), path; both injectable for tests.
 * @returns `{ ok, mode, holder }` where mode is `owned` or `busy`.
 */
export function acquireLock({ now = Date.now, path = LOCK_PATH } = {}) {
  const at = now()
  const existing = readJsonQuiet(path)
  if (existing) {
    const age = at - Number(existing.at ?? 0)
    const live = pidAlive(existing.pid)
    if (live && existing.pid !== process.pid && age < LOCK_STALE_MS) {
      return { ok: false, mode: 'busy', holder: existing }
    }
  }
  writeJsonAtomic(path, { pid: process.pid, at, app: APP_DIR })
  return { ok: true, mode: 'owned', holder: { pid: process.pid, at } }
}

/**
 * Refresh the lock timestamp (called on a timer while running).
 *
 * @param options - now(), path.
 * @returns nothing.
 */
export function touchLock({ now = Date.now, path = LOCK_PATH } = {}) {
  const existing = readJsonQuiet(path)
  if (existing && existing.pid !== process.pid) return
  writeJsonAtomic(path, { pid: process.pid, at: now(), app: APP_DIR })
}

/**
 * Remove the lock if this process owns it.
 *
 * @param options - path.
 * @returns nothing.
 */
export function releaseLock({ path = LOCK_PATH } = {}) {
  const existing = readJsonQuiet(path)
  if (existing && existing.pid !== process.pid) return
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

/**
 * Report who (if anyone) holds the lock, without taking it.
 *
 * @param options - now(), path.
 * @returns `{ state: 'free'|'ours'|'held'|'stale', holder }`.
 */
export function lockState({ now = Date.now, path = LOCK_PATH } = {}) {
  const existing = readJsonQuiet(path)
  if (!existing) return { state: 'free', holder: null }
  if (existing.pid === process.pid) return { state: 'ours', holder: existing }
  const age = now() - Number(existing.at ?? 0)
  const live = pidAlive(existing.pid)
  if (live && age < LOCK_STALE_MS) return { state: 'held', holder: existing }
  return { state: 'stale', holder: existing }
}

/**
 * Build the fake Cordis context the plugin expects.
 *
 * Tools are collected rather than registered with a host, so `scan()` can call
 * them afterwards; `effect` runs the provided initializer immediately and keeps
 * its disposer, which is what makes `dispose()` able to stop the interval.
 *
 * @param options - llm service, model selection, log sink.
 * @returns `{ ctx, tools, disposers, dispose, getTool }`.
 */
export function createFakeContext({ llm, selection = null, log = () => {} } = {}) {
  const tools = new Map()
  const disposers = []
  let disposed = false

  const permissions = {
    registerTool(def) {
      if (!def || typeof def.name !== 'string') throw new Error('工具定义缺少 name')
      tools.set(def.name, def)
      log(`已注册工具 ${def.name}`)
      return () => { tools.delete(def.name) }
    },
  }

  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') {
        return {
          currentSelection: () => selection ?? { provider: 'deepseek', model: 'deepseek-flash' },
        }
      }
      return undefined
    },
    llm,
    // `ctx.llm` must exist as a property *and* through get(): coursemap uses the
    // former, the bridge summarizer uses the latter.
    tools: {
      register: (def) => permissions.registerTool(def),
    },
    effect(fn, label) {
      if (disposed) return () => {}
      let disposer = null
      try {
        disposer = fn()
      } catch (error) {
        throw new Error(`初始化失败${label ? `（${label}）` : ''}：${error?.message ?? error}`)
      }
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {
        if (typeof disposer === 'function') {
          try { disposer() } catch { /* ignore */ }
        }
      }
    },
    on() { return () => {} },
    emit() {},
    logger: { info: log, warn: log, error: log, debug: () => {} },
  }

  return {
    ctx,
    tools,
    getTool: (name) => tools.get(name) ?? null,
    get disposerCount() { return disposers.length },
    dispose() {
      disposed = true
      while (disposers.length) {
        const fn = disposers.pop()
        try { fn() } catch { /* keep disposing */ }
      }
      tools.clear()
    },
  }
}

/**
 * Import the coursemap module, tolerating non-ASCII paths and drive letters.
 *
 * @param modulePath - absolute path to `lib/index.js`.
 * @returns the module namespace.
 */
export async function importCoursemap(modulePath) {
  if (!modulePath || !existsSync(modulePath)) {
    throw new Error(`找不到课程插件：${modulePath ?? '未自动发现'}（请在设置的「课程插件路径」里指定 lib/index.js）`)
  }
  const url = pathToFileURL(modulePath).href
  const mod = await import(url)
  const target = mod?.default ?? mod
  if (typeof target?.apply !== 'function') throw new Error('课程插件没有导出 apply()')
  return target
}

/**
 * The engine: one coursemap instance at a time, rebuildable.
 *
 * @param options - config getter, llm service, log sink.
 */
export function createEngine({ getConfig, llm, log = () => {} } = {}) {
  let instance = null
  let current = null
  let lastError = null
  let lastStartAt = 0
  let lastRebuildMs = 0
  let starting = null
  const startedAt = Date.now()

  /**
   * Start (or restart) the plugin with the given config.
   *
   * @param config - full app config; only engine-relevant keys are forwarded.
   * @returns `{ ok, ms, error }`.
   */
  async function start(config) {
    const began = Date.now()
    if (instance) {
      try { instance.context.dispose() } catch { /* ignore */ }
      instance = null
    }
    lastError = null
    // Created before the try block so a failure anywhere after `apply` has begun
    // can still release it. This is not hypothetical: a plugin that registers its
    // polling interval and then throws leaves a live `setInterval` behind, and a
    // live interval keeps the whole Node process from ever exiting.
    // `coursemapModule` is null by default and the plugin ships inside a DSH
    // profile, so fall back to discovery. Without this the switch could never be
    // turned on unless the user typed an absolute path into settings by hand.
    const modulePath = config.coursemapModule || current?.modulePath || findCoursemapModule().path
    const createFake = createFakeContext({
      llm,
      selection: { provider: 'deepseek', model: config.model || 'deepseek-flash' },
      log,
    })
    try {
      const mod = await importCoursemap(modulePath)
      const pluginConfig = {
        enabled: Boolean(config.enabled),
        pollIntervalMs: config.pollIntervalMs,
        stablePolls: config.stablePolls,
        titleMinLen: config.titleMinLen,
        fetchContent: Boolean(config.fetchContent),
        maxTokens: config.maxTokens,
        outputDir: config.outputDir,
        provider: 'deepseek',
        model: config.model || 'deepseek-flash',
      }
      // The real plugin's return value is undefined, so nothing may depend on it.
      const returned = await mod.apply(createFake.ctx, pluginConfig)
      instance = { context: createFake, modulePath, pluginConfig, returned }
      current = { modulePath, startedAt: Date.now() }
      lastStartAt = Date.now()
      lastRebuildMs = lastStartAt - began
      log(`引擎已启动：每 ${pluginConfig.pollIntervalMs}ms 轮询，输出目录 ${pluginConfig.outputDir}（耗时 ${lastRebuildMs}ms）`)
      return { ok: true, ms: lastRebuildMs, error: null }
    } catch (error) {
      try { createFake.dispose() } catch { /* ignore */ }
      lastError = `${error?.message ?? error}`.slice(0, 1000)
      log(`引擎启动失败：${lastError}`)
      return { ok: false, ms: Date.now() - began, error: lastError }
    }
  }

  /**
   * Stop the plugin (clears its interval and unregisters its tools).
   *
   * @returns nothing.
   */
  function stop() {
    if (!instance) return
    try { instance.context.dispose() } catch { /* ignore */ }
    instance = null
    log('引擎已停止')
  }

  /**
   * Rebuild from the current config, coalescing concurrent requests.
   *
   * @returns `{ ok, ms, error }`.
   */
  async function rebuild() {
    if (starting) await starting.catch(() => {})
    const config = getConfig()
    starting = start(config)
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  /**
   * Run one tool by name, if it was registered.
   *
   * @param name - `course_map_scan` or `course_map_status`.
   * @param args - tool arguments.
   * @returns the tool result, or an error object.
   */
  async function callTool(name, args = {}) {
    const tool = instance?.context?.getTool(name)
    if (!tool) return { ok: false, message: `工具 ${name} 未注册（引擎未启动或已停用）` }
    try {
      return await tool.execute(args)
    } catch (error) {
      return { ok: false, message: `${error?.message ?? error}`.slice(0, 800) }
    }
  }

  /**
   * Snapshot of engine health for the status endpoint.
   *
   * @returns a plain object.
   */
  function describe() {
    return {
      running: Boolean(instance),
      tools: instance ? [...instance.context.tools.keys()] : [],
      modulePath: instance?.modulePath ?? current?.modulePath ?? null,
      pollIntervalMs: instance?.pluginConfig?.pollIntervalMs ?? null,
      enabled: instance?.pluginConfig?.enabled ?? null,
      lastStartAt,
      lastRebuildMs,
      lastError,
      uptimeMs: Date.now() - startedAt,
      error: lastError,
    }
  }

  return { start, stop, rebuild, callTool, describe, get instance() { return instance } }
}

/**
 * Run the plugin's own foreground probe once and time it.
 *
 * This exists because `poll.log` deduplicates repeated observations of the same
 * window: with the window unchanged, the log stops growing, so "did polling
 * happen?" cannot be answered from the log alone. Timing a probe directly gives
 * the UI a positive signal (and matches the 1.5-1.7s cost the interval must
 * respect).
 *
 * @param outputDir - knowledge-map root, where `poll.ps1` lives.
 * @param options - timeoutMs.
 * @returns `{ ok, proc, title, ms, error }`.
 */
export function probeForeground(outputDir, { timeoutMs = 12000 } = {}) {
  const stateDir = join(outputDir, '.state')
  const script = join(stateDir, 'poll.ps1')
  const outFile = join(RUNTIME_DIR, 'probe-out.txt')
  if (!existsSync(script)) {
    return { ok: false, proc: '', title: '', ms: 0, error: 'poll.ps1 不存在：请先让引擎成功启动一次（插件启动时才会写这个脚本）' }
  }
  ensureRuntimeDir()
  const began = Date.now()
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-OutFile', outFile,
  ], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
  const ms = Date.now() - began
  if (result.error) {
    return { ok: false, proc: '', title: '', ms, error: `执行 poll.ps1 失败：${result.error.message}` }
  }
  let text = ''
  try { text = readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '') } catch { text = '' }
  const title = (text.match(/^TITLE=(.*)$/m)?.[1] ?? '').trim()
  const proc = (text.match(/^PROC=(.*)$/m)?.[1] ?? '').trim()
  if (!proc && !title) {
    return { ok: false, proc, title, ms, error: `没有读到前台窗口（退出码 ${result.status}）` }
  }
  return { ok: true, proc, title, ms, error: null }
}

/**
 * Compare the app's polling against any other writer (the DSH-hosted plugin).
 *
 * The knowledge map's `poll-out.txt` is rewritten on every probe, so a fresh
 * mtime while *this* process is not polling means somebody else is.
 *
 * @param outputDir - knowledge-map root.
 * @param options - now (a timestamp, or a function returning one), ownPolling flag, intervalMs.
 * @returns `{ foreign: boolean, mtime, ageMs }`.
 */
export function detectForeignPolling(outputDir, { now = Date.now, ownPolling = false, intervalMs = 10000 } = {}) {
  const outFile = join(outputDir, '.state', 'poll-out.txt')
  if (!existsSync(outFile)) return { foreign: false, mtime: 0, ageMs: null }
  let mtime = 0
  try {
    mtime = statSync(outFile).mtimeMs
  } catch {
    mtime = 0
  }
  if (!mtime) return { foreign: false, mtime: 0, ageMs: null }
  // `now` is a function by default and a timestamp from some callers; accept both
  // so a caller passing `Date.now()` cannot turn the clock into a hard crash.
  const at = typeof now === 'function' ? now() : Number(now) || Date.now()
  const ageMs = Math.max(0, at - mtime)
  const window = Math.max(5000, intervalMs + 5000)
  return { foreign: !ownPolling && ageMs < window, mtime, ageMs }
}

/**
 * Resolve the Python interpreter to use for md2docx.
 *
 * @param configured - explicit path from settings.
 * @returns `{ path, source }`; path may be null.
 */
export function resolvePython(configured) {
  if (configured && existsSync(configured)) return { path: configured, source: 'config' }
  return findPythonSync()
}
