import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { applyPermissionPreset, deliverOne, groundNote, noteSections, promptText, requireService, sourceLabel } from '../lib/deliver.js'
import { findPython } from '../lib/docx.js'
import { SEGMENT_DELIMITER } from '../lib/manual.js'

const SCRIPT = join(process.cwd(), 'scripts', 'md2docx.py')
const VIDEO = { subject: 'AI工具', title: '示例视频标题' }
/** Grounding is covered by its own tests: keep these delivery-only. */
const OFFLINE = { fetchContent: false }
const MANUAL = ['# AI工具 学习手册', '## 示例视频标题\n\n> 简介\n\n### 核心知识点\n- 要点'].join(SEGMENT_DELIMITER) + '\n'

function makeConfig(dir, overrides) {
  return Object.assign(
    {
      notesDir: dir,
      pythonPath: findPython(),
      scriptPath: SCRIPT,
      noteBaseName: () => 'note',
      createRequest: () => ({ cwd: dir }),
      sessionTitleFor: (video) => '课程笔记 · ' + video.title,
    },
    overrides || {},
  )
}

function makeCtx(calls, options) {
  const opts = options || {}
  const services = {
    sessionController: {
      async create(request) {
        calls.push(['create', request])
        return { sessionId: 'sess-new' }
      },
      async prompt(request, signal) {
        if (opts.promptThrows) throw new Error('prompt refused')
        calls.push(['prompt', request, Boolean(signal)])
        return { accepted: true }
      },
      async rename(request) {
        if (opts.renameThrows) throw new Error('rename refused')
        calls.push(['rename', request])
        return { title: request.title, seq: 1 }
      },
    },
    fileUploads: {
      async uploadStream(request) {
        const chunks = []
        for await (const chunk of request.data) chunks.push(chunk)
        calls.push(['upload', request.name, Buffer.concat(chunks).subarray(0, 4).toString('hex')])
        return opts.noReceipt ? {} : { receiptId: 'rcpt-1' }
      },
    },
    sessions: {
      get(sessionId) {
        return { id: sessionId }
      },
      async flush(session) {
        calls.push(['flush', session.id])
      },
    },
  }
  if (opts.without) delete services[opts.without]
  return {
    get(name) {
      return services[name]
    },
  }
}

test('requireService names the service it could not find', () => {
  assert.equal(requireService({ get: () => ({ ok: 1 }) }, 'x').ok, 1)
  assert.throws(() => requireService({ get: () => undefined }, 'fileUploads'), /"fileUploads" is not mounted/)
})

test('promptText names the subject and asks for a summary', () => {
  const text = promptText(VIDEO)
  assert.match(text, /学科：AI工具/)
  assert.match(text, /视频：示例视频标题/)
  assert.match(text, /弹幕/)
})

test('deliverOne runs create -> upload -> prompt -> rename -> flush in order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-'))
  const calls = []
  const logs = []
  const out = await deliverOne({
    ctx: makeCtx(calls),
    config: makeConfig(dir, OFFLINE),
    video: VIDEO,
    manualText: MANUAL,
    previous: {},
    log: (m) => logs.push(m),
  })

  assert.equal(out.ok, true, out.message)
  assert.equal(out.step, 'done')
  assert.equal(out.sessionId, 'sess-new')
  assert.equal(out.degraded, false)
  assert.equal(out.title, '课程笔记 · 示例视频标题')
  assert.match(out.requestId, /^[0-9a-f-]{36}$/)

  assert.deepEqual(calls.map((c) => c[0]), ['create', 'upload', 'prompt', 'rename', 'flush'])
  assert.deepEqual(calls[0][1], { cwd: dir })
  assert.equal(calls[1][2], '504b0304', 'the uploaded stream must be the converted .docx')
  assert.match(calls[1][1], /\.docx$/)

  const prompt = calls[2][1]
  assert.equal(prompt.sessionId, 'sess-new')
  assert.equal(prompt.requestId, out.requestId)
  assert.equal(calls[2][2], true, 'prompt must receive an abort signal')
  assert.deepEqual(prompt.content[0], { type: 'file', receiptId: 'rcpt-1' })
  assert.equal(prompt.content[1].type, 'text')
  assert.ok(prompt.content[1].text.trim().length > 0)
  assert.equal(calls[4][1], 'sess-new')
})

test('deliverOne reuses a previously converted .docx and session without redoing work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-reuse-'))
  const docxPath = join(dir, 'note.docx')
  writeFileSync(docxPath, Buffer.from('504b0304', 'hex'))
  const calls = []
  const out = await deliverOne({
    ctx: makeCtx(calls),
    config: makeConfig(dir, Object.assign({ fetchContent: false }, { pythonPath: 'definitely-not-python-xyz' })),
    video: VIDEO,
    manualText: MANUAL,
    previous: { docxPath, sessionId: 'sess-old', requestId: 'req-fixed' },
  })

  assert.equal(out.ok, true, out.message)
  assert.equal(out.docxPath, docxPath)
  assert.equal(out.sessionId, 'sess-old')
  assert.equal(out.requestId, 'req-fixed')
  assert.deepEqual(calls.map((c) => c[0]), ['upload', 'prompt', 'rename', 'flush'])
  assert.equal(calls[1][1].requestId, 'req-fixed', 'a retry must reuse the idempotency key')
})

