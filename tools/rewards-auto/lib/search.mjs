/**
 * Performing a search the way the rewards backend will credit.
 *
 * What was measured on this machine, in order of discovery:
 *
 *   - `Page.navigate` to `https://cn.bing.com/search?q=...` performs the search
 *     and even hits `/rewardsapp/reportActivity`, but earns nothing. The
 *     backend wants the search to come out of the page's own input pipeline.
 *   - Synthesizing real `Input.dispatchKeyEvent` keyDown/keyUp per character
 *     into `#sb_form_q`, then Enter, does earn points (+3 per search).
 *   - A minimized window earns nothing unless focus emulation is on, because
 *     `document.visibilityState` becomes `hidden` and the key events land on an
 *     unfocused document.
 *
 * So a search here is: navigate home, focus the box, type character by
 * character with human-ish gaps, press Enter, then wait for the results page.
 */
import { CdpError } from './cdp.mjs'

/**
 * Query pool. Real-looking, varied, and deliberately boring -- nothing that
 * would return unsafe results, since these pages really do load.
 */
export const QUERY_POOL = Object.freeze([
  '今天天气',
  '荷叶粥的做法',
  '太湖面积',
  '钢琴调音多少钱',
  '红烧肉怎么做好吃',
  '睡眠不足的危害',
  '杭州到上海高铁',
  '猫为什么喜欢纸箱',
  '咖啡因半衰期',
  '笔记本电脑散热',
  '秋天适合去哪里旅游',
  'how to boil an egg',
  'photosynthesis for kids',
  'time zone converter',
])

/**
 * Pick `count` distinct queries at random.
 *
 * Distinctness matters: repeating the same query in a row is the most obvious
 * automation signature, and the pool is long enough that it costs nothing to
 * avoid. More queries than the pool is clamped instead of throwing, because a
 * misconfigured `maxSearchesPerRun` should not abort a run.
 *
 * @param count - how many to pick.
 * @param options - `pool` and `rng` are injectable for tests.
 */
export function pickQueries(count, { pool = QUERY_POOL, rng = Math.random } = {}) {
  const source = Array.isArray(pool) && pool.length > 0 ? pool : QUERY_POOL
  const wanted = Math.max(0, Math.min(Math.floor(Number(count) || 0), source.length))
  const copy = source.slice()
  const out = []
  for (let i = 0; i < wanted; i += 1) {
    const index = Math.min(copy.length - 1, Math.floor(rng() * copy.length))
    out.push(copy.splice(index, 1)[0])
  }
  return out
}

/** A jittered delay in `[min, max]`, so typing never has a mechanical cadence. */
export function rngMs(min, max, rng = Math.random) {
  const lo = Math.max(0, Number(min) || 0)
  const hi = Math.max(lo, Number(max) || lo)
  return lo + Math.floor(rng() * (hi - lo + 1))
}

/**
 * The CDP key events for one character.
 *
 * Exported and pure so a test can assert the field names CDP expects
 * (`text`/`unmodifiedText` for keyDown, `windowsVirtualKeyCode` for Enter)
 * without launching a browser.
 */
export function keyEventFor(char) {
  return {
    down: { type: 'keyDown', text: char, unmodifiedText: char, key: char },
    up: { type: 'keyUp', key: char },
  }
}

/** The Enter pair, with the virtual key code Edge waits for before submitting. */
export const ENTER_EVENTS = Object.freeze({
  down: {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  },
  up: {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  },
})

/** Focus the search box and clear whatever is in it. */
const FOCUS_EXPRESSION = `(() => {
  const box = document.querySelector('#sb_form_q')
  if (!box) return 0
  box.focus()
  box.value = ''
  if (typeof box.select === 'function') box.select()
  return 1
})()`

/** Whether the results page has rendered, and how many organic results it has. */
const RESULTS_EXPRESSION = `(() => {
  const list = document.querySelectorAll('#b_results > li.b_algo')
  return JSON.stringify({ ready: !!document.querySelector('#b_results'), count: list.length })
})()`

/** Poll `probe` until it returns truthy, or throw after `timeoutMs`. */
async function waitFor(probe, { timeoutMs, intervalMs = 250, sleep }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(intervalMs)
  }
}

/**
 * Run one credited search.
 *
 * @param options.cdp - connected client.
 * @param options.sid - page session id.
 * @param options.query - the query to type.
 * @param options.config - `homeUrl`, wait budgets, jitter windows.
 * @param options.sleep - injectable delay (tests pass a no-op).
 * @param options.log - optional logger.
 * @returns `{ query, url, resultCount, typed }`; `typed:false` means the box
 *   never appeared and the caller should count it as a failure.
 */
export async function searchOnce({ cdp, sid, query, config, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log }) {
  const homeUrl = config?.homeUrl ?? 'https://cn.bing.com/'
  const boxTimeout = config?.boxTimeoutMs ?? 15000
  const resultsTimeout = config?.resultsTimeoutMs ?? 20000
  const minGap = config?.minSearchGapMs ?? 2500
  const maxGap = config?.maxSearchGapMs ?? 6000

  await cdp.send('Page.navigate', { url: homeUrl }, sid, { timeoutMs: 30000 })
  const focused = await waitFor(
    async () => {
      try {
        return await cdp.evaluate(FOCUS_EXPRESSION, sid)
      } catch (error) {
        if (error instanceof CdpError) return 0
        throw error
      }
    },
    { timeoutMs: boxTimeout, sleep },
  )
  if (!focused) return { query, url: null, resultCount: 0, typed: false }

  for (const char of query) {
    const events = keyEventFor(char)
    await cdp.send('Input.dispatchKeyEvent', events.down, sid, { timeoutMs: 8000 })
    await cdp.send('Input.dispatchKeyEvent', events.up, sid, { timeoutMs: 8000 })
    await sleep(rngMs(90, 230))
  }
  await cdp.send('Input.dispatchKeyEvent', ENTER_EVENTS.down, sid, { timeoutMs: 8000 })
  await cdp.send('Input.dispatchKeyEvent', ENTER_EVENTS.up, sid, { timeoutMs: 8000 })

  const landed = await waitFor(
    async () => {
      try {
        const current = await cdp.evaluate('location.href', sid)
        if (!String(current ?? '').includes('/search?')) return null
        const raw = await cdp.evaluate(RESULTS_EXPRESSION, sid)
        if (!raw) return null
        const info = JSON.parse(raw)
        return info.ready ? info : null
      } catch (error) {
        if (error instanceof CdpError) return null
        throw error
      }
    },
    { timeoutMs: resultsTimeout, sleep },
  )
  if (!landed) return { query, url: null, resultCount: 0, typed: true }

  const url = await cdp.evaluate('location.href', sid).catch(() => null)
  // Dwell like a reader would; the backend sees the visit, not just the hit.
  if (config?.scroll !== false) {
    await cdp.evaluate('window.scrollBy(0, 600)', sid).catch(() => null)
  }
  await sleep(rngMs(minGap, maxGap))
  if (log) log.info('search', { query, url, resultCount: landed.count })
  return { query, url, resultCount: landed.count, typed: true }
}
