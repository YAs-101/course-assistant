/**
 * Tests for the engine layer: the lock, the fake host context, and the
 * start/stop/rebuild cycle.
 *
 * The engine's whole trick is that it can host a plugin written for DeepSeek
 * Harness inside a plain Node process, so these tests drive it with a stand-in
 * module that mimics the real plugin's contract (apply → effect/tools.register).
 * One extra test imports the real plugin when it is installed, because that is
 * the single assumption the whole app rests on.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { DEFAULTS } from '../lib/config.mjs'
import {
  acquireLock,
  LOCK_STALE_MS,
  createEngine,
  createFakeContext,
  detectForeignPolling,
  importCoursemap,
  lockState,
  pidAlive,
  releaseLock,
  touchLock,
} from '../lib/engine.mjs'
import { findCoursemapModule } from '../lib/paths.mjs'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'course-engine-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** A stand-in plugin that records what the host handed it. */
const FAKE_PLUGIN = `
export const name = 'fake-coursemap'
export const DEFAULTS = { enabled: true, pollIntervalMs: 15000 }
export function apply(ctx, config) {
  globalThis.__applied.push(config)
  globalThis.__interval = setInterval(() => {}, config.pollIntervalMs)
  globalThis.__interval.unref?.()
  ctx.tools.register({
    name: 'course_map_status',
    async execute() { return { ok: true, enabled: config.enabled, intervalMs: config.pollIntervalMs } },
  })
  ctx.tools.register({
    name: 'course_map_scan',
    async execute(args) { return { ok: true, title: args?.title ?? null } },
  })
  ctx.effect(() => () => { clearInterval(globalThis.__interval); globalThis.__stopped = true })
  return { config }
}
`

function writeFakePlugin(dir) {
  const file = join(dir, 'fake-plugin.mjs')
  writeFileSync(file, FAKE_PLUGIN, 'utf8')
  return file
}

describe('pidAlive', () => {
  it('当前进程存活', () => {
    assert.equal(pidAlive(process.pid), true)
  })

  it('非法 pid 视为不存活', () => {
    assert.equal(pidAlive(0), false)
    assert.equal(pidAlive(-1), false)
    assert.equal(pidAlive(null), false)
  })
})

describe('lock', () => {
  it('首次获取成功', () => {
    const path = join(tempDir(), 'app.lock.json')
    const result = acquireLock({ path })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'owned')
  })

  it('同一进程可重复获取', () => {
    const path = join(tempDir(), 'app.lock.json')
    acquireLock({ path })
    assert.equal(acquireLock({ path }).mode, 'owned')
  })

  it('过期锁可被抢占', () => {
    const path = join(tempDir(), 'app.lock.json')
    const now = 1_000_000
    acquireLock({ path, now: () => now })
    const later = now + LOCK_STALE_MS + 1000
    const result = acquireLock({ path, now: () => later })
    assert.equal(result.ok, true)
  })

  it('解锁后状态为 free', () => {
    const path = join(tempDir(), 'app.lock.json')
    acquireLock({ path })
    releaseLock({ path })
    assert.equal(lockState({ path }).state, 'free')
  })

  it('心跳刷新 mtime 使锁不过期', () => {
    const path = join(tempDir(), 'app.lock.json')
    acquireLock({ path })
    touchLock({ path })
    const holder = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(holder.pid, process.pid)
  })
})

describe('createFakeContext', () => {
  it('收集注册的工具', () => {
    const fake = createFakeContext({ llm: {} })
    fake.ctx.tools.register({ name: 'a', execute: async () => 1 })
    assert.equal(fake.tools.size, 1)
    assert.equal(typeof fake.getTool('a').execute, 'function')
  })

  it('工具 disposer 会注销', () => {
    const fake = createFakeContext({ llm: {} })
    const dispose = fake.ctx.tools.register({ name: 'a', execute: async () => 1 })
    dispose()
    assert.equal(fake.getTool('a'), null)
  })

  it('get(llm) 与 get(agentDefaultModel) 都可用', () => {
    const llm = { stream: async () => {} }
    const fake = createFakeContext({ llm, selection: { provider: 'p', model: 'm' } })
    assert.equal(fake.ctx.get('llm'), llm)
    assert.equal(fake.ctx.get('agentDefaultModel').currentSelection().model, 'm')
    assert.equal(fake.ctx.llm, llm)
  })

  it('未知服务返回 undefined', () => {
    assert.equal(createFakeContext({ llm: {} }).ctx.get('nope'), undefined)
  })

  it('effect 立即执行并可释放', () => {
    const fake = createFakeContext({ llm: {} })
    let cleaned = false
    fake.ctx.effect(() => () => { cleaned = true })
    assert.equal(fake.disposerCount, 1)
    fake.dispose()
    assert.equal(cleaned, true)
  })

  it('effect 内抛错带上下文信息', () => {
    const fake = createFakeContext({ llm: {} })
    assert.throws(() => fake.ctx.effect(() => { throw new Error('boom') }, '启动轮询'), /初始化失败（启动轮询）：boom/)
  })

  it('注册无 name 的工具会报错', () => {
    const fake = createFakeContext({ llm: {} })
    assert.throws(() => fake.ctx.tools.register({}), /工具定义缺少 name/)
  })

  it('dispose 后不再接受 effect', () => {
    const fake = createFakeContext({ llm: {} })
    fake.dispose()
    fake.ctx.effect(() => { throw new Error('should not run') })
  })
})

