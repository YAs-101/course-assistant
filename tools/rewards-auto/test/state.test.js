/**
 * Tests for the "today is already earned" marker.
 *
 * This file exists because of a real annoyance: the scheduled task repeats every
 * 30 minutes, so after the first successful run every later attempt launched a
 * visible Edge window only to read a counter that already said 15/15, then closed
 * it seconds later. On 2026-11-20 that produced runs at 08:51 and 09:51 that both
 * ended `already-full` after opening and closing a browser.
 *
 * The marker fixes that, so the properties below are the ones that keep the fix
 * from turning into a way to silently lose a day:
 *
 *   - a marker for another date never counts;
 *   - a marker read just after midnight is not trusted (the counter may not have
 *     reset yet, and skipping would cost the whole day);
 *   - only statuses that actually observed a full counter may write one.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  TRUST_AFTER_MINUTES,
  dayKey,
  isKnownFullToday,
  isTrustWindowOpen,
  minutesSinceMidnight,
  readDailyState,
  shouldCacheFull,
  writeDailyState,
} from '../lib/state.mjs'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rewards-state-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/** A local Date at a fixed hour on a fixed day. */
const at = (hour, minute = 0) => new Date(2026, 10, 20, hour, minute, 0)

describe('dayKey', () => {
  it('用本地日历日期，月和日补零', () => {
    assert.equal(dayKey(new Date(2026, 10, 20, 15, 4, 3)), '2026-11-20')
    assert.equal(dayKey(new Date(2026, 0, 5, 0, 0, 0)), '2026-01-05')
  })

  it('同一天的不同时刻得到同一个键', () => {
    assert.equal(dayKey(at(0)), dayKey(at(23, 59)))
  })
})

describe('minutesSinceMidnight / isTrustWindowOpen', () => {
  it('从午夜起算的分钟数', () => {
    assert.equal(minutesSinceMidnight(at(0, 0)), 0)
    assert.equal(minutesSinceMidnight(at(8, 21)), 501)
    assert.equal(minutesSinceMidnight(at(23, 59)), 1439)
  })

  it('午夜刚过时信任窗口是关的', () => {
    assert.equal(isTrustWindowOpen(at(0, 0)), false)
    assert.equal(isTrustWindowOpen(at(0, TRUST_AFTER_MINUTES - 1)), false)
  })

  it('过了阈值就打开', () => {
    assert.equal(isTrustWindowOpen(at(0, TRUST_AFTER_MINUTES)), true)
    assert.equal(isTrustWindowOpen(at(9, 51)), true)
  })
})

describe('readDailyState', () => {
  it('文件不存在时返回 null', () => {
    assert.equal(readDailyState(join(tempDir(), 'missing.json')), null)
  })

  it('读回写下的内容', () => {
    const file = join(tempDir(), 'state.json')
    writeDailyState(file, { balance: 1473, progress: 15, max: 15 }, at(8, 22))
    const state = readDailyState(file)
    assert.equal(state.date, '2026-11-20')
    assert.equal(state.full, true)
    assert.equal(state.balance, 1473)
  })

  it('空文件、坏 JSON、数组都当作"什么都不知道"', () => {
    const dir = tempDir()
    for (const [name, body] of [
      ['empty.json', '   \n'],
      ['torn.json', '{"date":"2026-11-20","full":tr'],
      ['array.json', '[]'],
      ['null.json', 'null'],
    ]) {
      const file = join(dir, name)
      writeFileSync(file, body, 'utf8')
      assert.equal(readDailyState(file), null, name)
    }
  })

  it('带 BOM 也能读', () => {
    const file = join(tempDir(), 'state.json')
    writeFileSync(file, '\uFEFF{"date":"2026-11-20","full":true}', 'utf8')
    assert.equal(readDailyState(file).full, true)
  })
})

describe('isKnownFullToday', () => {
  const good = { date: '2026-11-20', full: true, progress: 15, max: 15 }

  it('当天写入、且已过信任窗口时成立', () => {
    assert.equal(isKnownFullToday(good, at(9, 51)), true)
  })

  it('别的日期的标记不算', () => {
    assert.equal(isKnownFullToday({ ...good, date: '2026-11-19' }, at(9, 51)), false)
  })

  it('午夜刚过不信任（计数器可能还没重置）', () => {
    assert.equal(isKnownFullToday(good, at(0, 5)), false)
  })

  it('full 必须是布尔 true，字符串不算', () => {
    assert.equal(isKnownFullToday({ ...good, full: 'true' }, at(9, 51)), false)
    assert.equal(isKnownFullToday({ ...good, full: 1 }, at(9, 51)), false)
  })

  it('null / 非对象 / 缺字段都不算', () => {
    assert.equal(isKnownFullToday(null, at(9, 51)), false)
    assert.equal(isKnownFullToday('x', at(9, 51)), false)
    assert.equal(isKnownFullToday({ date: '2026-11-20' }, at(9, 51)), false)
  })
})

describe('shouldCacheFull', () => {
  const full = { pcSearch: { progress: 15, max: 15 } }

  it('观察满额并以成功状态结束才写标记', () => {
    for (const status of ['ok', 'already-full', 'closed-with-extra-targets', 'edge-left-running']) {
      assert.equal(shouldCacheFull(status, full), true, status)
    }
  })

  it('失败的运行一律不写，避免把坏掉的一天变成静默跳过', () => {
    for (const status of ['failed', 'no-progress', 'not-signed-in', 'skipped-edge-busy']) {
      assert.equal(shouldCacheFull(status, full), false, status)
    }
  })

  it('没读到满额就不写', () => {
    assert.equal(shouldCacheFull('ok', { pcSearch: { progress: 12, max: 15 } }), false)
    assert.equal(shouldCacheFull('already-full', { pcSearch: { progress: 0, max: 15 } }), false)
  })

  it('上限为 0 或状态缺失时不算满额', () => {
    assert.equal(shouldCacheFull('ok', { pcSearch: { progress: 0, max: 0 } }), false)
    assert.equal(shouldCacheFull('ok', null), false)
    assert.equal(shouldCacheFull('ok', {}), false)
  })
})

describe('writeDailyState', () => {
  it('写出可读的 JSON，字段齐全', () => {
    const file = join(tempDir(), 'nested', 'state.json')
    const record = writeDailyState(file, { balance: 1473, progress: 15, max: 15 }, at(8, 22))
    assert.equal(record.date, '2026-11-20')
    assert.equal(record.balance, 1473)
    assert.match(record.at, /^2026-11-20T/)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.progress, 15)
  })

  it('缺参数写成 null 而不是 NaN', () => {
    const file = join(tempDir(), 'state.json')
    const record = writeDailyState(file, {}, at(8, 22))
    assert.equal(record.balance, null)
    assert.equal(record.progress, null)
    assert.equal(record.max, null)
  })

  it('缺 file 抛错（调用方会记警告）', () => {
    assert.throws(() => writeDailyState(null, {}), /file is required/)
  })
})
