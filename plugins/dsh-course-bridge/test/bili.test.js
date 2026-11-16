import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MATCH_THRESHOLD,
  buildQueries,
  collectContent,
  decodeXml,
  fetchComments,
  fetchDanmaku,
  fetchSubtitle,
  getBuvid3,
  normTitle,
  pickDanmaku,
  resetBuvid3,
  resolveBvid,
  searchVideos,
  stripHtml,
  titleSimilar,
} from '../lib/bili.js'

const RAW = '我的星铁主题曲来了！崩坏系列音乐大赏Vol.03 | 职业音乐制作人Reaction听评畅聊'
const SEARCH = 'x/web-interface/search/type'
const VIEW = 'x/web-interface/view'
const REPLY = 'x/v2/reply'

function jsonResponse(body) {
  const text = JSON.stringify(body)
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) }
}

function textResponse(text, status = 200) {
  const ok = status >= 200 && status < 300
  return { ok, status, text: async () => text, json: async () => JSON.parse(text) }
}

/**
 * A fetch stand-in that never touches the network.
 *
 * The cookie probe is answered for every test because biliFetch resolves it
 * lazily on each call; the routes then decide the endpoint under test.
 */
function makeFetch(routes) {
  const calls = []
  const impl = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('/x/frontend/finger/spi')) return jsonResponse({ code: 0, data: { b_3: 'buvid-value' } })
    for (const route of routes) {
      if (target.includes(route[0])) return route[1](target)
    }
    throw new Error('unexpected url: ' + target)
  }
  impl.calls = calls
  return impl
}

test('normTitle folds case, punctuation, and whitespace', () => {
  assert.equal(normTitle('Hello, World!'), 'helloworld')
  assert.equal(normTitle('  我的星铁主题曲来了！！  '), '我的星铁主题曲来了')
  assert.equal(normTitle(undefined), '')
})

test('titleSimilar treats containment as a full match', () => {
  assert.equal(titleSimilar('我的星铁主题曲来了', '我的星铁主题曲来了 崩坏系列音乐大赏'), 1)
  assert.equal(titleSimilar('完全一样的标题', '完全一样的标题'), 1)
  assert.ok(titleSimilar('完全无关的标题', '我的星铁主题曲来了') < 0.3)
})

test('stripHtml and decodeXml clean Bilibili payloads', () => {
  assert.equal(stripHtml('<em class="keyword">深蓝</em>教程'), '深蓝教程')
  assert.equal(decodeXml('好听&amp;上头&quot;好&quot;&#39;'), '好听&上头"好"' + String.fromCharCode(39))
})

test('buildQueries degrades from the full title to fragment pairs', () => {
  const queries = buildQueries(RAW, 8)
  assert.equal(queries[0], RAW, 'the exact title is tried first')
  assert.ok(queries.includes('职业音乐制作人Reaction听评畅聊'))
  assert.equal(new Set(queries).size, queries.length, 'queries must be unique')
  assert.ok(queries.every((query) => query.length >= 4))
  assert.deepEqual(buildQueries('abc', 8), [], 'too short to be searchable')
  assert.deepEqual(buildQueries('   ', 8), [])
})

test('buildQueries respects the cap', () => {
  assert.equal(buildQueries(RAW, 3).length, 3)
})

test('resolveBvid keeps the global best match instead of the first hit', async () => {
  resetBuvid3()
  const raw = '我的星铁主题曲来了 崩坏系列音乐大赏'
  const fetchImpl = makeFetch([
    [
      SEARCH,
      (url) => {
        const keyword = decodeURIComponent(url.split('keyword=')[1])
        if (keyword === '我的星铁主题曲来了') {
          return jsonResponse({ code: 0, data: { result: [{ bvid: 'BVreal', title: raw, aid: 1 }] } })
        }
        return jsonResponse({ code: 0, data: { result: [{ bvid: 'BVdecoy', title: '我的星铁主题曲来了 另一个人的反应', aid: 2 }] } })
      },
    ],
  ])
  const out = await resolveBvid(raw, { maxQueries: 2, fetchImpl })
  assert.equal(out.ok, true, out.reason)
  assert.equal(out.bvid, 'BVreal')
  assert.equal(out.score, 1)
  assert.equal(out.query, '我的星铁主题曲来了')
})

test('resolveBvid refuses a weak match instead of guessing', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([
    [SEARCH, () => jsonResponse({ code: 0, data: { result: [{ bvid: 'BVother', title: '一个毫不相干的视频', aid: 3 }] } })],
  ])
  const out = await resolveBvid('完全不一样的课程标题', { maxQueries: 1, threshold: 0.9, fetchImpl })
  assert.equal(out.ok, false)
  assert.match(out.reason, /below the threshold/)
  assert.equal(out.best.bvid, 'BVother')
  assert.equal(DEFAULT_MATCH_THRESHOLD, 0.65)
})

test('resolveBvid reports a search failure without throwing', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([[SEARCH, () => jsonResponse({ code: -400, message: 'bad request' })]])
  const out = await resolveBvid('完全不一样的课程标题', { maxQueries: 1, fetchImpl })
  assert.equal(out.ok, false)
  assert.equal(out.best, null)
})

test('searchVideos drops entries without a bvid and unescapes titles', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([
    [SEARCH, () => jsonResponse({ code: 0, data: { result: [{ bvid: 'BV1', title: '<em>深蓝</em>教程' }, { title: 'no id' }] } })],
  ])
  const results = await searchVideos('深蓝教程', { fetchImpl })
  assert.deepEqual(results, [{ bvid: 'BV1', title: '深蓝教程', aid: undefined }])
})

