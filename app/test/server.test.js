/**
 * HTTP integration tests.
 *
 * These start the real server on an ephemeral port against a temporary knowledge
 * map, so they cover the wiring that unit tests cannot: routing, JSON shapes, the
 * download sandbox, and the promise that turning the switch off really stops the
 * engine.
 *
 * A stand-in plugin module is used instead of the installed one so the assertions
 * describe this app rather than another plugin's version.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DEFAULTS } from '../lib/config.mjs'
import { createAppServer } from '../server.mjs'

const FAKE_PLUGIN = `
export const name = 'fake-coursemap'
export function apply(ctx, config) {
  globalThis.__fakeApplied = (globalThis.__fakeApplied ?? 0) + 1
  const timer = setInterval(() => {}, 60000)
  timer.unref?.()
  ctx.tools.register({ name: 'course_map_status', async execute() { return { ok: true, enabled: config.enabled } } })
  ctx.tools.register({
    name: 'course_map_scan',
    async execute(args) {
      if (!config.enabled) return { ok: false, message: 'Agent 未启用（config.enabled=false）' }
      return { ok: true, message: '已总结 ' + (args?.title ?? '') }
    },
  })
  ctx.effect(() => () => clearInterval(timer))
}
`

const servers = []
const temps = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'course-server-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  while (servers.length) {
    const app = servers.pop()
    try { await app.close() } catch { /* ignore */ }
  }
  while (temps.length) {
    const dir = temps.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** Seed a knowledge map with one subject, one note and one note docx. */
function seedMap(dir) {
  mkdirSync(join(dir, '.state', 'manuals'), { recursive: true })
  mkdirSync(join(dir, '音乐鉴赏'), { recursive: true })
  mkdirSync(join(dir, '笔记'), { recursive: true })
  writeFileSync(join(dir, '.state', 'state.json'), JSON.stringify({
    subjects: { 音乐鉴赏: { createdAt: 1, videos: ['星铁主题曲', '明日方舟'] } },
    seen: { a: 1 },
    lastTitle: '明日方舟',
    lastRunAt: 1794834935790,
  }), 'utf8')
  writeFileSync(join(dir, '.state', 'poll.log'), [
    '[2026-11-16T11:45:12.100Z] fg proc=哔哩哔哩 title="星铁主题曲"',
    '[2026-11-16T11:45:12.200Z] browser proc=哔哩哔哩 cleaned="星铁主题曲"',
  ].join('\n'), 'utf8')
  // Present so `/api/status` exercises the "is somebody else probing?" path: a
  // missing file short-circuits before the clock is read.
  writeFileSync(join(dir, '.state', 'poll-out.txt'), 'TITLE=星铁主题曲\nPROC=哔哩哔哩\n', 'utf8')
  writeFileSync(join(dir, '.state', 'manuals', '音乐鉴赏.md'), [
    '# 音乐鉴赏 学习手册',
    '<!-- OVERVIEW_START -->',
    '```mermaid',
    'mindmap',
    '  root((课程知识地图))',
    '    音乐鉴赏',
    '```',
    '<!-- OVERVIEW_END -->',
    '',
    '---',
    '',
    '## 星铁主题曲',
    '',
    '> 用音乐制作人的视角拆解配器。',
    '',
    '### 核心知识点',
    '- 主题动机贯穿全曲',
    '  - 前奏三音动机',
    '',
    '### 弹幕与评论讨论焦点',
    '大家在聊副歌转调',
    '',
    '### 思维导图',
    '```mermaid',
    'mindmap',
    '  root((星铁主题曲))',
    '    动机',
    '```',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, '音乐鉴赏', '学习手册.docx'), 'PKfake', 'utf8')
  writeFileSync(join(dir, '笔记', '笔记-星铁主题曲-20261116-1945.docx'), 'PKnote', 'utf8')
  writeFileSync(join(dir, '.state', 'bridge.heartbeat.json'), JSON.stringify({ at: Date.now(), phase: 'idle' }), 'utf8')
}

async function startServer(overrides = {}) {
  const dir = tempDir()
  seedMap(dir)
  const plugin = join(dir, 'fake-plugin.mjs')
  writeFileSync(plugin, FAKE_PLUGIN, 'utf8')
  const config = {
    ...DEFAULTS,
    outputDir: dir,
    coursemapModule: plugin,
    enabled: false,
    port: 0,
    apiKeyFile: join(dir, 'no-credentials.yaml'),
    ...overrides,
  }
  const configPath = join(dir, 'config.json')
  const app = createAppServer({ config, port: 0, configPath })
  const listened = await app.listen()
  servers.push(app)
  const { port } = app.server.address() ?? listened
  const base = `http://127.0.0.1:${port}`
  return { app, dir, config, configPath, base, port }
}

async function getJson(url, options) {
  const res = await fetch(url, options)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body, headers: res.headers }
}

