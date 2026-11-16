import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import bridge, { resolveConfig } from '../index.js'
import { SEGMENT_DELIMITER } from '../lib/manual.js'
import { readBridge } from '../lib/state.js'
import { keyOf } from '../lib/util.js'

const SCRIPT = join(process.cwd(), 'scripts', 'md2docx.py')
const TITLE = '示例课程：从零开始'
const SUBJECT = 'AI工具'

function manualFor(subject, title) {
  return ['# ' + subject + ' 学习手册', '## ' + title + '\n\n> 简介\n\n### 核心知识点\n- 要点一'].join(SEGMENT_DELIMITER) + '\n'
}

function writeState(dir, subjects) {
  const stateDir = join(dir, '.state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ subjects, seen: {}, lastTitle: '', lastRunAt: 1 }), 'utf8')
}

function writeManual(dir, subject, title) {
  const manuals = join(dir, '.state', 'manuals')
  mkdirSync(manuals, { recursive: true })
  writeFileSync(join(manuals, subject + '.md'), manualFor(subject, title), 'utf8')
}

function makeCtx(calls) {
  const registered = []
  const effects = []
  const services = {
    sessionController: {
      async create(request) {
        calls.push(['create', request])
        return { sessionId: 'sess-' + calls.length }
      },
      async prompt(request) {
        calls.push(['prompt', request])
        return { accepted: true }
      },
      async rename(request) {
        return { title: request.title, seq: 1 }
      },
    },
    fileUploads: {
      async uploadStream(request) {
        for await (const _chunk of request.data) void _chunk
        return { receiptId: 'rcpt-' + calls.length }
      },
    },
    sessions: {
      get: (id) => ({ id }),
      async flush() {},
    },
  }
  return {
    ctx: {
      get: (name) => services[name],
      effect(fn) {
        const disposer = fn()
        effects.push(disposer)
        return () => {
          if (typeof disposer === 'function') disposer()
        }
      },
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
    },
    registered,
    effects,
    services,
  }
}

function makeOptions(dir, overrides) {
  // fetchContent: false keeps these tests offline; grounding has its own suite.
  return Object.assign({ outputDir: dir, deliverCwd: dir, watchIntervalMs: 60000, pythonPath: 'python', fetchContent: false }, overrides || {})
}

test('resolveConfig rejects a typo instead of silently ignoring it', () => {
  assert.throws(() => resolveConfig({ watchIntervaMs: 1000 }), /unknown configuration key/)
  assert.throws(() => resolveConfig({ watchIntervalMs: 0 }), /must be a positive number/)
  const config = resolveConfig({ outputDir: 'D:/x' })
  assert.equal(config.deliverCwd, 'D:/x', 'deliverCwd defaults to outputDir')
  assert.equal(config.agentPreset, null, 'agentPreset must stay unset unless configured')
})

test('resolveConfig defaults to grounded notes and validates the new knobs', () => {
  const config = resolveConfig({ outputDir: 'D:/x' })
  assert.equal(config.fetchContent, true, 'notes are grounded by default')
  assert.equal(config.summarize, true)
  assert.equal(config.includeManualSection, true)
  assert.equal(config.matchThreshold, 0.65)
  assert.equal(config.maxQueries, 8)
  assert.equal(config.maxTokens, 3000)
  assert.equal(config.provider, null, 'the provider is resolved from the agent default')
  assert.equal(config.model, null)

  assert.equal(resolveConfig({ fetchContent: false }).fetchContent, false)
  assert.equal(resolveConfig({ summarize: false }).summarize, false)
  assert.equal(resolveConfig({ includeManualSection: false }).includeManualSection, false)
  assert.equal(resolveConfig({ provider: 'p', model: 'm' }).provider, 'p')
  assert.throws(() => resolveConfig({ matchThreshold: 0 }), /matchThreshold/)
  assert.throws(() => resolveConfig({ matchThreshold: 1.5 }), /matchThreshold/)
  assert.throws(() => resolveConfig({ maxTokens: 0 }), /must be a positive number/)
  assert.throws(() => resolveConfig({ maxQueries: -1 }), /must be a positive number/)

  assert.equal(config.sessionPermissionPreset, 'danger-full-access', 'a delivery session must not inherit a confined default')
  assert.equal(resolveConfig({ sessionPermissionPreset: '  ' }).sessionPermissionPreset, null, 'blank means leave the session default alone')
  assert.equal(resolveConfig({ sessionPermissionPreset: 'read-only' }).sessionPermissionPreset, 'read-only')
})

test('apply registers both tools with a renderable output schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-apply-'))
  const harness = makeCtx([])
  bridge.apply(harness.ctx, makeOptions(dir))
  const names = harness.registered.map((definition) => definition.name).sort()
  assert.deepEqual(names, ['course_note_deliver', 'course_note_status'])
  for (const definition of harness.registered) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(typeof definition.parameters, 'object')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    const rendered = definition.output.render({}, Object.fromEntries(definition.output.schema.required.map((k) => [k, k === 'ok' ? true : 'x'])))
    assert.equal(Array.isArray(rendered), true)
  }
  assert.equal(existsSync(join(dir, '.state')), true)
  assert.equal(existsSync(join(dir, '笔记')), true)
})

test('the first scan settles history without delivering because initialBackfill is false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-first-'))
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [TITLE] } })
  writeManual(dir, SUBJECT, TITLE)
  const calls = []
  const harness = makeCtx(calls)
  const plugin = bridge.apply(harness.ctx, makeOptions(dir))
  const outcome = await plugin.scanOnce({ force: true })
  assert.equal(outcome.delivered, 0)
  assert.deepEqual(calls, [])
  const ledger = readBridge(join(dir, '.state', 'bridge.json'))
  assert.equal(ledger.initialized, true)
  assert.equal(ledger.delivered[keyOf(SUBJECT, TITLE)].skipped, true)
})