test('deliverOne reports a conversion failure and never creates a session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-conv-'))
  const calls = []
  const out = await deliverOne({
    ctx: makeCtx(calls),
    config: makeConfig(dir, Object.assign({ fetchContent: false }, { pythonPath: 'definitely-not-python-xyz' })),
    video: VIDEO,
    manualText: MANUAL,
    previous: {},
  })
  assert.equal(out.ok, false)
  assert.equal(out.step, 'convert')
  assert.deepEqual(calls, [])
})

test('deliverOne fails cleanly when uploadStream returns no receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-rcpt-'))
  const docxPath = join(dir, 'note.docx')
  writeFileSync(docxPath, Buffer.from('504b0304', 'hex'))
  const calls = []
  const out = await deliverOne({
    ctx: makeCtx(calls, { noReceipt: true }),
    config: makeConfig(dir, OFFLINE),
    video: VIDEO,
    manualText: MANUAL,
    previous: { docxPath, sessionId: 'sess-old' },
  })
  assert.equal(out.ok, false)
  assert.equal(out.step, 'upload')
  assert.deepEqual(calls.map((c) => c[0]), ['upload'])
})

test('deliverOne throws when a host service is missing so the note can be retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-missing-'))
  const docxPath = join(dir, 'note.docx')
  writeFileSync(docxPath, Buffer.from('504b0304', 'hex'))
  await assert.rejects(
    deliverOne({
      ctx: makeCtx([], { without: 'fileUploads' }),
      config: makeConfig(dir, OFFLINE),
      video: VIDEO,
      manualText: MANUAL,
      previous: { docxPath, sessionId: 'sess-old' },
    }),
    /"fileUploads" is not mounted/,
  )
})

test('deliverOne keeps the note when renaming fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-rename-'))
  const docxPath = join(dir, 'note.docx')
  writeFileSync(docxPath, Buffer.from('504b0304', 'hex'))
  const logs = []
  const out = await deliverOne({
    ctx: makeCtx([], { renameThrows: true }),
    config: makeConfig(dir, OFFLINE),
    video: VIDEO,
    manualText: MANUAL,
    previous: { docxPath, sessionId: 'sess-old' },
    log: (m) => logs.push(m),
  })
  assert.equal(out.ok, true)
  assert.equal(out.title, '')
  assert.ok(logs.some((m) => m.includes('改标题失败')))
})

test('deliverOne degrades to the whole manual when the section is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-degrade-'))
  const calls = []
  const logs = []
  const out = await deliverOne({
    ctx: makeCtx(calls),
    config: makeConfig(dir, Object.assign({ fetchContent: false }, { pythonPath: findPython() })),
    video: { subject: 'AI工具', title: '根本没出现在手册里的标题' },
    manualText: MANUAL,
    previous: {},
    log: (m) => logs.push(m),
  })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.degraded, true)
  assert.ok(logs.some((m) => m.includes('降级')))
})

test('promptFailure propagates so the ledger records the attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-deliver-promptfail-'))
  const docxPath = join(dir, 'note.docx')
  writeFileSync(docxPath, Buffer.from('504b0304', 'hex'))
  await assert.rejects(
    deliverOne({
      ctx: makeCtx([], { promptThrows: true }),
      config: makeConfig(dir, OFFLINE),
      video: VIDEO,
      manualText: MANUAL,
      previous: { docxPath, sessionId: 'sess-old' },
    }),
    /prompt refused/,
  )
})

test('sourceLabel states where the note body came from', () => {
  assert.match(sourceLabel('llm'), /模型总结/)
  assert.match(sourceLabel('fallback'), /原文/)
  assert.match(sourceLabel(''), /未经素材核对/)
  assert.match(sourceLabel(undefined), /未经素材核对/)
})

test('noteSections puts the real-material summary first and hides the inferred draft when degraded', () => {
  const summary = { ok: true, markdown: '### 视频讲了什么\n- 主线' }
  const blocks = noteSections({ section: '### 核心知识点\n- 要点', summary })
  assert.equal(blocks.length, 2)
  assert.match(blocks[0].heading, /知识总结/)
  assert.match(blocks[1].heading, /未经素材核对/)

  const degraded = noteSections({ section: 'MANUAL', summary, degraded: true })
  assert.equal(degraded.length, 1, 'a degraded section is the whole manual and must be shown alone')
})