test('getBuvid3 caches the cookie and survives a failure', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([])
  assert.equal(await getBuvid3(fetchImpl), 'buvid-value')
  assert.equal(await getBuvid3(fetchImpl), 'buvid-value')
  assert.equal(fetchImpl.calls.length, 1, 'the probe must only run once')

  resetBuvid3()
  const failing = async () => {
    throw new Error('network down')
  }
  assert.equal(await getBuvid3(failing), '')
  resetBuvid3()
})

test('fetchDanmaku decodes entities and drops advanced danmaku', async () => {
  resetBuvid3()
  const xml = '<i><d p="1,2">好听&amp;上头</d><d p="1,2">[高级弹幕]</d><d p="1,2">   </d><d p="1,2">梦核的感觉</d></i>'
  const fetchImpl = makeFetch([['comment.bilibili.com/42.xml', () => textResponse(xml)]])
  const items = await fetchDanmaku(42, { fetchImpl })
  assert.deepEqual(items, ['好听&上头', '梦核的感觉'])
  assert.deepEqual(await fetchDanmaku(null, { fetchImpl }), [], 'a missing cid must not fail')
})

test('pickDanmaku drops noise and samples the whole stream', () => {
  const noisy = ['666', '哈哈哈哈', '短', '这就是音乐的魅力', '这就是音乐的魅力', '1', 'awsl', '123 456']
  assert.deepEqual(pickDanmaku(noisy), ['这就是音乐的魅力'])

  const many = []
  for (let i = 0; i < 200; i++) many.push('第 ' + String(i) + ' 条有意义的弹幕')
  const picked = pickDanmaku(many, 10)
  assert.equal(picked.length, 10)
  assert.equal(picked[0], '第 0 条有意义的弹幕')
  assert.ok(picked[9].startsWith('第 1'), 'the sample must reach the end of the stream')
  assert.deepEqual(pickDanmaku(null), [])
})

test('fetchComments deduplicates and orders by likes', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([
    [
      REPLY,
      (url) => {
        if (url.includes('pn=1')) {
          return jsonResponse({
            code: 0,
            data: { replies: [{ content: { message: '第一条' }, like: 5 }, { content: { message: '第二条' }, like: 9 }] },
          })
        }
        return jsonResponse({ code: 0, data: { replies: [{ content: { message: '第二条' }, like: 9 }, { content: { message: '第三条' }, like: 1 }] } })
      },
    ],
  ])
  const comments = await fetchComments(7, { pages: 2, fetchImpl })
  assert.deepEqual(comments.map((item) => item.message), ['第二条', '第一条', '第三条'])
  assert.equal(comments[0].likes, 9)
  assert.deepEqual(await fetchComments(null, { fetchImpl }), [])
})

test('fetchSubtitle joins the track of the first subtitle', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([['aisubtitle/1.json', () => jsonResponse({ body: [{ content: '第一句' }, { content: '第二句' }] })]])
  const text = await fetchSubtitle({ subtitle: [{ subtitle_url: '//aisubtitle/1.json' }] }, { fetchImpl })
  assert.equal(text, '第一句 第二句')
  assert.equal(await fetchSubtitle({ subtitle: [] }, { fetchImpl }), '')
})

test('collectContent assembles metadata, danmaku, and comments', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([
    [SEARCH, () => jsonResponse({ code: 0, data: { result: [{ bvid: 'BV1JxHh6GERK', title: RAW, aid: 11 }] } })],
    [
      VIEW,
      () =>
        jsonResponse({
          code: 0,
          data: {
            aid: 117374493659519,
            cid: 42413525564,
            title: RAW,
            desc: '本期的主题曲',
            owner: { name: '天秤Dav' },
            stat: { view: 12345 },
            subtitle: [],
          },
        }),
    ],
    [['comment.bilibili.com/42413525564.xml'].join(''), () => textResponse('<i><d p="1">他还是那么爱老崔</d></i>')],
    [REPLY, () => jsonResponse({ code: 0, data: { replies: [{ content: { message: '这是你吗老师' }, like: 494 }] } })],
  ])
  const content = await collectContent(RAW, { fetchImpl })
  assert.equal(content.ok, true, content.reason)
  assert.equal(content.bvid, 'BV1JxHh6GERK')
  assert.equal(content.aid, 117374493659519)
  assert.equal(content.cid, 42413525564)
  assert.equal(content.desc, '本期的主题曲')
  assert.equal(content.owner, '天秤Dav')
  assert.equal(content.danmakuTotal, 1)
  assert.deepEqual(content.danmaku, ['他还是那么爱老崔'])
  assert.equal(content.comments[0].message, '这是你吗老师')
  assert.equal(content.comments[0].likes, 494)
  assert.equal(content.transcript, '')
  assert.deepEqual(content.errors, [])
})

test('collectContent records a view failure instead of throwing', async () => {
  resetBuvid3()
  const fetchImpl = makeFetch([
    [SEARCH, () => jsonResponse({ code: 0, data: { result: [{ bvid: 'BV1JxHh6GERK', title: RAW, aid: 11 }] } })],
    [VIEW, () => jsonResponse({ code: -404, message: '啥都木有' })],
  ])
  const content = await collectContent(RAW, { fetchImpl })
  assert.equal(content.ok, true)
  assert.equal(content.aid, null)
  assert.equal(content.desc, '')
  assert.deepEqual(content.danmaku, [])
  assert.equal(content.errors.length, 1)
  assert.match(content.errors[0], /^view: /)
})
