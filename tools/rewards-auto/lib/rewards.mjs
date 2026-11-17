/**
 * Reading the rewards status out of the Bing flyout endpoint.
 *
 * Why not `rewards.bing.com/api/getuserinfo`: on this network that host times
 * out and the endpoint 404s from cn.bing.com. The only endpoint that answers is
 * `https://cn.bing.com/rewards/panelflyout/getuserinfo`, which returns the same
 * dashboard data under `flyoutResult.userStatus.counters`.
 *
 * The counter keys are `PCSearch`, `ActivityAndQuiz` and `DailyPoint` -- note
 * the capitalisation; `pcSearch` is a different (older) shape and reading it
 * would silently always report zero progress.
 *
 * The response is large (hundreds of KB), so the page code returns only the
 * handful of fields the runner needs, already JSON-stringified.
 */
import { CdpError } from './cdp.mjs'

/** Expression evaluated in the page: fetch the flyout and project the fields. */
export const READ_EXPRESSION = `(async () => {
  const response = await fetch('/rewards/panelflyout/getuserinfo', {
    credentials: 'include',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) return JSON.stringify({ error: 'http ' + response.status })
  const data = await response.json()
  return JSON.stringify(data)
})()`

/**
 * Project the raw flyout payload into the small shape the runner uses.
 *
 * Pure, so the parsing rules are testable against a trimmed real response. A
 * missing `PCSearch` counter is an error rather than a zero: it means the
 * account is signed out or Microsoft changed the payload, and quietly assuming
 * "no progress possible" would look like a successful run.
 *
 * The error carries the top-level keys that *were* present. A half-loaded
 * response (the endpoint answers 200 before the dashboard is filled in) is a
 * different fault from a signed-out one, and without the keys the two look
 * identical in the log.
 *
 * @param json - parsed flyout payload.
 * @returns `{ balance, country, isRewardsUser, level, pcSearch, dailyPoint,
 *   activityAndQuiz }`.
 */
export function parseUserInfo(json) {
  if (!json || typeof json !== 'object') throw new Error('rewards: payload is not an object')
  if (json.error) throw new Error(`rewards: request failed (${json.error})`)
  const userInfo = json.userInfo ?? {}
  const flyout = json.flyoutResult ?? {}
  const userStatus = flyout.userStatus ?? {}
  const counters = userStatus.counters ?? {}

  const first = (name) => {
    const list = counters[name]
    if (!Array.isArray(list) || list.length === 0) return null
    const item = list[0] ?? {}
    const progress = Number(item.pointProgress ?? item.p ?? 0)
    const max = Number(item.pointProgressMax ?? item.m ?? 0)
    return {
      progress: Number.isFinite(progress) ? progress : 0,
      max: Number.isFinite(max) ? max : 0,
    }
  }

  const pcSearch = first('PCSearch')
  if (!pcSearch) {
    const keys = Object.keys(counters)
    throw new Error(
      'rewards: counters.PCSearch missing (not signed in, or the rewards payload changed)' +
        ` [top=${Object.keys(json).join(',') || 'none'}` +
        ` counters=${keys.join(',') || 'none'}` +
        ` countersType=${Array.isArray(counters) ? 'array' : typeof counters}]`,
    )
  }

  const balance = Number(userInfo.balance ?? userStatus.balance ?? 0)
  return {
    balance: Number.isFinite(balance) ? balance : 0,
    country: userInfo.rewardsCountry ?? null,
    isRewardsUser: userInfo.isRewardsUser === true,
    level: userStatus.levelInfo?.activeLevelName ?? null,
    pcSearch,
    dailyPoint: first('DailyPoint'),
    activityAndQuiz: first('ActivityAndQuiz'),
  }
}

/** How many points of desktop search progress are still on the table today. */
export function searchRemaining(state) {
  const max = Number(state?.pcSearch?.max ?? 0)
  const progress = Number(state?.pcSearch?.progress ?? 0)
  if (!Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, max - progress)
}

/** True when today's search points are exhausted. */
export function isFull(state) {
  return searchRemaining(state) === 0
}

/**
 * Read the rewards status through an attached page.
 *
 * The page must be on a `cn.bing.com` origin; the caller navigates home first.
 *
 * @returns the projected state from `parseUserInfo`.
 */
export async function readStatus({ cdp, sid, expression = READ_EXPRESSION }) {
  let raw = null
  try {
    raw = await cdp.evaluate(expression, sid)
  } catch (error) {
    if (error instanceof CdpError) throw new Error(`rewards: evaluate failed (${error.message})`)
    throw error
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('rewards: endpoint returned no body (not signed in?)')
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`rewards: endpoint returned non-JSON (${String(raw).slice(0, 80)})`)
  }
  return parseUserInfo(parsed)
}

/** One-line human summary of a state, used in logs and the final report. */
export function describeState(state) {
  if (!state) return 'no state'
  const pc = state.pcSearch ?? { progress: 0, max: 0 }
  return `balance=${state.balance} pcSearch=${pc.progress}/${pc.max} level=${state.level ?? '?'}`
}
