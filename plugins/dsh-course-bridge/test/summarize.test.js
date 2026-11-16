import assert from 'node:assert/strict'
import test from 'node:test'

import { materialMarkdown, materialPrompt, resolveModel, summarizeContent } from '../lib/summarize.js'

const CONTENT = {
  ok: true,
  bvid: 'BV1JxHh6GERK',
  matchedTitle: '我的星铁主题曲来了',
  score: 1,
  aid: 1,
  cid: 2,
  desc: '本期的主题曲\n来自崩坏系列',
  owner: '天秤Dav',
  stat: { view: 12345 },
  transcript: '第一句字幕 第二句字幕',
  danmaku: ['他还是那么爱老崔', '有一种梦核的感觉'],
  danmakuTotal: 1135,
  comments: [
    { message: '这是你吗老师', likes: 494 },
    { message: 'mhy一般用牵绊', likes: 630 },
  ],
  commentsTotal: 2,
  errors: [],
}

/** A fake llm service that streams the given chunks. */
function fakeLlm(chunks, options = {}) {
  return {
    stream(options_) {
      if (options.throws) throw new Error('adapter exploded')
      const list = options.empty ? [] : chunks
      return (async function* generate() {
        for (const chunk of list) yield chunk
      })()
    },
    listProviders() {
      return options.providers || [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-pro' }] }]
    },
  }
}

function ctxWith(llm, extra = {}) {
  const services = { llm, ...extra }
  return { get: (name) => services[name] }
}

test('materialPrompt carries every real source and truncates per field', () => {
  const prompt = materialPrompt(CONTENT, { danmakuLimit: 1, commentsLimit: 1 })
  assert.match(prompt, /视频标题：我的星铁主题曲来了/)
  assert.match(prompt, /UP 主：天秤Dav/)
  assert.match(prompt, /BV 号：BV1JxHh6GERK/)
  assert.match(prompt, /## 视频简介/)
  assert.match(prompt, /## 字幕（节选）/)
  assert.match(prompt, /## 弹幕（共 1135 条/)
  assert.match(prompt, /他还是那么爱老崔/)
  assert.doesNotMatch(prompt, /有一种梦核的感觉/, 'the danmaku cap must apply')
  assert.match(prompt, /\[494 赞\] 这是你吗老师/)
  assert.doesNotMatch(prompt, /mhy一般用牵绊/, 'the comment cap must apply')
})

test('materialPrompt says so when a source is empty', () => {
  const prompt = materialPrompt({ ok: true, desc: '', danmaku: [], comments: [], danmakuTotal: 0 })
  assert.match(prompt, /（简介为空）/)
  assert.match(prompt, /（没有取到弹幕）/)
  assert.match(prompt, /（没有取到评论）/)
})

test('materialMarkdown renders quotes as Markdown the docx renderer accepts', () => {
  const md = materialMarkdown(CONTENT)
  assert.match(md, /### 视频简介/)
  assert.match(md, /> 本期的主题曲/)
  assert.match(md, /### 弹幕节选（共 1135 条）/)
  assert.match(md, /- 他还是那么爱老崔/)
  assert.match(md, /### 热门评论/)
  assert.match(md, /- 这是你吗老师（494 赞）/)
  assert.doesNotMatch(md, /\|/, 'tables are not renderable and must never be emitted')
  assert.equal(materialMarkdown({ ok: false }), '')
  assert.equal(materialMarkdown(null), '')
})

test('resolveModel prefers explicit configuration', () => {
  const ctx = ctxWith(fakeLlm([], { providers: [{ id: 'other', models: [{ id: 'm' }] }] }))
  assert.deepEqual(resolveModel(ctx, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
})

test('resolveModel falls back to the agent default selection', () => {
  const ctx = ctxWith(fakeLlm([]), { agentDefaultModel: { currentSelection: () => ({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }) } })
  assert.deepEqual(resolveModel(ctx, {}), { provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
})

test('resolveModel falls back to the first registered provider, then null', () => {
  const ctx = ctxWith(fakeLlm([], { providers: [{ id: 'deepseek-official', models: [{ id: 'deepseek-v4-pro' }] }] }))
  assert.deepEqual(resolveModel(ctx, {}), { provider: 'deepseek-official', model: 'deepseek-v4-pro' })

  const empty = ctxWith(fakeLlm([], { providers: [] }))
  assert.equal(resolveModel(empty, {}), null)
  assert.equal(resolveModel({ get: () => undefined }, {}), null)
})

test('summarizeContent uses the model and still appends the verifiable material', async () => {
  const ctx = ctxWith(fakeLlm([{ type: 'text-delta', text: '### 视频讲了什么' }, { type: 'text-delta', text: '- 主线' }]))
  const logs = []
  const out = await summarizeContent({ ctx, content: CONTENT, log: (m) => logs.push(m) })
  assert.equal(out.ok, true)
  assert.equal(out.source, 'llm')
  assert.match(out.markdown, /### 视频讲了什么/)
  assert.match(out.markdown, /### 原始素材（可核对）/)
  assert.match(out.markdown, /他还是那么爱老崔/)
  assert.equal(out.incomplete, false)
  assert.ok(logs.some((line) => line.includes('deepseek-official/deepseek-v4-pro')))
})

test('summarizeContent falls back to the raw material when the model fails', async () => {
  const ctx = ctxWith(fakeLlm([], { throws: true }))
  const out = await summarizeContent({ ctx, content: CONTENT })
  assert.equal(out.ok, true)
  assert.equal(out.source, 'fallback')
  assert.match(out.markdown, /### 原始素材（可核对）/)
  assert.match(out.message, /adapter exploded/)
})

test('summarizeContent falls back when the model returns no text', async () => {
  const ctx = ctxWith(fakeLlm([], { empty: true }))
  const out = await summarizeContent({ ctx, content: CONTENT })
  assert.equal(out.ok, true)
  assert.equal(out.source, 'fallback')
  assert.match(out.message, /returned no text/)
})

test('summarizeContent reports no content as unusable instead of inventing one', async () => {
  const ctx = ctxWith(fakeLlm([]))
  const out = await summarizeContent({ ctx, content: { ok: false, reason: 'best match 0.3 is below the threshold' } })
  assert.equal(out.ok, false)
  assert.equal(out.source, 'none')
  assert.equal(out.markdown, '')
  assert.match(out.message, /below the threshold/)
})

test('summarizeContent marks a partial collection as incomplete', async () => {
  const ctx = ctxWith(fakeLlm([{ type: 'text-delta', text: 'ok' }]))
  const out = await summarizeContent({ ctx, content: { ...CONTENT, errors: ['comments: HTTP 412'] } })
  assert.equal(out.incomplete, true, 'a failed sub-request must be surfaced on the cover')
})
