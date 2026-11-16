/**
 * The HTTP layer.
 *
 * Plain `node:http`, no framework: the whole app is one process serving one page
 * plus a small JSON API, and a dependency-free build is what makes "copy the
 * folder anywhere and run `node main.mjs`" true.
 *
 * Two live channels exist:
 *   - `status` (every 2s) is a full snapshot: engine, config, knowledge map, logs.
 *   - `log` (only when poll.log changes) pushes just the new lines, so the UI can
 *     animate a live feed without re-rendering everything.
 *
 * Because the plugin's interval is captured in a closure, changing the switch or
 * the interval is handled by disposing and re-applying, and the response says how
 * long that took so the UI can show it honestly.
 */
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

import { applyPatch, MIN_POLL_MS, rebuildKeys, readConfig, writeConfig } from './lib/config.mjs'
import { buildNoteView, EXPAND_SYSTEM, expandPrompt, countPoints, summarizeNote } from './lib/deepsplit.mjs'
import { createEngine, detectForeignPolling, probeForeground, resolvePython } from './lib/engine.mjs'
import { createLlmService, collect, loadApiKey, probeApi, DEFAULT_CREDENTIALS } from './lib/llm.mjs'
import { readLog, summarize } from './lib/logs.mjs'
import { findBridgeDir, findCoursemapModule, resolveInside, PUBLIC_DIR, APP_DIR, CONFIG_PATH } from './lib/paths.mjs'
import { probePythonDocx } from './lib/python.mjs'
import { formatSize, listNotes, readBridge, readJsonFile, readKnowledgeMap, readManual, readTree, splitManual } from './lib/store.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/**
 * Create the server.
 *
 * @param options - config, log sink, port.
 * @returns an object with `listen()`, `close()`, and the live state (handy in tests).
 */
