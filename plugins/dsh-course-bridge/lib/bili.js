/*
 * dsh-course-bridge: the Bilibili side of one note.
 *
 * dsh-video-coursemap resolves a browser title to a video with exactly one
 * search query and reads only the first result, so a title the public search
 * index does not rank first silently yields no content at all, and the section
 * that is generated afterwards is pure invention. This module redoes the lookup
 * properly:
 *
 *   title -> candidate queries -> global best match
 *        -> view (aid/cid/desc/subtitle) -> danmaku -> comments
 *
 * Every network step is optional: a failure is recorded and leaves that field
 * empty instead of throwing, so a note is never blocked by Bilibili.
 *
 * @module dsh-course-bridge/lib/bili
 */

/** A desktop Chrome UA: mobile UAs are served a different, thinner payload. */
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_RETRIES = 2

/** Lowest title similarity that still counts as a match, unless overridden. */
export const DEFAULT_MATCH_THRESHOLD = 0.65

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let cachedBuvid3 = null

/**
 * Read (and cache) the buvid3 cookie Bilibili requires.
 *
 * Without it the search endpoint answers with an HTML challenge page instead of
 * JSON, which is why a bare fetch looks like a network failure.
 *
 * @param fetchImpl - fetch-compatible function (injected in tests).
 * @returns the cookie value, or an empty string when it cannot be obtained.
 */
export async function getBuvid3(fetchImpl = fetch) {
  if (cachedBuvid3 !== null) return cachedBuvid3
  try {
    const response = await fetchImpl('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': BILI_UA } })
    const body = await response.json()
    cachedBuvid3 = body && body.data && typeof body.data.b_3 === 'string' ? body.data.b_3 : ''
  } catch {
    cachedBuvid3 = ''
  }
  return cachedBuvid3
}

/** Reset the cached cookie (tests only). */
export function resetBuvid3() {
  cachedBuvid3 = null
}

/**
 * Request headers for every Bilibili endpoint used here.
 * @param buvid3 - value returned by getBuvid3.
 */
export function headersFor(buvid3) {
  const headers = {
    'User-Agent': BILI_UA,
    Referer: 'https://www.bilibili.com/',
    Accept: 'application/json, text/plain, */*',
  }
  if (buvid3) headers.Cookie = 'buvid3=' + buvid3
  return headers
}

/**
 * Fetch one Bilibili URL with the cookie, a timeout, and bounded retries.
 *
 * @param url - absolute URL.
 * @param options - json flag, timeout, retry count, and injected fetch.
 * @returns the parsed body, or raw text when json is false.
 */
export async function biliFetch(url, { json = true, timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, fetchImpl = fetch } = {}) {
  const buvid3 = await getBuvid3(fetchImpl)
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('bilibili request timed out')), timeoutMs)
    try {
      const response = await fetchImpl(url, { headers: headersFor(buvid3), signal: controller.signal })
      if (response.status === 412) throw new Error('bilibili rate limited the request (HTTP 412)')
      if (!response.ok) throw new Error('bilibili answered HTTP ' + response.status)
      const text = await response.text()
      if (!json) return text
      return JSON.parse(text)
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1200 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new Error('bilibili request failed')
}

/** Strip the highlight markup Bilibili embeds in search result titles. */
export function stripHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/<[^>]+>/g, '').trim()
}

/** Decode the XML entities used inside a danmaku document. */
export function decodeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/&#39;|&apos;/g, String.fromCharCode(39))
    .replace(/&nbsp;/g, ' ')
}

/** Comparison form of a title: no whitespace, punctuation, or symbols. */
export function normTitle(value) {
  return String(value === undefined || value === null ? '' : value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * Similarity of two titles in [0, 1]: containment counts as a full match,
 * otherwise the bigram Dice coefficient.
 *
 * Mirrors the metric dsh-video-coursemap uses, so a bridge match means the same
 * thing as a coursemap match and the two layers stay comparable.
 *
 * @param a - first title.
 * @param b - second title.
 */
export function titleSimilar(a, b) {
  const na = normTitle(a)
  const nb = normTitle(b)
  if (!na || !nb) return 0
  if (na.includes(nb) || nb.includes(na)) return 1
  const bigrams = (value) => {
    const set = new Set()
    for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2))
    return set
  }
  const left = bigrams(na)
  const right = bigrams(nb)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared++
  return (2 * shared) / (left.size + right.size)
}

/**
 * Split a browser title into meaningful fragments.
 *
 * Bracketed prefixes and the decorative separators Bilibili titles use are
 * dropped, because a search engine weighs them differently than prose does.
 *
 * @param title - raw video title.
 */
