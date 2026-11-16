#!/usr/bin/env node
/**
 * Entry point: boot the app, start listening, optionally open a browser.
 *
 * The first statement sets `PYTHONIOENCODING` before anything spawns Python.
 * That single variable is what makes `md2docx.py` survivable on this machine: the
 * script prints the output path at the end, and any non-GBK character in a video
 * title (emoji are common) makes that print raise `UnicodeEncodeError` under the
 * default GBK console encoding, so the conversion "fails" after having actually
 * written a valid file. The plugin spawns Python with an inherited environment,
 * so setting it here fixes the conversion without touching the plugin.
 */
process.env.PYTHONIOENCODING = 'utf-8'

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'

import { DEFAULTS, MIN_POLL_MS, readConfig, writeConfig } from './lib/config.mjs'
import { acquireLock, detectForeignPolling, lockState, releaseLock, touchLock } from './lib/engine.mjs'
import { DEFAULT_CREDENTIALS, loadApiKey } from './lib/llm.mjs'
import { APP_DIR, findCoursemapModule, RUNTIME_DIR } from './lib/paths.mjs'
import { resolvePython } from './lib/engine.mjs'
import { createAppServer } from './server.mjs'

const args = process.argv.slice(2)

function flag(name) {
  return args.includes(name)
}

function argValue(name) {
  const idx = args.indexOf(name)
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1]
  const eq = args.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : null
}

function say(text) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  process.stdout.write(`[${stamp}] ${text}\n`)
}

/**
 * Is a TCP port free on loopback?
 *
 * @param port - candidate port.
 * @returns true when nothing is listening.
 */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '127.0.0.1')
  })
}

/**
 * Ask an already-running instance for its status.
 *
 * Used to turn a double launch into "focus the existing window" instead of a
 * confusing port error.
 *
 * @param port - port to probe.
 * @returns the status payload or null.
 */
async function probeRunning(port) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) return null
    const data = await response.json()
    return data?.app?.name === '课程助手' ? data : null
  } catch {
    return null
  }
}

/**
 * Open a URL in the default browser without a shell.
 *
 * @param url - target URL.
 */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
    }
  } catch (error) {
    say(`无法自动打开浏览器：${error?.message ?? error}`)
  }
}

/**
 * Pick a port, honouring an explicit request before falling back to the next free one.
 *
 * @param wanted - configured port.
 * @param explicit - port from the command line, if any.
 * @returns `{ port, shifted }`.
 */
async function choosePort(wanted, explicit) {
  const start = Number(explicit ?? wanted) || 7788
  if (await portFree(start)) return { port: start, shifted: false }
  if (explicit) throw new Error(`端口 ${start} 已被占用`)
  for (let port = start + 1; port <= start + 12; port += 1) {
    if (await portFree(port)) return { port, shifted: true }
  }
  throw new Error(`端口 ${start}–${start + 12} 都被占用，请用 --port 指定其它端口`)
}