describe('importCoursemap', () => {
  it('拒绝不存在的路径', async () => {
    await assert.rejects(() => importCoursemap(join(tempDir(), 'nope.mjs')), /找不到课程插件/)
  })

  it('拒绝没有 apply 的模块', async () => {
    const dir = tempDir()
    const file = join(dir, 'no-apply.mjs')
    writeFileSync(file, 'export const name = "x"', 'utf8')
    await assert.rejects(() => importCoursemap(file), /没有导出 apply/)
  })
})

describe('createEngine', () => {
  function setup(configOverrides = {}) {
    const dir = tempDir()
    const pluginPath = writeFakePlugin(dir)
    const config = { ...DEFAULTS, coursemapModule: pluginPath, outputDir: join(dir, 'map'), ...configOverrides }
    const logs = []
    const engine = createEngine({ getConfig: () => config, llm: {}, log: (line) => logs.push(line) })
    globalThis.__applied = []
    globalThis.__stopped = false
    return { dir, pluginPath, config, engine, logs }
  }

  it('用给定配置启动并描述自身', async () => {
    const { engine, config } = setup()
    const started = await engine.start(config)
    assert.equal(started.ok, true)
    const info = engine.describe()
    assert.equal(info.running, true)
    assert.equal(info.pollIntervalMs, config.pollIntervalMs)
    assert.deepEqual(info.tools.sort(), ['course_map_scan', 'course_map_status'])
    engine.stop()
  })

  it('转发配置给插件且强制 provider', async () => {
    const { engine, config } = setup()
    await engine.start(config)
    const applied = globalThis.__applied.at(-1)
    assert.equal(applied.outputDir, config.outputDir)
    assert.equal(applied.provider, 'deepseek')
    assert.equal(applied.enabled, config.enabled)
    engine.stop()
  })

  it('停止后工具消失', async () => {
    const { engine, config } = setup()
    await engine.start(config)
    engine.stop()
    assert.equal(engine.describe().running, false)
    assert.deepEqual(engine.describe().tools, [])
  })

  it('重复启动会先释放上一个实例', async () => {
    const { engine, config } = setup()
    await engine.start(config)
    await engine.start({ ...config, pollIntervalMs: 4000 })
    assert.equal(globalThis.__stopped, true)
    assert.equal(engine.describe().pollIntervalMs, 4000)
    engine.stop()
  })

  it('callTool 调用已注册工具', async () => {
    const { engine, config } = setup()
    await engine.start(config)
    const result = await engine.callTool('course_map_scan', { title: '标题' })
    assert.equal(result.ok, true)
    assert.equal(result.title, '标题')
    engine.stop()
  })

  it('callTool 对未注册工具给出中文原因', async () => {
    const { engine } = setup()
    const result = await engine.callTool('course_map_scan')
    assert.equal(result.ok, false)
    assert.match(result.message, /未注册/)
  })

  it('模块路径无效时报告失败而不抛错', async () => {
    const { engine } = setup()
    const result = await engine.start({ ...DEFAULTS, coursemapModule: 'C:/nope/none.mjs', outputDir: tempDir() })
    assert.equal(result.ok, false)
    assert.match(result.error, /找不到课程插件/)
    assert.equal(engine.describe().running, false)
  })

  it('rebuild 使用最新的 getConfig', async () => {
    const dir = tempDir()
    const pluginPath = writeFakePlugin(dir)
    let interval = 8000
    const engine = createEngine({
      getConfig: () => ({ ...DEFAULTS, coursemapModule: pluginPath, outputDir: join(dir, 'map'), pollIntervalMs: interval }),
      llm: {},
    })
    globalThis.__applied = []
    await engine.rebuild()
    assert.equal(engine.describe().pollIntervalMs, 8000)
    interval = 3000
    await engine.rebuild()
    assert.equal(engine.describe().pollIntervalMs, 3000)
    engine.stop()
  })
})