export function splitClauses(title) {
  const cleaned = String(title === undefined || title === null ? '' : title).replace(/[\[【][^\]】]*[\]】]/g, ' ')
  return cleaned
    .split(/[|｜/！!，,。.？?、：:；;（()）\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
}

/**
 * Candidate search queries for one title, most specific first.
 *
 * The search index is fragment based: a long exact title often returns nothing
 * while a two-fragment query returns the video at rank 0. So the query set
 * degrades from the whole title to segment pairs and short clauses, and the
 * caller keeps the global best hit rather than the first hit of the first query.
 *
 * @param title - raw video title.
 * @param maxQueries - hard cap on how many queries are produced.
 * @returns unique queries, most specific first.
 */
export function buildQueries(title, maxQueries = 8) {
  const raw = String(title === undefined || title === null ? '' : title).trim()
  if (raw === '') return []
  const out = []
  const seen = new Set()
  const add = (query) => {
    const value = String(query === undefined || query === null ? '' : query).trim()
    if (value.length < 4 || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }
  add(raw)
  const segments = raw.split(/[|｜]/).map((part) => part.trim()).filter((part) => part !== String())
  for (const segment of segments) add(segment)
  const clauses = splitClauses(raw)
  const longest = [...clauses].sort((a, b) => b.length - a.length)
  for (const clause of longest.slice(0, 3)) add(clause)
  const perSegment = segments.map((segment) => splitClauses(segment))
  for (let i = 0; i < perSegment.length; i++) {
    for (let j = i + 1; j < perSegment.length; j++) {
      const head = perSegment[i][0]
      const tail = perSegment[j][0]
      if (head && tail) add(head + ' ' + tail)
    }
  }
  for (let i = 0; i < longest.length && i < 3; i++) {
    for (let j = i + 1; j < longest.length; j++) {
      add(longest[i] + ' ' + longest[j])
    }
  }
  return out.slice(0, maxQueries)
}

/**
 * Run one search page and return the video results it contained.
 * @param query - search keyword.
 * @param options - page number plus fetch/timeout overrides.
 */
export async function searchVideos(query, { page = 1, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=' +
    page +
    '&keyword=' +
    encodeURIComponent(query)
  const body = await biliFetch(url, { fetchImpl, timeoutMs })
  if (!body || body.code !== 0) throw new Error('bilibili search returned code ' + (body ? body.code : 'none'))
  const results = body.data && Array.isArray(body.data.result) ? body.data.result : []
  return results
    .filter((item) => item && typeof item.bvid === 'string' && item.bvid !== '')
    .map((item) => ({ bvid: item.bvid, title: stripHtml(item.title), aid: item.aid }))
}

/**
 * Resolve a browser title to a real video id.
 *
 * Every candidate query is searched and the highest similarity across all of
 * them wins, so a query that happens to rank some other video first can never
 * win by being tried first.
 *
 * @param title - raw video title.
 * @param options - threshold, query cap, logger, and fetch override.
 * @returns the match, or ok:false with the reason and the closest candidate.
 */
export async function resolveBvid(title, { threshold = DEFAULT_MATCH_THRESHOLD, maxQueries = 8, log, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const queries = buildQueries(title, maxQueries)
  if (queries.length === 0) return { ok: false, reason: 'empty title', best: null, queries: [] }
  let best = null
  const failures = []
  for (const query of queries) {
    let results = []
    try {
      results = await searchVideos(query, { fetchImpl, timeoutMs })
    } catch (error) {
      failures.push(String(error && error.message ? error.message : error))
      continue
    }
    for (const result of results) {
      const score = titleSimilar(title, result.title)
      if (best === null || score > best.score) best = { bvid: result.bvid, title: result.title, score, query }
    }
    if (log) log('搜索「' + query.slice(0, 30) + '」得到 ' + results.length + ' 条，当前最高分 ' + (best ? best.score.toFixed(3) : '0'))
    if (best !== null && best.score >= 0.95) break
    await sleep(700)
  }
  if (best === null) {
    return { ok: false, reason: failures.length ? 'search failed: ' + failures[0] : 'no search result', best: null, queries }
  }
  if (best.score < threshold) {
    return { ok: false, reason: 'best match ' + best.score.toFixed(3) + ' is below the threshold ' + threshold, best, queries }
  }
  return { ok: true, bvid: best.bvid, matchedTitle: best.title, score: best.score, query: best.query, queries }
}

/**
 * Read one video metadata record.
 * @param bvid - video id.
 * @param options - fetch override.
 */
export async function fetchView(bvid, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const body = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), { fetchImpl, timeoutMs })
  if (!body || body.code !== 0) throw new Error('bilibili view returned code ' + (body ? body.code : 'none'))
  const data = body.data || {}
  const pages = Array.isArray(data.pages) ? data.pages : []
  return {
    aid: data.aid,
    cid: data.cid !== undefined ? data.cid : pages[0] && pages[0].cid,
    title: String(data.title || ''),
    desc: String(data.desc || ''),
    owner: data.owner && data.owner.name ? String(data.owner.name) : '',
    stat: data.stat || {},
    subtitle: Array.isArray(data.subtitle && data.subtitle.list) ? data.subtitle.list : [],
  }
}

/**
 * Read the danmaku document of one part.
 *
 * Advanced danmaku (JSON payloads wrapped in brackets) carry no readable text
 * and are dropped.
 *
 * @param cid - part id.
 * @param options - fetch override.
 * @returns raw danmaku strings in document order.
 */
export async function fetchDanmaku(cid, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cid) return []
  const xml = await biliFetch('https://comment.bilibili.com/' + encodeURIComponent(String(cid)) + '.xml', { json: false, fetchImpl, timeoutMs })
  const items = []
  const pattern = /<d[^>]*>([\s\S]*?)<\/d>/g
  const text = String(xml)
  let match = pattern.exec(text)
  while (match !== null) {
    const value = decodeXml(match[1]).trim()
    if (value !== '' && !(value.startsWith('[') && value.endsWith(']'))) items.push(value)
    match = pattern.exec(text)
  }
  return items
}

/**
 * Keep the informative part of a danmaku stream.
 *
 * Most danmaku are noise. Keeping only longer, non-repetitive, deduplicated
 * lines and then sampling evenly instead of truncating gives the summariser
 * opinions from the whole video rather than from its opening seconds.
 *
 * @param items - raw danmaku strings.
 * @param max - how many to keep.
 */
export function pickDanmaku(items, max = 120) {
  const list = Array.isArray(items) ? items : []
  const meaningful = []
  const seen = new Set()
  for (const item of list) {
    const text = String(item === undefined || item === null ? '' : item).replace(/\s+/g, ' ').trim()
    if (text.length < 4) continue
    if (/^[0-9\s.。!！?？~～\-]+$/.test(text)) continue
    if (/^(哈|呵|嘿|w|a|2|6|草|awsl|yyds|绝了|好家伙)+$/i.test(text)) continue
    const folded = normTitle(text)
    if (folded === '' || seen.has(folded)) continue
    seen.add(folded)
    meaningful.push(text)
  }
  if (meaningful.length <= max) return meaningful
  const step = meaningful.length / max
  const sampled = []
  for (let i = 0; i < max; i++) sampled.push(meaningful[Math.floor(i * step)])
  return sampled
}

/**
 * Read the hot comments of one video.
 * @param aid - video aid.
 * @param options - page count, page size, result cap, fetch override.
 * @returns comments ordered by like count, richest first.
 */
export async function fetchComments(aid, { pages = 2, pageSize = 20, limit = 30, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!aid) return []
  const collected = []
  for (let page = 1; page <= pages; page++) {
    const url =
      'https://api.bilibili.com/x/v2/reply?type=1&oid=' +
      encodeURIComponent(String(aid)) +
      '&sort=2&ps=' +
      pageSize +
      '&pn=' +
      page
    let body = null
    try {
      body = await biliFetch(url, { fetchImpl, timeoutMs })
    } catch {
      break
    }
    if (!body || body.code !== 0) break
    const replies = body.data && Array.isArray(body.data.replies) ? body.data.replies : []
    if (replies.length === 0) break
    for (const reply of replies) {
      const message = String(reply && reply.content && reply.content.message ? reply.content.message : '').replace(/\s+/g, ' ').trim()
      if (message === '') continue
      collected.push({ message, likes: Number(reply.like || 0) })
    }
    await sleep(500)
  }
  const seen = new Set()
  return collected
    .filter((item) => {
      if (seen.has(item.message)) return false
      seen.add(item.message)
      return true
    })
    .sort((a, b) => b.likes - a.likes)
    .slice(0, limit)
}

/**
 * Read the subtitle track of one video, when it has one.
 * @param view - result of fetchView.
 * @param options - fetch override.
 * @returns the concatenated subtitle text, or an empty string.
 */
export async function fetchSubtitle(view, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const list = view && Array.isArray(view.subtitle) ? view.subtitle : []
  if (list.length === 0) return String()
  let url = list[0] && list[0].subtitle_url ? String(list[0].subtitle_url) : ''
  if (url === '') return String()
  if (url.startsWith('//')) url = 'https:' + url
  try {
    const body = await biliFetch(url, { fetchImpl, timeoutMs })
    const entries = body && Array.isArray(body.body) ? body.body : []
    return entries
      .map((entry) => String(entry && entry.content ? entry.content : '').trim())
      .filter((entry) => entry !== String())
      .join(' ')
  } catch {
    return String()
  }
}

/**
 * Collect everything one note can be grounded in, for one title.
 *
 * Metadata is fetched first because it yields aid/cid and the subtitle track;
 * danmaku and comments then run in parallel. Any individual failure is recorded
 * in errors and leaves that field empty, and the caller decides whether what is
 * left is still worth summarising.
 *
 * @param title - raw video title.
 * @param options - match threshold, query cap, sampling caps, logger, fetch override.
 * @returns collected content plus the resolution outcome.
 */
export async function collectContent(title, options = {}) {
  const { threshold = DEFAULT_MATCH_THRESHOLD, maxQueries = 8, danmakuLimit = 120, commentsLimit = 30, log, fetchImpl = fetch } = options
  const resolved = await resolveBvid(title, { threshold, maxQueries, log, fetchImpl })
  if (!resolved.ok) return { ok: false, reason: resolved.reason, best: resolved.best, errors: [] }
  const errors = []
  let view = null
  try {
    view = await fetchView(resolved.bvid, { fetchImpl })
  } catch (error) {
    errors.push('view: ' + String(error && error.message ? error.message : error))
  }
  const cid = view && view.cid ? view.cid : null
  const aid = view && view.aid ? view.aid : null
  const settled = await Promise.allSettled([
    cid ? fetchDanmaku(cid, { fetchImpl }) : Promise.resolve([]),
    aid ? fetchComments(aid, { limit: commentsLimit, fetchImpl }) : Promise.resolve([]),
  ])
  const danmakuResult = settled[0]
  const commentsResult = settled[1]
  const rawDanmaku = danmakuResult.status === 'fulfilled' ? danmakuResult.value : []
  if (danmakuResult.status === 'rejected') errors.push('danmaku: ' + String(danmakuResult.reason && danmakuResult.reason.message ? danmakuResult.reason.message : danmakuResult.reason))
  const comments = commentsResult.status === 'fulfilled' ? commentsResult.value : []
  if (commentsResult.status === 'rejected') errors.push('comments: ' + String(commentsResult.reason && commentsResult.reason.message ? commentsResult.reason.message : commentsResult.reason))
  const transcript = view ? await fetchSubtitle(view, { fetchImpl }) : String()
  const danmaku = pickDanmaku(rawDanmaku, danmakuLimit)
  return {
    ok: true,
    bvid: resolved.bvid,
    matchedTitle: resolved.matchedTitle,
    score: resolved.score,
    aid,
    cid,
    desc: view ? view.desc : String(),
    owner: view ? view.owner : String(),
    stat: view ? view.stat : {},
    transcript,
    danmaku,
    danmakuTotal: rawDanmaku.length,
    comments,
    commentsTotal: comments.length,
    errors,
  }
}

/**
 * Compact description of collected content, for logs and the status tool.
 * @param content - result of collectContent.
 */
export function describeContent(content) {
  if (!content || content.ok !== true) return 'no content (' + (content && content.reason ? content.reason : 'not resolved') + ')'
  const parts = [
    'BV ' + content.bvid,
    'match ' + content.score.toFixed(3),
    'desc ' + String(content.desc.length),
    'subtitle ' + String(content.transcript.length),
    'danmaku ' + String(content.danmakuTotal || 0) + '/' + String(content.danmaku.length),
    'comments ' + String(content.commentsTotal || 0),
  ]
  return parts.join(' · ')
}

/** Total amount of grounded material collected, used to decide usefulness. */
export function contentWeight(content) {
  if (!content || content.ok !== true) return 0
  let weight = 0
  weight += Math.min(2000, String(content.desc || String()).length) / 100
  weight += Math.min(4000, String(content.transcript || String()).length) / 100
  weight += (Array.isArray(content.danmaku) ? content.danmaku.length : 0) / 5
  weight += (Array.isArray(content.comments) ? content.comments.length : 0) / 2
  return weight
}
