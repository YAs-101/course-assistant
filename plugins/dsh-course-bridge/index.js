/**
 * dsh-course-bridge -- deliver a Word course note into a brand new DSH session
 * every time dsh-video-coursemap records one more video.
 *
 * Division of labour:
 *   dsh-video-coursemap  watches the browser window, classifies the video into
 *                        a subject, fetches description/danmaku/comments, and
 *                        writes <outputDir>/.state/{state.json,manuals/*.md}.
 *   dsh-memory-evolve    keeps the long-term memory of each finished turn.
 *   this plugin          notices the new (subject, video) pair, cuts the video
 *                        section out of the subject manual, renders a .docx,
 *                        and delivers it as an attachment into a fresh session.
 *
 * The plugin imports nothing but node: builtins: a profile-scoped plugin cannot
 * resolve @deepseek-ai/dsh-* host packages. Every host service is therefore
 * fetched lazily with ctx.get(), never in a static inject list.
 *
 * @module dsh-course-bridge
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findPython } from './lib/docx.js'
import { deliverOne } from './lib/deliver.js'
import {
  DEFAULT_MAX_ATTEMPTS,
  emptyBridge,
  isSettled,
  listVideos,
  markAllDelivered,
  readBridge,
  readState,
  selectDue,
  writeBridge,
} from './lib/state.js'
import { errText, safeName, splitKey, stamp } from './lib/util.js'

const NAME = 'dsh-course-bridge'
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = join(PLUGIN_DIR, 'scripts', 'md2docx.py')

/** Every configuration key this plugin accepts. */
const DEFAULTS = {
  enabled: true,
  outputDir: null,
  deliverCwd: null,
  watchIntervalMs: 3000,
  maxDeliveriesPerScan: 3,
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  retryBaseMs: 60000,
  retryMaxMs: 900000,
  agentPreset: null,
  initialBackfill: false,
  pythonPath: null,
  notesDirName: '笔记',
  sessionTitlePrefix: '课程笔记',
  sessionPermissionPreset: 'danger-full-access',
  fetchContent: true,
  summarize: true,
  includeManualSection: true,
  matchThreshold: 0.65,
  maxQueries: 8,
  provider: null,
  model: null,
  maxTokens: 3000,
}

/** Reject unknown keys so a typo never silently disables a setting. */
function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) throw new Error(NAME + ': unknown configuration key "' + key + '"')
  }
  const config = { ...DEFAULTS, ...input }
  for (const key of ['watchIntervalMs', 'maxDeliveriesPerScan', 'maxAttempts', 'retryBaseMs', 'retryMaxMs', 'maxTokens', 'maxQueries']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(NAME + ': "' + key + '" must be a positive number')
    }
  }
  if (typeof config.matchThreshold !== 'number' || !Number.isFinite(config.matchThreshold) || config.matchThreshold <= 0 || config.matchThreshold > 1) {
    throw new Error(NAME + ': "matchThreshold" must be a number in (0, 1]')
  }
  config.enabled = config.enabled !== false
  config.initialBackfill = config.initialBackfill === true
  config.fetchContent = config.fetchContent !== false
  config.summarize = config.summarize !== false
  config.includeManualSection = config.includeManualSection !== false
  config.provider = typeof config.provider === 'string' && config.provider.trim() !== '' ? config.provider.trim() : null
  config.model = typeof config.model === 'string' && config.model.trim() !== '' ? config.model.trim() : null
  config.outputDir = typeof config.outputDir === 'string' && config.outputDir.trim() !== '' ? config.outputDir.trim() : join(homedir(), '课程知识地图')
  config.deliverCwd = typeof config.deliverCwd === 'string' && config.deliverCwd.trim() !== '' ? config.deliverCwd.trim() : config.outputDir
  config.agentPreset = typeof config.agentPreset === 'string' && config.agentPreset.trim() !== '' ? config.agentPreset.trim() : null
  config.pythonPath = typeof config.pythonPath === 'string' && config.pythonPath.trim() !== '' ? config.pythonPath.trim() : null
  config.notesDirName = typeof config.notesDirName === 'string' && config.notesDirName.trim() !== '' ? config.notesDirName.trim() : '笔记'
  config.sessionTitlePrefix = typeof config.sessionTitlePrefix === 'string' ? config.sessionTitlePrefix : '课程笔记'
  config.sessionPermissionPreset = typeof config.sessionPermissionPreset === 'string' && config.sessionPermissionPreset.trim() !== '' ? config.sessionPermissionPreset.trim() : null
  return config
}