test('noteSections still shows the manual when there is no grounded summary', () => {
  const blocks = noteSections({ section: '### 核心知识点\n- 要点', summary: null })
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].heading, /未经素材核对/)

  const empty = noteSections({ section: '', summary: { ok: false, markdown: '' } })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].heading, '')
})

test('groundNote stays offline when fetchContent is disabled', async () => {
  const out = await groundNote({ ctx: { get: () => undefined }, video: VIDEO, config: { fetchContent: false }, log: () => {} })
  assert.deepEqual(out, { summary: null, content: null })
})

test('promptText warns when the material was incomplete and names the source', () => {
  const text = promptText(VIDEO, { source: 'llm', incomplete: true })
  assert.match(text, /总结来源：视频简介\/字幕\/弹幕\/评论 \+ 模型总结/)
  assert.match(text, /部分素材抓取失败/)
})


test('applyPermissionPreset seeds a new session like delegation does', () => {
  const events = []
  const session = { append: (type, data) => events.push([type, data]) }
  const ctx = {
    get(name) {
      if (name === 'permissionPresets') return { resolve: (n) => ({ sandbox: 'danger-full-access', approval: 'never', name: n }) }
      if (name === 'sessions') return { get: () => session }
      return undefined
    },
  }
  assert.equal(applyPermissionPreset({ ctx, sessionId: 's1', name: 'danger-full-access' }), true)
  assert.deepEqual(events, [
    ['permission/preset', { preset: 'danger-full-access' }],
    ['sandbox/mode', { mode: 'danger-full-access', source: 'course-bridge' }],
    ['approval/policy', { policy: 'never', source: 'course-bridge' }],
  ])
})

test('applyPermissionPreset degrades quietly instead of failing a delivery', () => {
  const logs = []
  const log = (m) => logs.push(m)
  assert.equal(applyPermissionPreset({ ctx: { get: () => undefined }, sessionId: 's1', name: 'danger-full-access', log }), false)
  assert.match(logs[0], /permissionPresets/)
  assert.equal(applyPermissionPreset({ ctx: { get: () => undefined }, sessionId: 's1', name: null, log }), false, 'unset preset means leave the session alone')

  const throwing = { get: (n) => (n === 'permissionPresets' ? { resolve: () => { throw new Error('permission: unknown preset "x"') } } : undefined) }
  assert.equal(applyPermissionPreset({ ctx: throwing, sessionId: 's1', name: 'x', log }), false)
  assert.match(logs[logs.length - 1], /unknown preset/)

  const noSession = { get: (n) => (n === 'permissionPresets' ? { resolve: () => ({ sandbox: 'read-only', approval: 'never' }) } : undefined) }
  assert.equal(applyPermissionPreset({ ctx: noSession, sessionId: 's1', name: 'read-only', log }), false)
})

test('deliverOne applies the permission preset once, on session creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-preset-'))
  const calls = []
  const events = []
  const ctx = makeCtx(calls)
  const base = ctx.get
  const session = { id: 'sess-new', append: (type, data) => events.push([type, data]) }
  ctx.get = (name) => {
    if (name === 'permissionPresets') return { resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }) }
    if (name === 'sessions') return { get: () => session, async flush() {} }
    return base(name)
  }
  const out = await deliverOne({
    ctx,
    config: makeConfig(dir, Object.assign({}, OFFLINE, { sessionPermissionPreset: 'danger-full-access' })),
    video: VIDEO,
    manualText: MANUAL,
    previous: {},
    log: () => {},
  })
  assert.equal(out.ok, true, out.message)
  assert.deepEqual(events.map((e) => e[0]), ['permission/preset', 'sandbox/mode', 'approval/policy'])
})

test('deliverOne skips the preset when it reuses an existing session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-preset-reuse-'))
  const calls = []
  const events = []
  const ctx = makeCtx(calls)
  const base = ctx.get
  ctx.get = (name) => {
    if (name === 'permissionPresets') return { resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }) }
    if (name === 'sessions') return { get: () => ({ id: 'prev-session', append: (t2, d) => events.push([t2, d]) }) }
    return base(name)
  }
  const first = await deliverOne({
    ctx,
    config: makeConfig(dir, Object.assign({}, OFFLINE, { sessionPermissionPreset: 'danger-full-access' })),
    video: VIDEO,
    manualText: MANUAL,
    previous: {},
    log: () => {},
  })
  assert.equal(first.ok, true, first.message)
  events.length = 0
  // A retry with the same ledger entry reuses the session; no new events pile up.
  await deliverOne({
    ctx,
    config: makeConfig(dir, Object.assign({}, OFFLINE, { sessionPermissionPreset: 'danger-full-access' })),
    video: VIDEO,
    manualText: MANUAL,
    previous: { sessionId: 'prev-session', docxPath: first.docxPath, requestId: first.requestId },
    log: () => {},
  })
  assert.deepEqual(events, [])
})