async function main() {
  const loaded = readConfig()
  const config = loaded.config
  const requestedPort = argValue('--port')
  const noOpen = flag('--no-open')

  // Guard against two pollers writing state.json at the same time. A second
  // instance still serves the UI (read-only), which is more useful than refusing.
  const lock = acquireLock()
  const ownsPolling = lock.ok
  if (!ownsPolling) {
    say(`另一个课程助手进程正在运行（pid ${lock.holder?.pid}），本实例将以只读观察模式启动`)
  }

  let chosen
  try {
    chosen = await choosePort(config.port, requestedPort)
  } catch (error) {
    say(`${error?.message ?? error}`)
    if (!ownsPolling) releaseLock()
    process.exitCode = 1
    return
  }

  if (chosen.shifted) say(`端口 ${config.port} 被占用，改用 ${chosen.port}`)

  const app = createAppServer({ config, port: chosen.port, log: (text) => say(text) })
  let url
  try {
    const listening = await app.listen()
    url = listening.url
  } catch (error) {
    say(`启动失败：${error?.message ?? error}`)
    if (ownsPolling) releaseLock()
    process.exitCode = 1
    return
  }

  // Discovery report: these are the three things that actually decide whether the
  // app can do its job, so say them once at boot instead of burying them in the UI.
  const coursemap = findCoursemapModule(config.coursemapModule)
  const python = resolvePython(config.pythonPath)
  const credentials = loadApiKey(config.apiKeyFile || DEFAULT_CREDENTIALS)
  say(`课程助手已启动：${url}`)
  say(`  工作目录   ${APP_DIR}`)
  say(`  知识地图   ${config.outputDir}`)
  say(`  课程插件   ${coursemap.ok ? coursemap.path : '未找到（设置里可手动指定）'}`)
  say(`  Python    ${python.path ?? '未找到（Word 转换不可用）'}${python.version ? ` · ${python.version}` : ''}`)
  say(`  DeepSeek  ${credentials.key ? '已就绪' : credentials.reason}`)
  say(`  轮询间隔   ${config.pollIntervalMs}ms（下限 ${MIN_POLL_MS}ms）· 开关 ${config.enabled ? '开' : '关'}`)
  // The DSH-hosted copy of the same plugin may be polling the same knowledge map.
  // Our lock only knows about other instances of *this* app, so a fresh
  // poll-out.txt written by somebody else means a second poller exists and would
  // append duplicate videos to the same handbook.
  const foreign = detectForeignPolling(config.outputDir, {
    ownPolling: false,
    intervalMs: config.pollIntervalMs,
  })
  say(`  轮询归属   ${ownsPolling ? '本实例' : `其它进程（pid ${lock.holder?.pid}）`}`)
  if (foreign.foreign) {
    say(`  注意      DeepSeek Harness 里的课程插件也在轮询同一份知识地图（${Math.round((foreign.ageMs ?? 0) / 1000)}s 前刚写过），`
      + '同时开启会重复追加视频')
  }

  if (config.enabled && ownsPolling && !foreign.foreign) {
    const result = await app.engine.start(config)
    if (result.ok) say(`引擎已随配置启动（${result.ms}ms）`)
    else say(`引擎启动失败：${result.error}`)
  } else if (config.enabled && !ownsPolling) {
    say('配置里开关是打开的，但本实例不持有轮询权，已跳过自动启动')
  } else if (config.enabled && foreign.foreign) {
    // Refusing to double-poll is the safe default; the switch in the UI still works
    // if the user knows the other copy is off.
    say('配置里开关是打开的，但检测到另一个轮询者，已跳过自动启动')
  }

  if (!noOpen && config.openBrowserOnStart) openBrowser(url)

  const heartbeat = setInterval(touchLock, 5000)
  heartbeat.unref?.()

  // Keep the first-boot experience honest: if config.json was created now, it was
  // written with defaults, and the user should know where to change them.
  if (!loaded.existed) {
    const written = writeConfig({ ...DEFAULTS, ...config })
    if (written.ok) say('已生成默认配置文件 config.json')
  }

  let shuttingDown = false
  async function shutdown(code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(heartbeat)
    say('正在关闭…')
    try { await app.close() } catch { /* ignore */ }
    if (ownsPolling) releaseLock()
    process.exit(code)
  }

  process.on('SIGINT', () => { shutdown(0) })
  process.on('SIGTERM', () => { shutdown(0) })
  process.on('uncaughtException', (error) => {
    say(`未捕获异常：${error?.stack ?? error}`)
    shutdown(1)
  })
  process.on('unhandledRejection', (error) => {
    say(`未处理的 Promise 拒绝：${error?.stack ?? error}`)
  })
}

/**
 * Re-launch behaviour: if the app is already up, just open the page.
 *
 * This is what makes the desktop shortcut idempotent -- clicking it twice opens
 * the existing instance rather than failing on a busy port.
 */
async function focusExistingOrStart() {
  const loaded = readConfig()
  const running = await probeRunning(Number(argValue('--port') ?? loaded.config.port ?? 7788))
  if (running) {
    const url = `http://127.0.0.1:${running.app.port}/`
    say(`课程助手已在运行：${url}`)
    if (!flag('--no-open')) openBrowser(url)
    return
  }
  await main()
}

await focusExistingOrStart()