export function createAppServer({ config, port = config.port ?? 7788, configPath = CONFIG_PATH, log = () => {} } = {}) {
  const startedAt = Date.now()
  const state = {
    config,
    configWarnings: [],
    appLog: [],
    lastProbe: null,
    lastScan: null,
    lastExpand: null,
    scanRunning: false,
    llmError: null,
    apiProbe: null,
  }

  function note(text) {
    const line = { at: Date.now(), text: String(text) }
    state.appLog.push(line)
    if (state.appLog.length > 300) state.appLog.splice(0, state.appLog.length - 300)
    log(text)
    broadcast('notice', line)
  }

  const llm = createLlmService({
    getKey: () => loadApiKey(state.config.apiKeyFile || DEFAULT_CREDENTIALS).key,
    model: state.config.model,
    onNote: (text) => { state.llmError = text; note(text) },
  })

  const engine = createEngine({ getConfig: () => state.config, llm, log: (text) => note(text) })

  // ---------------------------------------------------------------- SSE plumbing
  const clients = new Set()

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      try { res.write(payload) } catch { clients.delete(res) }
    }
  }

  let lastLogCount = -1
  let lastLogMtime = 0

  function pollLogPath() {
    return join(state.config.outputDir, '.state', 'poll.log')
  }

  /**
   * Push any newly appended poll.log lines to subscribers.
   *
   * The whole file is re-read: it is small (tens of lines) and this keeps the
   * parser as the single source of truth about line shape.
   */
  function tailPollLog() {
    const file = pollLogPath()
    if (!existsSync(file)) return
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch { return }
    if (mtime === lastLogMtime) return
    lastLogMtime = mtime
    const read = readLog(file, { limit: 400 })
    const entries = read.entries
    if (lastLogCount < 0 || entries.length < lastLogCount) {
      lastLogCount = entries.length
      broadcast('log', { reset: true, entries: entries.slice(-60) })
      return
    }
    if (entries.length > lastLogCount) {
      const fresh = entries.slice(lastLogCount)
      lastLogCount = entries.length
      broadcast('log', { reset: false, entries: fresh })
    }
  }

  // ---------------------------------------------------------------- snapshot
  function buildStatus() {
    const outputDir = state.config.outputDir
    const km = readKnowledgeMap(outputDir)
    const logRead = readLog(pollLogPath(), { limit: 80 })
    const bridge = readBridge(outputDir)
    const coursemap = findCoursemapModule(state.config.coursemapModule)
    const python = resolvePython(state.config.pythonPath)
    const credentials = loadApiKey(state.config.apiKeyFile || DEFAULT_CREDENTIALS)
    const engineInfo = engine.describe()
    const pollOut = join(outputDir, '.state', 'poll-out.txt')
    const pollStat = existsSync(pollOut) ? statSafe(pollOut) : null
    const foreign = detectForeignPolling(outputDir, {
      ownPolling: engineInfo.running,
      intervalMs: state.config.pollIntervalMs,
    })
    const ageMs = pollStat ? Math.max(0, Date.now() - pollStat.mtimeMs) : null
    const window = state.config.pollIntervalMs * 2 + 5000
    return {
      ok: true,
      now: Date.now(),
      app: {
        name: '课程助手',
        version: readVersion(),
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        startedAt,
        port,
      },
      config: {
        ...state.config,
        minPollMs: MIN_POLL_MS,
      },
      configWarnings: state.configWarnings,
      engine: engineInfo,
      polling: {
        enabled: state.config.enabled,
        intervalMs: state.config.pollIntervalMs,
        running: engineInfo.running,
        ageMs,
        alive: Boolean(engineInfo.running && ageMs !== null && ageMs < window),
        windowMs: window,
        lastProbe: state.lastProbe,
        foreign,
      },
      env: {
        coursemap: { ok: coursemap.ok, path: coursemap.path, candidates: coursemap.candidates },
        bridgeDir: findBridgeDir(APP_DIR),
        python: { path: python.path, source: python.source, version: python.version },
        credentials: { ok: Boolean(credentials.key), file: credentials.file, reason: credentials.reason },
        api: state.apiProbe,
        llm: llm.describe(),
        llmError: state.llmError,
      },
      logs: {
        entries: logRead.entries.slice(-60),
        summary: summarize(logRead.entries),
        size: logRead.size,
        missing: logRead.missing,
      },
      knowledge: {
        outputDir,
        stateOk: km.stateOk,
        stateReason: km.stateReason,
        stateUpdatedAt: km.stateUpdatedAt,
        subjects: km.subjects.map((s) => ({
          name: s.name,
          videos: s.videos.length,
          videoTitles: s.videos,
          createdAt: s.createdAt,
          orphan: s.orphan === true,
          manualMd: s.manualMd,
          manualMdOk: s.manualMdOk,
          manualDocxOk: s.manualDocxOk,
          updatedAt: s.manualUpdatedAt,
        })),
        seenCount: km.seenCount,
        lastTitle: km.lastTitle,
        lastRunAt: km.lastRunAt,
        notes: km.notes.notes.slice(0, 20).map((n) => ({ name: n.name, rel: n.rel, size: n.size, sizeText: formatSize(n.size), mtime: n.mtime })),
        noteCount: km.notes.notes.length,
        handbooks: km.notes.handbooks.map((h) => ({ name: h.name, rel: h.rel, size: h.size, sizeText: formatSize(h.size), mtime: h.mtime, kind: h.kind, subject: h.subject ?? null })),
        index: km.index.text.slice(0, 4000),
      },
      bridge: {
        alive: bridge.alive,
        ageMs: bridge.ageMs,
        heartbeat: bridge.heartbeat,
        boot: bridge.boot,
        delivered: bridge.ledger.delivered.length,
        pending: bridge.ledger.pending.length,
        abandoned: bridge.ledger.abandoned.length,
        recent: bridge.ledger.delivered.slice(0, 5),
        logTail: bridge.logTail.slice(-12),
      },
      scan: { running: state.scanRunning, last: state.lastScan },
      expand: { last: state.lastExpand },
      appLog: state.appLog.slice(-40),
    }
  }

  function readVersion() {
    const pkg = readJsonFile(join(APP_DIR, 'package.json'))
    return pkg.ok ? pkg.value.version ?? '0.0.0' : '0.0.0'
  }

  function statSafe(file) {
    try { return statSync(file) } catch { return null }
  }

  // ---------------------------------------------------------------- engine control
  async function startEngine(reason = '手动启动') {
    if (!state.config.enabled) state.config.enabled = true
    const result = await engine.start(state.config)
    if (result.ok) note(`引擎已启动（${reason}，${result.ms}ms）`)
    else note(`引擎启动失败：${result.error}`)
    if (result.ok) {
      // Boot refuses to double-poll on its own, but an explicit click wins. Say so
      // loudly rather than silently producing duplicate handbook entries.
      const foreign = detectForeignPolling(state.config.outputDir, {
        ownPolling: true,
        intervalMs: state.config.pollIntervalMs,
      })
      if (foreign.foreign) {
        note('注意：DeepSeek Harness 的课程插件似乎也在轮询同一份知识地图，两边同时运行会重复记录视频')
        return { ...result, warning: '另一个课程插件可能也在轮询同一份知识地图' }
      }
    }
    return result
  }

  function stopEngine(reason = '手动停止') {
    engine.stop()
    note(`引擎已停止（${reason}）`)
    return { ok: true }
  }

  async function restartEngine(reason) {
    const config = { ...state.config }
    const result = await engine.start(config)
    if (result.ok) note(`引擎已重启（${reason}，${result.ms}ms）`)
    else note(`引擎重启失败：${result.error}`)
    return result
  }

  // ---------------------------------------------------------------- request helpers
  function sendJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  function readBody(req, limit = 1_000_000) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          req.destroy()
          resolve({ ok: false, message: '请求体过大' })
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text.trim()) return resolve({ ok: true, value: {} })
        try { resolve({ ok: true, value: JSON.parse(text) }) } catch { resolve({ ok: false, message: '请求体不是合法 JSON' }) }
      })
      req.on('error', () => resolve({ ok: false, message: '读取请求体失败' }))
    })
  }

  // ---------------------------------------------------------------- routes
  const routes = {
    'GET /api/status': async (req, res) => sendJson(res, 200, buildStatus()),

    'GET /api/config': async (req, res) => {
      const discovered = {
        coursemap: findCoursemapModule(state.config.coursemapModule),
        python: resolvePython(state.config.pythonPath),
        credentials: loadApiKey(state.config.apiKeyFile || DEFAULT_CREDENTIALS),
      }
      sendJson(res, 200, {
        ok: true,
        config: state.config,
        warnings: state.configWarnings,
        minPollMs: MIN_POLL_MS,
        discovered: {
          coursemap: discovered.coursemap,
          python: discovered.python,
          credentials: { ok: Boolean(discovered.credentials.key), file: discovered.credentials.file, reason: discovered.credentials.reason },
        },
      })
    },

    'POST /api/config': async (req, res) => {
      const body = await readBody(req)
      if (!body.ok) return sendJson(res, 400, { ok: false, message: body.message })
      const patch = body.value ?? {}
      const applied = applyPatch(state.config, patch)
      if (!applied.ok) return sendJson(res, 400, { ok: false, message: applied.errors.join('；'), errors: applied.errors })

      const before = state.config
      const changed = rebuildKeys(before, applied.config)
      const needsRebuild = changed.length > 0
      const writeResult = writeConfig(applied.config, configPath)
      if (!writeResult.ok) return sendJson(res, 500, { ok: false, message: writeResult.message })

      state.config = applied.config
      // The LLM service captured the old model in its closure; recreate it when
      // the model changes, otherwise the UI would show one model and use another.
      if ('model' in patch && patch.model !== before.model) note(`模型切换为 ${state.config.model}（重启后生效）`)

      let rebuild = null
      if (needsRebuild) {
        if (state.config.enabled) rebuild = await restartEngine(`配置变更：${changed.join('、')}`)
        else {
          stopEngine('配置变更且开关已关闭')
          rebuild = { ok: true, ms: 0, error: null }
        }
      }
      sendJson(res, 200, { ok: true, config: state.config, changed, rebuild })
    },

    'POST /api/engine': async (req, res) => {
      const body = await readBody(req)
      if (!body.ok) return sendJson(res, 400, { ok: false, message: body.message })
      const action = String(body.value?.action ?? '')
      if (action === 'start') {
        state.config.enabled = true
        writeConfig(state.config, configPath)
        const result = await startEngine('启动开关')
        return sendJson(res, 200, { ok: result.ok, result, config: state.config })
      }
      if (action === 'stop') {
        state.config.enabled = false
        writeConfig(state.config, configPath)
        stopEngine('启动开关')
        return sendJson(res, 200, { ok: true, config: state.config })
      }
      if (action === 'restart') {
        const result = await restartEngine('手动重启')
        return sendJson(res, 200, { ok: result.ok, result, config: state.config })
      }
      return sendJson(res, 400, { ok: false, message: `未知操作 "${action}"` })
    },

    'POST /api/probe': async (req, res) => {
      const result = probeForeground(state.config.outputDir)
      state.lastProbe = { ...result, at: Date.now() }
      if (result.ok) note(`前台探测 ${result.ms}ms：${result.proc} · ${result.title.slice(0, 40)}`)
      else note(`前台探测失败：${result.error}`)
      sendJson(res, 200, { ok: result.ok, probe: state.lastProbe })
    },

    'POST /api/scan': async (req, res) => {
      const body = await readBody(req)
      if (!body.ok) return sendJson(res, 400, { ok: false, message: body.message })
      const title = typeof body.value?.title === 'string' ? body.value.title.trim() : ''
      if (!title) return sendJson(res, 400, { ok: false, message: '请提供要总结的视频标题' })
      if (state.scanRunning) return sendJson(res, 409, { ok: false, message: '已有一次总结在进行中' })

      state.scanRunning = true
      const began = Date.now()
      let temporary = false
      try {
        if (!engine.describe().running) {
          // The switch off means no interval is running; a one-off scan still
          // needs an applied instance. It is disposed right after so polling
          // does not silently stay on.
          const temp = await engine.start({ ...state.config, enabled: true })
          if (!temp.ok) {
            state.scanRunning = false
            return sendJson(res, 500, { ok: false, message: `引擎无法启动：${temp.error}` })
          }
          temporary = true
        }
        note(`开始总结：${title}`)
        const result = await engine.callTool('course_map_scan', { title })
        state.lastScan = { at: Date.now(), title, ms: Date.now() - began, ok: Boolean(result?.ok), message: result?.message ?? '' }
        note(result?.ok ? `总结完成（${state.lastScan.ms}ms）` : `总结失败：${result?.message ?? '未知原因'}`)
        sendJson(res, 200, { ok: Boolean(result?.ok), result, scan: state.lastScan })
      } catch (error) {
        state.lastScan = { at: Date.now(), title, ms: Date.now() - began, ok: false, message: `${error?.message ?? error}` }
        sendJson(res, 500, { ok: false, message: `总结失败：${error?.message ?? error}` })
      } finally {
        state.scanRunning = false
        if (temporary) {
          engine.stop()
          note('单次扫描结束，引擎已停用（开关仍是关闭状态）')
        }
      }
    },

    'GET /api/manual': async (req, res, url) => {
      const subject = url.searchParams.get('subject') ?? ''
      const manual = readManual(state.config.outputDir, subject)
      if (!manual.ok) return sendJson(res, 404, { ok: false, message: manual.reason ?? '手册不可用', subject })
      sendJson(res, 200, { ok: true, ...manual })
    },

    'GET /api/note': async (req, res, url) => {
      const subject = url.searchParams.get('subject') ?? ''
      const title = url.searchParams.get('title') ?? ''
      const manual = readManual(state.config.outputDir, subject)
      if (!manual.ok) return sendJson(res, 404, { ok: false, message: manual.reason ?? '学科手册不可用' })
      const section = manual.sections.find((s) => s.title === title) ?? manual.sections.find((s) => s.title.includes(title) || title.includes(s.title))
      if (!section) return sendJson(res, 404, { ok: false, message: '没有找到该视频的笔记段落' })
      const view = buildNoteView(section.markdown, manual.overview)
      sendJson(res, 200, {
        ok: true,
        subject,
        title: section.title,
        markdown: section.markdown,
        view,
        summary: summarizeNote(section.markdown),
        points: countPoints(section.markdown),
        mtime: manual.mtime,
        sectionTitles: manual.sections.map((s) => s.title),
      })
    },

    'GET /api/tree': async (req, res) => sendJson(res, 200, { ok: true, ...readTree(state.config.outputDir) }),

    'GET /api/notes': async (req, res) => {
      const notes = listNotes(state.config.outputDir)
      sendJson(res, 200, {
        ok: true,
        notes: notes.notes.map((n) => ({ ...n, sizeText: formatSize(n.size) })),
        handbooks: notes.handbooks.map((n) => ({ ...n, sizeText: formatSize(n.size) })),
      })
    },

    'GET /api/file': async (req, res, url) => {
      const rel = url.searchParams.get('rel') ?? ''
      const resolved = resolveInside(state.config.outputDir, rel)
      if (!resolved.ok) return sendJson(res, 400, { ok: false, message: resolved.reason })
      if (!existsSync(resolved.path)) return sendJson(res, 404, { ok: false, message: '文件不存在' })
      const stat = statSafe(resolved.path)
      if (!stat) return sendJson(res, 404, { ok: false, message: '文件不可读' })
      const name = resolved.path.split(/[\\/]/).pop() ?? 'download'
      const encoded = encodeURIComponent(name)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
        'content-disposition': `attachment; filename="download${extname(name)}"; filename*=UTF-8''${encoded}`,
      })
      createReadStream(resolved.path).pipe(res)
    },

    'POST /api/llm/probe': async (req, res) => {
      const credentials = loadApiKey(state.config.apiKeyFile || DEFAULT_CREDENTIALS)
      const probe = await probeApi(credentials.key)
      state.apiProbe = { ...probe, at: Date.now() }
      sendJson(res, 200, { ok: probe.ok, probe: state.apiProbe, file: credentials.file })
    },

    'POST /api/expand': async (req, res) => {
      const body = await readBody(req)
      if (!body.ok) return sendJson(res, 400, { ok: false, message: body.message })
      if (!state.config.enableDeepSplit) return sendJson(res, 400, { ok: false, message: '知识深挖未启用：请先在设置里打开「知识深挖」' })
      const { subject = '', title = '', point = '', section = '' } = body.value ?? {}
      if (!String(point).trim()) return sendJson(res, 400, { ok: false, message: '缺少知识点内容' })
      const prompt = expandPrompt({ subject, title, point, section })
      const began = Date.now()
      try {
        const text = await collect(llm, {
          system: EXPAND_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: 1200,
        })
        state.lastExpand = { at: Date.now(), ok: true, ms: Date.now() - began, point: String(point).slice(0, 80), chars: text.length }
        note(`知识深挖完成（${state.lastExpand.ms}ms，${text.length} 字）`)
        sendJson(res, 200, { ok: true, markdown: text, ms: state.lastExpand.ms })
      } catch (error) {
        state.lastExpand = { at: Date.now(), ok: false, ms: Date.now() - began, message: `${error?.message ?? error}` }
        sendJson(res, 502, { ok: false, message: `深挖失败：${error?.message ?? error}` })
      }
    },

    'GET /api/bridge': async (req, res) => {
      const bridge = readBridge(state.config.outputDir)
      sendJson(res, 200, { ok: true, ...bridge })
    },

    'GET /api/events': async (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      clients.add(res)
      try { res.write(`event: status\ndata: ${JSON.stringify(buildStatus())}\n\n`) } catch { /* ignore */ }
      // Sea the log feed synchronously. tailPollLog only fires on an mtime change,
      // so with the engine stopped (the common first-run state) a fresh page would
      // never receive a `log` event and would keep showing the empty placeholder
      // even though poll.log has plenty of history to display.
      try {
        const seeded = readLog(pollLogPath(), { limit: 400 })
        res.write(`event: log\ndata: ${JSON.stringify({ reset: true, entries: seeded.entries.slice(-60) })}\n\n`)
      } catch { /* ignore */ }
      req.on('close', () => { clients.delete(res) })
    },
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname)
    if (rel === '/' || rel === '') rel = '/index.html'
    const resolved = resolveInside(PUBLIC_DIR, rel.replace(/^\/+/, ''))
    if (!resolved.ok) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('禁止访问')
    }
    if (!existsSync(resolved.path)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('页面不存在')
    }
    const stat = statSafe(resolved.path)
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('页面不存在')
    }
    const type = MIME[extname(resolved.path).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'cache-control': 'no-cache' })
    createReadStream(resolved.path).pipe(res)
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const key = `${req.method} ${url.pathname}`
    const route = routes[key]
    if (route) {
      try {
        await route(req, res, url)
      } catch (error) {
        if (!res.headersSent) sendJson(res, 500, { ok: false, message: `${error?.message ?? error}` })
        else res.end()
      }
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url)
    sendJson(res, 404, { ok: false, message: `未知接口 ${key}` })
  }

  const server = createServer((req, res) => { handler(req, res) })

  let statusTimer = null
  let tailTimer = null

  return {
    state,
    engine,
    llm,
    note,
    buildStatus,
    server,
    /** Start listening and begin pushing SSE snapshots. */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          statusTimer = setInterval(() => {
            if (!clients.size) return
            let snapshot
            try { snapshot = buildStatus() } catch (error) {
              return broadcast('notice', { at: Date.now(), text: `状态采集失败：${error?.message ?? error}` })
            }
            broadcast('status', snapshot)
          }, 2000)
          statusTimer.unref?.()
          tailTimer = setInterval(tailPollLog, 1500)
          tailTimer.unref?.()
          resolve({ port, url: `http://127.0.0.1:${port}/` })
        })
      })
    },
    /** Stop timers, drop subscribers, and close the listener. */
    async close() {
      if (statusTimer) clearInterval(statusTimer)
      if (tailTimer) clearInterval(tailTimer)
      for (const res of clients) { try { res.end() } catch { /* ignore */ } }
      clients.clear()
      engine.stop()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