function postJson(url, value) {
  return getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
}

describe('GET /api/status', () => {
  it('返回完整快照', async () => {
    const { base, app } = await startServer()
    const { status, body } = await getJson(`${base}/api/status`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.app.name, '课程助手')
    assert.equal(body.app.pid, app.state.app ? body.app.pid : process.pid)
    assert.equal(body.polling.enabled, false)
    assert.ok(body.config.minPollMs >= 2000)
  })

  it('汇报学科、笔记与日志', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/status`)
    assert.equal(body.knowledge.subjects.length, 1)
    assert.equal(body.knowledge.subjects[0].name, '音乐鉴赏')
    assert.equal(body.knowledge.subjects[0].videos, 2)
    assert.equal(body.knowledge.noteCount, 1)
    assert.equal(body.logs.entries.length, 2)
    assert.equal(body.logs.summary.counts.browser, 1)
  })

  it('汇报环境自检结果', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/status`)
    assert.equal(body.env.coursemap.ok, true)
    assert.equal(typeof body.env.credentials.ok, 'boolean')
    assert.equal(typeof body.env.python.path === 'string' || body.env.python.path === null, true)
  })

  it('引擎未启动时 running=false', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/status`)
    assert.equal(body.engine.running, false)
    assert.deepEqual(body.engine.tools, [])
  })

  it('探测到外部轮询而非本进程时如实标记', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/status`)
    // seedMap writes a fresh poll-out.txt, and this server is not polling.
    assert.equal(body.polling.foreign.foreign, true)
    assert.equal(body.polling.running, false)
  })
})

describe('GET /api/config', () => {
  it('返回当前配置与自动探测结果', async () => {
    const { base, config } = await startServer()
    const { body } = await getJson(`${base}/api/config`)
    assert.equal(body.ok, true)
    assert.equal(body.config.outputDir, config.outputDir)
    assert.equal(body.discovered.coursemap.ok, true)
  })
})