/**
 * Services this plugin resolves through the context proxy.
 *
 * `ctx.tools` is read as a property, and cordis rejects an undeclared
 * property access with `cannot get property "tools" without inject` — which
 * aborts `apply` *after* the watcher effect is created, so the fiber is
 * disposed and the interval silently never runs. Declaring the dependency is
 * what keeps the plugin alive.
 */
export const inject = ['tools']

/**
 * @param ctx - plugin context provided by the DSH loader.
 * @param rawConfig - the `config` block from the profile patch.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const bootMark = { at: new Date().toISOString(), pid: process.pid, plugin: NAME, config: { outputDir: config.outputDir, deliverCwd: config.deliverCwd } }
  try {
    mkdirSync(join(config.outputDir, '.state'), { recursive: true })
    writeFileSync(join(config.outputDir, '.state', 'bridge.boot.json'), JSON.stringify(bootMark, null, 2) + '\n', 'utf8')
  } catch {
    /* the boot marker is diagnostic only */
  }
  const stateDir = join(config.outputDir, '.state')
  const statePath = join(stateDir, 'state.json')
  const manualsDir = join(stateDir, 'manuals')
  const bridgePath = join(stateDir, 'bridge.json')
  const notesDir = join(config.outputDir, config.notesDirName)
  const scriptPath = existsSync(DEFAULT_SCRIPT) ? DEFAULT_SCRIPT : join(PLUGIN_DIR, 'scripts', 'md2docx.py')

  for (const dir of [stateDir, manualsDir, notesDir]) mkdirSync(dir, { recursive: true })
  // Materialize the ledger on start so "did this plugin mount?" is answerable
  // from disk, and so the first scan always has a file to update.
  if (!existsSync(bridgePath)) writeBridge(bridgePath, emptyBridge())

  const pythonPath = findPython(config.pythonPath)

  const logPath = join(stateDir, 'bridge.log')

  /**
   * Append one diagnostic line to .state/bridge.log and the host console.
   *
   * The host console is not reachable from the profile UI, so a durable log is
   * the only way to answer "why did nothing arrive?" after the fact.
   */
  function log(message) {
    const line = '[' + new Date().toISOString() + '] ' + message
    try {
      console.log('[' + NAME + '] ' + message)
    } catch {
      /* logging must never break a scan */
    }
    try {
      appendFileSync(logPath, line + '\n', 'utf8')
    } catch {
      /* the log is diagnostic only */
    }
  }

  /** Windows-safe, length-bounded note file stem for one video. */
  function noteBaseName(video) {
    const stem = '笔记-' + safeName(video.title, 40) + '-' + stamp()
    return stem.length > 120 ? '笔记-' + safeName(video.subject, 20) + '-' + stamp() : stem
  }

  /** Request object for sessionController.create -- cwd and workspaceId are exclusive. */
  function createRequest() {
    const request = { cwd: config.deliverCwd }
    if (config.agentPreset !== null) request.agentPreset = config.agentPreset
    return request
  }

  function sessionTitleFor(video) {
    const prefix = config.sessionTitlePrefix ? config.sessionTitlePrefix + ' · ' : ''
    return prefix + safeName(video.title, 40)
  }

  const runtime = {
    config: {
      notesDir,
      pythonPath,
      scriptPath,
      createRequest,
      sessionTitleFor,
      noteBaseName,
      fetchContent: config.fetchContent,
      summarize: config.summarize,
      includeManualSection: config.includeManualSection,
      matchThreshold: config.matchThreshold,
      maxQueries: config.maxQueries,
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      sessionPermissionPreset: config.sessionPermissionPreset,
    },
  }

  let running = false
  let lastScan = { at: 0, due: 0, delivered: 0, failed: 0, skipped: 0, message: 'not scanned yet' }

  /** Read the manual of one subject, or "" when it is not there yet. */
  function readManual(subject) {
    const file = join(manualsDir, safeName(subject, 60) + '.md')
    if (!existsSync(file)) return ''
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }

  /** Record what the watcher just did, so a stuck watcher is visible on disk. */
  function writeHeartbeat(patch) {
    try {
      writeFileSync(join(stateDir, 'bridge.heartbeat.json'), JSON.stringify({ ...lastScan, ...patch }, null, 2) + '\n', 'utf8')
    } catch {
      /* the heartbeat is diagnostic only */
    }
  }

  /**
   * One observation pass: read state, diff against the ledger, deliver what is
   * due, then persist the ledger. Silent when nothing new appeared.
   */
  async function scanOnce({ force = false, onlyKey = null } = {}) {
    if (!config.enabled) return { at: Date.now(), due: 0, delivered: 0, failed: 0, skipped: 0, message: 'disabled' }
    if (running && !force) return { ...lastScan, message: 'a scan is already running' }
    running = true
    try {
      writeHeartbeat({ at: Date.now(), phase: 'started' })
      const loaded = readState(statePath)
      if (!loaded.ok) {
        lastScan = { at: Date.now(), due: 0, delivered: 0, failed: 0, skipped: 0, message: loaded.reason }
        return lastScan
      }
      const bridge = readBridge(bridgePath)
      const videos = listVideos(loaded.state)

      if (!bridge.initialized) {
        if (config.initialBackfill) {
          log('首次运行：将对已存在的 ' + videos.length + ' 个视频补投笔记')
        } else {
          markAllDelivered(bridge, videos, Date.now())
          log('首次运行：已把现有 ' + videos.length + ' 个视频记为已处理（initialBackfill=false），只对之后新出现的视频投递')
        }
        bridge.initialized = true
        writeBridge(bridgePath, bridge)
      }

      const now = Date.now()
      let due = selectDue({ videos, bridge, now, maxAttempts: config.maxAttempts })
      if (onlyKey !== null) due = due.filter((video) => video.key === onlyKey)
      const batch = due.slice(0, force ? due.length : config.maxDeliveriesPerScan)

      let delivered = 0
      let failed = 0
      for (const video of batch) {
        const previous = { ...(bridge.pending[video.key] || {}) }
        const manualText = readManual(video.subject)
        if (manualText.trim() === '') {
          failed += 1
          recordFailure(bridge, video, now, 'manuals/' + safeName(video.subject, 60) + '.md is empty or missing')
          continue
        }
        try {
          const outcome = await deliverOne({ ctx, config: runtime.config, video, manualText, previous, log })
          if (outcome.ok) {
            delivered += 1
            bridge.delivered[video.key] = {
              subject: video.subject,
              title: video.title,
              sessionId: outcome.sessionId,
              docxPath: outcome.docxPath,
              at: Date.now(),
              ...(outcome.degraded ? { degraded: true } : {}),
              ...(outcome.summarySource ? { summarySource: outcome.summarySource } : {}),
            }
            delete bridge.pending[video.key]
            bridge.sessions[video.key] = outcome.sessionId
            log('已投递「' + video.subject + ' / ' + video.title + '」→ 会话 ' + outcome.sessionId)
          } else {
            failed += 1
            recordFailure(bridge, video, now, outcome.step + ': ' + outcome.message, {
              docxPath: outcome.docxPath,
              sessionId: outcome.sessionId,
              ...(outcome.summarySource ? { summarySource: outcome.summarySource } : {}),
            })
          }
        } catch (error) {
          failed += 1
          recordFailure(bridge, video, now, errText(error), {})
        } finally {
          writeBridge(bridgePath, bridge)
        }
      }

      if (batch.length > 0) writeBridge(bridgePath, bridge)
      lastScan = {
        at: Date.now(),
        due: due.length,
        delivered,
        failed,
        skipped: videos.length - due.length,
        message: batch.length === 0 ? 'no new video' : 'handled ' + batch.length + ' video(s)',
      }
      writeHeartbeat({ phase: 'idle' })
      return lastScan
    } finally {
      running = false
    }
  }

  /** Record a failed attempt, abandoning the video once it exhausts its tries. */
  function recordFailure(bridge, video, now, reason, extra = {}) {
    const previous = bridge.pending[video.key] || {}
    const attempts = (typeof previous.attempts === 'number' ? previous.attempts : 0) + 1
    if (attempts >= config.maxAttempts) {
      bridge.abandoned[video.key] = { at: now, reason }
      delete bridge.pending[video.key]
      log('放弃「' + video.title + '」（已尝试 ' + attempts + ' 次）：' + reason)
      return
    }
    const backoff = Math.min(config.retryBaseMs * 2 ** (attempts - 1), config.retryMaxMs)
    bridge.pending[video.key] = {
      attempts,
      lastError: reason,
      nextTryAt: now + backoff,
      ...(extra.docxPath ? { docxPath: extra.docxPath } : {}),
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    }
    log('「' + video.title + '」第 ' + attempts + ' 次投递失败，' + Math.round(backoff / 1000) + 's 后重试：' + reason)
  }

  /**
   * Register one tool, reporting a failure to bridge.log instead of letting
   * cordis tear down the whole fiber (which would silently stop the watcher).
   */
  function registerTool(name, factory) {
    try {
      ctx.effect(factory, NAME + ': ' + name)
      log('已注册工具 ' + name)
    } catch (error) {
      log('注册工具 ' + name + ' 失败：' + errText(error))
    }
  }

  if (config.enabled) {
    ctx.effect(
      () => {
        const id = setInterval(() => {
          scanOnce().catch((error) => log('扫描失败：' + errText(error)))
        }, config.watchIntervalMs)
        if (typeof id.unref === 'function') id.unref()
        return () => clearInterval(id)
      },
      NAME + ': watch ' + statePath,
    )
    log('已启动：观察 ' + statePath + '，每 ' + config.watchIntervalMs + 'ms 一次，笔记写入 ' + notesDir)
    if (pythonPath === null) log('警告：没有找到可用的 Python，Word 转换会失败直到 python 可用')
  }

  registerTool('course_note_status', () =>
      ctx.tools.register(
        {
          name: 'course_note_status',
          description:
            '查看 dsh-course-bridge 的运行状态：观察的 state.json、笔记目录、已投递/待重试/已放弃的视频数量，以及每个视频对应的会话。用于排查「为什么没有生成笔记」。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                outputDir: { type: 'string' },
                notesDir: { type: 'string' },
                watchIntervalMs: { type: 'number' },
                pythonPath: { type: 'string' },
                subjects: { type: 'number' },
                videos: { type: 'number' },
                delivered: { type: 'number' },
                pending: { type: 'number' },
                abandoned: { type: 'number' },
                lastScan: { type: 'string' },
                details: { type: 'string' },
              },
              required: ['outputDir', 'notesDir', 'watchIntervalMs', 'pythonPath', 'subjects', 'videos', 'delivered', 'pending', 'abandoned', 'lastScan', 'details'],
            },
            render: (_args, value) => [{ type: 'text', text: value.details }],
          },
          async execute() {
            const loaded = readState(statePath)
            const bridge = readBridge(bridgePath)
            const videos = loaded.ok ? listVideos(loaded.state) : []
            const deliveredKeys = Object.keys(bridge.delivered)
            const pendingKeys = Object.keys(bridge.pending)
            const abandonedKeys = Object.keys(bridge.abandoned)
            const lines = [
              '观察目录：' + config.outputDir,
              'state.json：' + (loaded.ok ? '可读，' + Object.keys(loaded.state.subjects).length + ' 个学科 / ' + videos.length + ' 个视频' : loaded.reason),
              '笔记目录：' + notesDir,
              '观察间隔：' + config.watchIntervalMs + 'ms；Python：' + String(pythonPath),
              '已投递 ' + deliveredKeys.length + ' · 待重试 ' + pendingKeys.length + ' · 已放弃 ' + abandonedKeys.length,
              '最近一次扫描：' + JSON.stringify(lastScan),
            ]
            for (const key of deliveredKeys) {
              const record = bridge.delivered[key]
              lines.push('- 已投递「' + (record.subject || '') + ' / ' + (record.title || '') + '」→ 会话 ' + (record.sessionId || '(无)') + ' · ' + (record.docxPath || ''))
            }
            for (const key of pendingKeys) {
              const record = bridge.pending[key]
              lines.push('- 待重试「' + splitKey(key).title + '」第 ' + record.attempts + ' 次失败：' + (record.lastError || ''))
            }
            for (const key of abandonedKeys) {
              const record = bridge.abandoned[key]
              lines.push('- 已放弃「' + splitKey(key).title + '」：' + (record.reason || ''))
            }
            return {
              outputDir: config.outputDir,
              notesDir,
              watchIntervalMs: config.watchIntervalMs,
              pythonPath: String(pythonPath),
              subjects: loaded.ok ? Object.keys(loaded.state.subjects).length : 0,
              videos: videos.length,
              delivered: deliveredKeys.length,
              pending: pendingKeys.length,
              abandoned: abandonedKeys.length,
              lastScan: JSON.stringify(lastScan),
              details: lines.join('\n'),
            }
          },
        },
        NAME + ': course_note_status',
      ),
  )

  registerTool('course_note_deliver', () =>
      ctx.tools.register(
        {
          name: 'course_note_deliver',
          description:
            '立即为某个视频生成并投递 Word 课程笔记到新会话。不给 title 时处理当前所有待投递的视频；给 title 时只处理匹配的那一个（可用学科缩小范围）。用于手动补投或重投某个视频。',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '视频标题（完全一致或包含即可）；留空表示处理全部待投递视频' },
              subject: { type: 'string', description: '学科名，用于在标题不唯一时缩小范围' },
              force: { type: 'boolean', description: '为 true 时无视退避时间立即重试' },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean' },
                message: { type: 'string' },
              },
              required: ['ok', 'message'],
            },
            render: (_args, value) => [{ type: 'text', text: value.message }],
          },
          async execute(args) {
            const wanted = typeof args.title === 'string' ? args.title.trim() : ''
            const wantedSubject = typeof args.subject === 'string' ? args.subject.trim() : ''
            const force = args.force === true
            const loaded = readState(statePath)
            if (!loaded.ok) return { ok: false, message: '无法读取 state.json：' + loaded.reason }
            const videos = listVideos(loaded.state).filter((video) => {
              if (wantedSubject !== '' && video.subject !== wantedSubject) return false
              if (wanted === '') return true
              return video.title === wanted || video.title.includes(wanted)
            })
            if (videos.length === 0) return { ok: false, message: '在 state.json 里没有找到匹配的视频' + (wanted ? '：' + wanted : '') }
            const bridge = readBridge(bridgePath)
            let targets = videos.filter((video) => !isSettled(bridge, video.key))
            if (force) {
              // force 是有意的重投：把匹配到的视频从账本里彻底摘掉，让它重新走一遍生成 + 投递。
              for (const video of videos) {
                delete bridge.delivered[video.key]
                delete bridge.abandoned[video.key]
                delete bridge.pending[video.key]
              }
              writeBridge(bridgePath, bridge)
              targets = videos
            }
            if (targets.length === 0) {
              return {
                ok: false,
                message:
                  '匹配到的 ' + videos.length + ' 个视频都已投递或已放弃；加 force: true 可以重新投递，或先删除 ' + bridgePath + ' 里的对应记录',
              }
            }
            const outcome = await scanOnce({ force: true })
            return {
              ok: outcome.delivered > 0,
              message:
                '待投递 ' + targets.length + ' 个，本轮成功 ' + outcome.delivered + ' 个、失败 ' + outcome.failed + ' 个。笔记目录：' + notesDir,
            }
          },
        },
        NAME + ': course_note_deliver',
      ),
  )

  log('apply 完成')
  return { config, scanOnce }
}

export { resolveConfig }
// The default export wins over the module namespace (the loader takes
// `exports.default ?? exports`), so `inject` must be repeated here or cordis
// never learns that this plugin reads `ctx.tools`.
export default { apply, inject }