/**
 * Tests for the search typing helpers.
 *
 * What is pinned here is the part that took the longest to get right on the real
 * machine: searches only earn rewards points when they arrive as synthesized key
 * events, not as a URL navigation. So the event field names matter -- `text` and
 * `unmodifiedText` on keyDown, `windowsVirtualKeyCode` on Enter -- and a typo in
 * either silently stops all scoring.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ENTER_EVENTS, QUERY_POOL, keyEventFor, pickQueries, rngMs } from '../lib/search.mjs'

describe('QUERY_POOL', () => {
  it('至少 12 条，够一天用而不重复', () => {
    assert.ok(QUERY_POOL.length >= 12, `pool too small: ${QUERY_POOL.length}`)
  })

  it('每条都是单行且不含制表符', () => {
    for (const query of QUERY_POOL) {
      assert.equal(typeof query, 'string')
      assert.ok(query.length > 0)
      assert.ok(!/[\r\n\t]/.test(query), `bad whitespace in "${query}"`)
      assert.equal(query, query.trim())
    }
  })

  it('池内没有重复项', () => {
    assert.equal(new Set(QUERY_POOL).size, QUERY_POOL.length)
  })
})

describe('pickQueries', () => {
  it('返回指定数量且互不重复', () => {
    const picked = pickQueries(5)
    assert.equal(picked.length, 5)
    assert.equal(new Set(picked).size, 5)
    for (const query of picked) assert.ok(QUERY_POOL.includes(query))
  })

  it('请求数超过池长时截断到池长', () => {
    assert.equal(pickQueries(QUERY_POOL.length + 10).length, QUERY_POOL.length)
  })

  it('0 或负数返回空数组', () => {
    assert.deepEqual(pickQueries(0), [])
    assert.deepEqual(pickQueries(-3), [])
  })

  it('相同 rng 序列得到相同结果（可复现）', () => {
    const seq = [0.1, 0.9, 0.5]
    const makeRng = () => {
      let i = 0
      return () => seq[i++ % seq.length]
    }
    assert.deepEqual(pickQueries(3, { rng: makeRng() }), pickQueries(3, { rng: makeRng() }))
  })

  it('自定义池被尊重', () => {
    const picked = pickQueries(2, { pool: ['a', 'b', 'c'], rng: () => 0 })
    assert.deepEqual(picked, ['a', 'b'])
  })
})

describe('keyEventFor', () => {
  it('keyDown 同时带 text 与 unmodifiedText', () => {
    const events = keyEventFor('黄')
    assert.equal(events.down.type, 'keyDown')
    assert.equal(events.down.text, '黄')
    assert.equal(events.down.unmodifiedText, '黄')
    assert.equal(events.down.key, '黄')
  })

  it('keyUp 只带 key', () => {
    const events = keyEventFor('a')
    assert.equal(events.up.type, 'keyUp')
    assert.equal(events.up.key, 'a')
    assert.equal(events.up.text, undefined)
  })

  it('ASCII 字符原样传递', () => {
    assert.equal(keyEventFor('z').down.text, 'z')
    assert.equal(keyEventFor(' ').down.text, ' ')
  })
})

describe('ENTER_EVENTS', () => {
  it('回车带 13 号虚拟键码，否则 Bing 不提交', () => {
    assert.equal(ENTER_EVENTS.down.key, 'Enter')
    assert.equal(ENTER_EVENTS.down.windowsVirtualKeyCode, 13)
    assert.equal(ENTER_EVENTS.down.nativeVirtualKeyCode, 13)
    assert.equal(ENTER_EVENTS.up.type, 'keyUp')
    assert.equal(ENTER_EVENTS.up.windowsVirtualKeyCode, 13)
  })
})

describe('rngMs', () => {
  it('落在闭区间内', () => {
    for (let i = 0; i < 50; i += 1) {
      const value = rngMs(90, 230)
      assert.ok(value >= 90 && value <= 230, `${value} out of range`)
    }
  })

  it('上界小于下界时退化为下界，不抛错', () => {
    assert.equal(rngMs(200, 100, () => 0), 200)
  })

  it('负数按 0 处理', () => {
    assert.equal(rngMs(-50, -10, () => 0.5), 0)
  })
})