describe('POST /api/config', () => {
  it('保存合法变更并落盘', async () => {
    const { base, configPath } = await startServer()
    const { status, body } = await postJson(`${base}/api/config`, { pollIntervalMs: 5000, stablePolls: 3 })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.config.pollIntervalMs, 5000)
    assert.match(body.changed.join(','), /pollIntervalMs/)
    const saved = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(saved.pollIntervalMs, 5000)
  })

  it('拒绝过小的间隔并说明原因', async () => {
    const { base } = await startServer()
    const { status, body } = await postJson(`${base}/api/config`, { pollIntervalMs: 100 })
    assert.equal(status, 400)
    assert.equal(body.ok, false)
    assert.match(body.message, /2000/)
  })

  it('一次报告多个非法字段', async () => {
    const { base } = await startServer()
    const { body } = await postJson(`${base}/api/config`, { pollIntervalMs: 1, stablePolls: 99 })
    assert.equal(body.errors.length, 2)
  })

  it('拒绝未知字段', async () => {
    const { base } = await startServer()
    const { status, body } = await postJson(`${base}/api/config`, { hack: 1 })
    assert.equal(status, 400)
    assert.match(body.message, /未知配置项/)
  })

  it('非法 JSON 请求体被拒绝', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/api/config`, { method: 'POST', body: '{oops' })
    assert.equal(res.status, 400)
  })
})

describe('POST /api/engine', () => {
  it('start 打开开关并运行引擎', async () => {
    const { base } = await startServer()
    const { body } = await postJson(`${base}/api/engine`, { action: 'start' })
    assert.equal(body.ok, true)
    assert.equal(body.config.enabled, true)
    const status = await getJson(`${base}/api/status`)
    assert.equal(status.body.engine.running, true)
    assert.deepEqual(status.body.engine.tools.sort(), ['course_map_scan', 'course_map_status'])
  })

  it('stop 关闭开关并释放工具', async () => {
    const { base } = await startServer()
    await postJson(`${base}/api/engine`, { action: 'start' })
    const stopped = await postJson(`${base}/api/engine`, { action: 'stop' })
    assert.equal(stopped.body.config.enabled, false)
    const status = await getJson(`${base}/api/status`)
    assert.equal(status.body.engine.running, false)
  })

  it('restart 保留开关状态', async () => {
    const { base } = await startServer()
    await postJson(`${base}/api/engine`, { action: 'start' })
    const { body } = await postJson(`${base}/api/engine`, { action: 'restart' })
    assert.equal(body.ok, true)
    assert.equal(body.config.enabled, true)
  })

  it('未知操作返回 400', async () => {
    const { base } = await startServer()
    const { status, body } = await postJson(`${base}/api/engine`, { action: 'explode' })
    assert.equal(status, 400)
    assert.match(body.message, /未知操作/)
  })

  it('改间隔会重建引擎', async () => {
    const { base, app } = await startServer()
    await postJson(`${base}/api/engine`, { action: 'start' })
    const before = globalThis.__fakeApplied
    const { body } = await postJson(`${base}/api/config`, { pollIntervalMs: 4000 })
    assert.equal(body.ok, true)
    assert.equal(globalThis.__fakeApplied, before + 1)
    assert.equal(app.buildStatus().engine.pollIntervalMs, 4000)
  })

  it('关闭状态下改配置不会偷偷启动引擎', async () => {
    const { base } = await startServer()
    await postJson(`${base}/api/config`, { pollIntervalMs: 4000 })
    const { body } = await getJson(`${base}/api/status`)
    assert.equal(body.engine.running, false)
    assert.equal(body.polling.enabled, false)
  })
})

describe('POST /api/scan', () => {
  it('缺少标题返回 400', async () => {
    const { base } = await startServer()
    const { status } = await postJson(`${base}/api/scan`, {})
    assert.equal(status, 400)
  })

  it('临时启动引擎完成单次总结后关闭', async () => {
    const { base } = await startServer()
    const { status, body } = await postJson(`${base}/api/scan`, { title: '星铁主题曲' })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.match(body.result.message, /已总结/)
    // The switch must still read "off": a one-off scan may not leave polling on.
    const after = await getJson(`${base}/api/status`)
    assert.equal(after.body.config.enabled, false)
    assert.equal(after.body.engine.running, false)
  })

  it('已开启时直接调用而不再临时启动', async () => {
    const { base, app } = await startServer()
    await postJson(`${base}/api/engine`, { action: 'start' })
    const { body } = await postJson(`${base}/api/scan`, { title: '明日方舟' })
    assert.equal(body.ok, true)
    assert.equal(app.buildStatus().config.enabled, true)
    assert.equal(app.buildStatus().engine.running, true)
  })
})

describe('GET /api/manual 与 /api/note', () => {
  it('读取学科手册', async () => {
    const { base } = await startServer()
    const { status, body } = await getJson(`${base}/api/manual?subject=${encodeURIComponent('音乐鉴赏')}`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.sections.length, 1)
    assert.match(body.overview, /mindmap/)
  })

  it('缺学科参数返回 404 而不是 500', async () => {
    const { base } = await startServer()
    const { status } = await getJson(`${base}/api/manual?subject=`)
    assert.equal(status, 404)
  })

  it('读取单个视频笔记并给出四视图', async () => {
    const { base } = await startServer()
    const { status, body } = await getJson(`${base}/api/note?subject=${encodeURIComponent('音乐鉴赏')}&title=${encodeURIComponent('星铁主题曲')}`)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.points, 1)
    assert.equal(body.view.knowledge.length, 1)
    assert.equal(body.view.knowledge[0].children.length, 1)
    assert.match(body.summary, /音乐制作人/)
    assert.equal(body.view.mindmap.root.text, '星铁主题曲')
  })

  it('标题不存在返回 404', async () => {
    const { base } = await startServer()
    const { status } = await getJson(`${base}/api/note?subject=${encodeURIComponent('音乐鉴赏')}&title=不存在的视频`)
    assert.equal(status, 404)
  })

  it('拒绝路径穿越的学科名', async () => {
    const { base } = await startServer()
    const { status } = await getJson(`${base}/api/manual?subject=${encodeURIComponent('../../etc')}`)
    assert.equal(status, 404)
  })
})

describe('GET /api/tree 与 /api/notes', () => {
  it('返回笔记树', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/tree`)
    assert.equal(body.ok, true)
    assert.equal(body.subjects.length, 1)
  })

  it('列出文档并带可读大小', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/notes`)
    assert.equal(body.notes.length, 1)
    assert.ok(body.notes[0].sizeText)
    assert.ok(body.handbooks.length >= 1)
  })
})

describe('GET /api/file', () => {
  it('下载知识地图内的文件', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/api/file?rel=${encodeURIComponent('笔记/笔记-星铁主题曲-20261116-1945.docx')}`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition') ?? '', /attachment/)
    assert.equal(await res.text(), 'PKnote')
  })

  it('拒绝越出知识地图的路径', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/api/file?rel=${encodeURIComponent('../../../Windows/win.ini')}`)
    assert.equal(res.status, 400)
  })

  it('不存在时返回 404', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/api/file?rel=${encodeURIComponent('笔记/无此文件.docx')}`)
    assert.equal(res.status, 404)
  })
})