describe('detectForeignPolling', () => {
  it('无文件时不算外部轮询', () => {
    const result = detectForeignPolling(tempDir(), { now: () => 1000 })
    assert.equal(result.foreign, false)
  })

  it('文件刚被更新且本进程未轮询时判定为外部轮询', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    const file = join(dir, '.state', 'poll-out.txt')
    writeFileSync(file, 'TITLE=x\nPROC=y\n', 'utf8')
    const result = detectForeignPolling(dir, { now: () => Date.now(), ownPolling: false, intervalMs: 5000 })
    assert.equal(result.foreign, true)
    assert.ok(result.ageMs < 5000)
  })

  it('本进程在轮询时不判定为外部', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    writeFileSync(join(dir, '.state', 'poll-out.txt'), 'TITLE=x\n', 'utf8')
    const result = detectForeignPolling(dir, { now: () => Date.now(), ownPolling: true })
    assert.equal(result.foreign, false)
  })

  it('旧文件不算外部轮询', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    writeFileSync(join(dir, '.state', 'poll-out.txt'), 'TITLE=x\n', 'utf8')
    const result = detectForeignPolling(dir, { now: () => Date.now() + 600_000, ownPolling: false })
    assert.equal(result.foreign, false)
  })

  it('不传 now 时用默认时钟且不抛错', () => {
    // Regression: the default used to be `Date.now()` instead of `Date.now`, which
    // turns the clock into a number and made every status snapshot throw. The temp
    // dirs above never had poll-out.txt, so the bad default was never exercised.
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    writeFileSync(join(dir, '.state', 'poll-out.txt'), 'TITLE=x\n', 'utf8')
    const result = detectForeignPolling(dir, { ownPolling: false })
    assert.equal(result.foreign, true)
    assert.ok(result.ageMs >= 0)
  })

  it('也接受直接传时间戳', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    writeFileSync(join(dir, '.state', 'poll-out.txt'), 'TITLE=x\n', 'utf8')
    const result = detectForeignPolling(dir, { now: Date.now(), ownPolling: false })
    assert.equal(result.foreign, true)
  })
})

describe('真实课程插件（本机安装时）', () => {
  const found = findCoursemapModule()
  const skip = !found.ok ? '未安装 dsh-video-coursemap' : false

  it('能 import 并跑起来，注册出两个工具', { skip }, async () => {
    assert.equal(existsSync(found.path), true)
    const mod = await importCoursemap(found.path)
    assert.equal(typeof mod.apply, 'function')
    const fake = createFakeContext({ llm: { stream: async function* () { yield { type: 'text-delta', text: '{}' } } } })
    const dir = tempDir()
    // The real `apply` returns undefined, and it starts an interval before any
    // assertion can fail, so dispose has to happen in a finally or the test
    // process hangs on the live timer.
    try {
      const returned = await mod.apply(fake.ctx, {
        enabled: false,
        pollIntervalMs: 60000,
        stablePolls: 2,
        titleMinLen: 4,
        fetchContent: false,
        maxTokens: 1024,
        outputDir: dir,
      })
      assert.equal(returned, undefined)
      assert.deepEqual([...fake.tools.keys()].sort(), ['course_map_scan', 'course_map_status'])
      // `apply` writes poll.ps1 eagerly; that file is what /api/probe runs.
      assert.equal(existsSync(join(dir, '.state', 'poll.ps1')), true)
      const status = await fake.getTool('course_map_status').execute({})
      assert.equal(status.enabled, false)
      assert.equal(status.outputDir, dir)
    } finally {
      fake.dispose()
    }
  })

  it('未配置模块路径时自动发现已安装的课程插件', { skip }, async () => {
    // Regression: the engine read `config.coursemapModule` only, which defaults to
    // null, so flipping the switch failed with "找不到课程插件模块" even though the
    // status panel had already discovered the plugin.
    const engine = createEngine({ getConfig: () => ({}), llm: {}, log: () => {} })
    const result = await engine.start({
      ...DEFAULTS,
      coursemapModule: null,
      // Stays off and slow: discovery is what is under test, not polling.
      enabled: false,
      pollIntervalMs: 60000,
      outputDir: tempDir(),
    })
    try {
      assert.equal(result.ok, true, result.error ?? '')
      assert.equal(engine.describe().modulePath, found.path)
    } finally {
      engine.stop()
    }
  })

  it('禁用时 scan 工具直接拒绝', { skip }, async () => {
    const mod = await importCoursemap(found.path)
    const fake = createFakeContext({ llm: {} })
    const dir = tempDir()
    try {
      await mod.apply(fake.ctx, { enabled: false, outputDir: dir, pollIntervalMs: 60000 })
      const result = await fake.getTool('course_map_scan').execute({ title: 'x' })
      assert.equal(result.ok, false)
      assert.match(result.message, /未启用/)
    } finally {
      fake.dispose()
    }
  })
})
