/**
 * Tests for reading the Bing rewards flyout payload.
 *
 * The payload shape is not documented and its keys are easy to get wrong --
 * `PCSearch` with capital letters, nested under `flyoutResult.userStatus.counters`
 * as a one-element array. A wrong key does not throw, it silently reports zero
 * progress, so every rule here is pinned against a trimmed real response.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  describeState,
  isFull,
  parseUserInfo,
  searchRemaining,
} from '../lib/rewards.mjs'

/** A trimmed real response: balance 1437, daily search pool exhausted. */
function payload({
  balance = 1437,
  pcProgress = 15,
  pcMax = 15,
  isRewardsUser = true,
  country = 'cn',
  withPcSearch = true,
} = {}) {
  const counters = {
    ActivityAndQuiz: [{ pointProgress: 9, pointProgressMax: 1480 }],
    DailyPoint: [{ pointProgress: 24, pointProgressMax: 1495 }],
  }
  if (withPcSearch) counters.PCSearch = [{ pointProgress: pcProgress, pointProgressMax: pcMax }]
  return {
    userInfo: { balance, rewardsCountry: country, isRewardsUser },
    flyoutResult: {
      userStatus: {
        counters,
        levelInfo: { activeLevelName: '会员' },
      },
      dailySetPromotions: {},
    },
  }
}

describe('parseUserInfo', () => {
  it('读取余额、地区与搜索进度', () => {
    const state = parseUserInfo(payload())
    assert.equal(state.balance, 1437)
    assert.equal(state.country, 'cn')
    assert.equal(state.isRewardsUser, true)
    assert.deepEqual(state.pcSearch, { progress: 15, max: 15 })
    assert.equal(state.level, '会员')
  })

  it('大写键 PCSearch 之外的 dailyPoint/activityAndQuiz 也解析出来', () => {
    const state = parseUserInfo(payload())
    assert.deepEqual(state.dailyPoint, { progress: 24, max: 1495 })
    assert.deepEqual(state.activityAndQuiz, { progress: 9, max: 1480 })
  })

  it('容忍小写的 p/m 字段名', () => {
    const raw = payload()
    raw.flyoutResult.userStatus.counters.PCSearch = [{ p: 6, m: 15 }]
    assert.deepEqual(parseUserInfo(raw).pcSearch, { progress: 6, max: 15 })
  })

  it('缺 PCSearch 时报错而不是当作 0 进度', () => {
    assert.throws(
      () => parseUserInfo(payload({ withPcSearch: false })),
      /PCSearch missing/,
    )
  })

  it('接口错误对象直接抛出', () => {
    assert.throws(() => parseUserInfo({ error: 'http 404' }), /request failed \(http 404\)/)
  })

  it('非对象输入报错', () => {
    assert.throws(() => parseUserInfo(null), /not an object/)
    assert.throws(() => parseUserInfo('nope'), /not an object/)
  })
})

describe('searchRemaining / isFull', () => {
  it('15/15 时剩余为 0 且判定已满', () => {
    const state = parseUserInfo(payload({ pcProgress: 15 }))
    assert.equal(searchRemaining(state), 0)
    assert.equal(isFull(state), true)
  })

  it('9/15 时还剩 6 分', () => {
    const state = parseUserInfo(payload({ pcProgress: 9 }))
    assert.equal(searchRemaining(state), 6)
    assert.equal(isFull(state), false)
  })

  it('进度超过上限时不会算出负数', () => {
    const state = parseUserInfo(payload({ pcProgress: 18 }))
    assert.equal(searchRemaining(state), 0)
    assert.equal(isFull(state), true)
  })

  it('上限为 0 的自适应情形按已完成处理', () => {
    const state = parseUserInfo(payload({ pcProgress: 0, pcMax: 0 }))
    assert.equal(searchRemaining(state), 0)
  })
})

describe('describeState', () => {
  it('一行里带上余额与搜索进度', () => {
    const text = describeState(parseUserInfo(payload({ pcProgress: 6 })))
    assert.match(text, /balance=1437/)
    assert.match(text, /pcSearch=6\/15/)
  })

  it('无状态时不抛错', () => {
    assert.equal(describeState(null), 'no state')
  })
})