describe('GET /api/bridge', () => {
  it('返回投递账本与心跳', async () => {
    const { base } = await startServer()
    const { body } = await getJson(`${base}/api/bridge`)
    assert.equal(body.ok, true)
    assert.equal(body.alive, true)
    assert.deepEqual(body.ledger.delivered, [])
  })
})

describe('POST /api/expand', () => {
  it('未启用知识深挖时拒绝', async () => {
    const { base } = await startServer()
    const { status, body } = await postJson(`${base}/api/expand`, { point: '三音动机' })
    assert.equal(status, 400)
    assert.match(body.message, /知识深挖未启用/)
  })

  it('启用后缺少知识点仍返回 400', async () => {
    const { base } = await startServer({ enableDeepSplit: true })
    const { status, body } = await postJson(`${base}/api/expand`, {})
    assert.equal(status, 400)
    assert.match(body.message, /缺少知识点/)
  })
})

describe('静态资源', () => {
  it('返回首页', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/html/)
    assert.match(await res.text(), /课程助手/)
  })

  it('返回样式与脚本', async () => {
    const { base } = await startServer()
    const css = await fetch(`${base}/app.css`)
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type') ?? '', /text\/css/)
    const js = await fetch(`${base}/app.js`)
    assert.match(js.headers.get('content-type') ?? '', /javascript/)
  })

  it('拒绝路径穿越', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/../server.mjs`)
    assert.equal([403, 404].includes(res.status), true)
  })

  it('未知静态文件返回 404', async () => {
    const { base } = await startServer()
    const res = await fetch(`${base}/nope.js`)
    assert.equal(res.status, 404)
  })
})

describe('GET /api/events', () => {
  it('先推一条连接注释与状态快照', async () => {
    const { base } = await startServer()
    const controller = new AbortController()
    const res = await fetch(`${base}/api/events`, { signal: controller.signal })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = res.body.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    assert.match(text, /: connected/)
    assert.match(text, /event: status/)
    controller.abort()
  })
})

describe('未知接口', () => {
  it('POST 到不存在的路由返回 404 JSON', async () => {
    const { base } = await startServer()
    const { status, body } = await postJson(`${base}/api/nope`, {})
    assert.equal(status, 404)
    assert.match(body.message, /未知接口/)
  })
})

describe('全流程：打开开关 → 改间隔 → 关闭', () => {
  it('每一步的状态都与开关一致', async () => {
    const { base, app, configPath } = await startServer()
    const opened = await postJson(`${base}/api/engine`, { action: 'start' })
    assert.equal(opened.body.config.enabled, true)
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).enabled, true)

    const tuned = await postJson(`${base}/api/config`, { pollIntervalMs: 3000 })
    assert.equal(tuned.body.config.pollIntervalMs, 3000)
    assert.equal(app.buildStatus().polling.intervalMs, 3000)

    const closed = await postJson(`${base}/api/engine`, { action: 'stop' })
    assert.equal(closed.body.config.enabled, false)
    const final = app.buildStatus()
    assert.equal(final.engine.running, false)
    assert.equal(final.polling.enabled, false)
    assert.equal(existsSync(join(app.state.config.outputDir, '.state', 'state.json')), true)
  })
})