test('a video appearing after initialisation is delivered as a Word note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-new-'))
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [] } })
  const calls = []
  const harness = makeCtx(calls)
  const plugin = bridge.apply(harness.ctx, makeOptions(dir))
  await plugin.scanOnce({ force: true })
  assert.deepEqual(calls, [], 'an empty state must stay silent')

  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [TITLE] } })
  writeManual(dir, SUBJECT, TITLE)
  const outcome = await plugin.scanOnce({ force: true })
  assert.equal(outcome.delivered, 1, outcome.message)
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'prompt'])

  const prompt = calls[1][1]
  assert.equal(prompt.content[0].type, 'file')
  assert.equal(prompt.content[1].type, 'text')

  const ledger = readBridge(join(dir, '.state', 'bridge.json'))
  const record = ledger.delivered[keyOf(SUBJECT, TITLE)]
  assert.equal(record.subject, SUBJECT)
  assert.equal(record.title, TITLE)
  assert.equal(record.sessionId, 'sess-1')
  assert.equal(existsSync(record.docxPath), true)
  assert.equal(record.docxPath.endsWith('.docx'), true)

  const again = await plugin.scanOnce({ force: true })
  assert.equal(again.delivered, 0, 'a settled video must stay silent')
  assert.equal(calls.length, 2)
})

test('a missing subject manual is retried with backoff instead of crashing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-nomanual-'))
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [] } })
  const calls = []
  const plugin = bridge.apply(makeCtx(calls).ctx, makeOptions(dir))
  await plugin.scanOnce({ force: true })
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [TITLE] } })

  const outcome = await plugin.scanOnce({ force: true })
  assert.equal(outcome.delivered, 0)
  assert.equal(outcome.failed, 1)
  const ledger = readBridge(join(dir, '.state', 'bridge.json'))
  const pending = ledger.pending[keyOf(SUBJECT, TITLE)]
  assert.equal(pending.attempts, 1)
  assert.match(pending.lastError, /manuals/)
  assert.ok(pending.nextTryAt > Date.now() - 1000)
  assert.deepEqual(calls, [])
})

test('a corrupt state.json is reported and delivers nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-corrupt-'))
  writeState(dir, {})
  writeFileSync(join(dir, '.state', 'state.json'), '{oops', 'utf8')
  const calls = []
  const plugin = bridge.apply(makeCtx(calls).ctx, makeOptions(dir))
  const outcome = await plugin.scanOnce({ force: true })
  assert.equal(outcome.delivered, 0)
  assert.match(outcome.message, /not valid JSON/)
  assert.deepEqual(calls, [])
})

test('the status tool reports the ledger in human-readable form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-status-'))
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [TITLE] } })
  writeManual(dir, SUBJECT, TITLE)
  const harness = makeCtx([])
  const plugin = bridge.apply(harness.ctx, makeOptions(dir))
  await plugin.scanOnce({ force: true })
  const status = harness.registered.find((d) => d.name === 'course_note_status')
  const value = await status.execute({})
  for (const key of status.output.schema.required) assert.ok(key in value, 'missing ' + key)
  assert.equal(value.subjects, 1)
  assert.equal(value.videos, 1)
  assert.match(value.details, /观察目录/)
})

test('course_note_deliver refuses politely when nothing can be re-delivered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-tool-'))
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [TITLE] } })
  writeManual(dir, SUBJECT, TITLE)
  const harness = makeCtx([])
  const plugin = bridge.apply(harness.ctx, makeOptions(dir))
  await plugin.scanOnce({ force: true })
  const tool = harness.registered.find((d) => d.name === 'course_note_deliver')
  const missed = await tool.execute({ title: '不存在的标题' })
  assert.equal(missed.ok, false)
  assert.match(missed.message, /没有找到匹配的视频/)
  const settled = await tool.execute({})
  assert.equal(settled.ok, false)
  assert.match(settled.message, /都已投递或已放弃/)
})

test('course_note_deliver with force re-delivers an already settled video', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-force-'))
  writeState(dir, { [SUBJECT]: { createdAt: 1, videos: [TITLE] } })
  writeManual(dir, SUBJECT, TITLE)
  const calls = []
  const harness = makeCtx(calls)
  const plugin = bridge.apply(harness.ctx, makeOptions(dir))
  await plugin.scanOnce({ force: true })
  const tool = harness.registered.find((d) => d.name === 'course_note_deliver')

  const settled = await tool.execute({})
  assert.equal(settled.ok, false)

  const forced = await tool.execute({ force: true })
  assert.equal(forced.ok, true, forced.message)
  assert.equal(calls.filter((c) => c[0] === 'create').length, 1, 'force must open one more session')
  const ledger = readBridge(join(dir, '.state', 'bridge.json'))
  assert.equal(Object.keys(ledger.delivered).length, 1)
  assert.equal(Object.keys(ledger.pending).length, 0)
  assert.equal(Object.keys(ledger.abandoned).length, 0)
})

test('a disabled plugin registers no watcher and reports disabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-disabled-'))
  const harness = makeCtx([])
  const plugin = bridge.apply(harness.ctx, makeOptions(dir, { enabled: false }))
  const outcome = await plugin.scanOnce({ force: true })
  assert.equal(outcome.message, 'disabled')
  assert.equal(harness.registered.length, 2, 'tools stay available so the user can inspect state')
})

test('the packaged md2docx.py is shipped next to index.js', () => {
  assert.equal(existsSync(SCRIPT), true)
  assert.ok(readFileSync(SCRIPT, 'utf8').length > 1000)
})