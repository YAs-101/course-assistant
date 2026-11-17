/**
 * Tests for the entry point's pure helpers.
 *
 * `pickPageTarget` exists because of a real failure: `/json/list` calls the id
 * `id`, while `Target.attachToTarget` wants `targetId`. Forwarding the listing
 * entry verbatim sent `targetId: undefined`, and Chrome rejected it with
 * "Invalid parameters" before any search ran. `parseArgs` is pinned so the
 * scheduled wrapper's flags keep meaning what the README says they mean.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { countsAsCreditingFailure, parseArgs, pickPageTarget, readStatusWithRetry } from '../run.mjs'

const PAGE = {
  id: 'ABC123',
  type: 'page',
  url: 'about:blank',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/ABC123',
}

describe('pickPageTarget', () => {
  it('把 /json/list 的 id 映射成 targetId', () => {
    const picked = pickPageTarget([PAGE])
    assert.equal(picked.targetId, 'ABC123')
    assert.equal(picked.webSocketDebuggerUrl, PAGE.webSocketDebuggerUrl)
  })

  it('跳过 service worker 与其它非 page 目标', () => {
    const picked = pickPageTarget([
      { id: 'W1', type: 'service_worker', webSocketDebuggerUrl: 'ws://x/sw' },
      { id: 'I1', type: 'iframe', webSocketDebuggerUrl: 'ws://x/frame' },
      PAGE,
    ])
    assert.equal(picked.targetId, 'ABC123')
  })

  it('没有 page 目标时返回 null', () => {
    assert.equal(pickPageTarget([{ id: 'W1', type: 'service_worker', webSocketDebuggerUrl: 'ws://x' }]), null)
    assert.equal(pickPageTarget([]), null)
    assert.equal(pickPageTarget(null), null)
  })

  it('缺 webSocketDebuggerUrl 的目标不算数', () => {
    assert.equal(pickPageTarget([{ id: 'P', type: 'page' }]), null)
  })

  it('已经有 targetId 时保留它', () => {
    const picked = pickPageTarget([{ ...PAGE, targetId: 'ZZZ' }])
    assert.equal(picked.targetId, 'ZZZ')
  })
})

describe('countsAsCreditingFailure', () => {
  it('有进账就不算失败', () => {
    assert.equal(countsAsCreditingFailure(3, false), false)
    assert.equal(countsAsCreditingFailure(3, true), false)
  })

  it('没进账且未满额才算失败', () => {
    assert.equal(countsAsCreditingFailure(0, false), true)
    assert.equal(countsAsCreditingFailure(-3, false), true)
  })

  it('已满额时的零进账是正常结果（--force 会走到这条）', () => {
    assert.equal(countsAsCreditingFailure(0, true), false)
  })
})

describe('readStatusWithRetry', () => {
  const noSleep = async () => {}

  it('第一次就读到就不重试', async () => {
    let calls = 0
    const value = await readStatusWithRetry({
      read: async () => {
        calls += 1
        return { ok: true }
      },
      sleep: noSleep,
    })
    assert.deepEqual(value, { ok: true })
    assert.equal(calls, 1)
  })

  it('计数器还没填好时重试后成功（实测过的竞态）', async () => {
    let calls = 0
    const value = await readStatusWithRetry({
      read: async () => {
        calls += 1
        if (calls < 3) throw new Error('rewards: counters.PCSearch missing')
        return { pcSearch: { progress: 15, max: 15 } }
      },
      sleep: noSleep,
    })
    assert.equal(value.pcSearch.progress, 15)
    assert.equal(calls, 3)
  })

  it('重试期间会上报进度，便于日志看出是竞态', async () => {
    const retries = []
    await readStatusWithRetry({
      attempts: 3,
      read: async () => {
        throw new Error('nope')
      },
      sleep: noSleep,
      onRetry: (attempt, error) => retries.push([attempt, error.message]),
    }).catch(() => {})
    assert.deepEqual(retries, [
      [1, 'nope'],
      [2, 'nope'],
    ])
  })

  it('所有尝试都失败时抛出最后一个错误', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        readStatusWithRetry({
          attempts: 3,
          read: async () => {
            calls += 1
            throw new Error(`fail ${calls}`)
          },
          sleep: noSleep,
        }),
      /fail 3/,
    )
    assert.equal(calls, 3)
  })

  it('attempts 至少执行一次', async () => {
    let calls = 0
    await readStatusWithRetry({
      attempts: 0,
      read: async () => {
        calls += 1
        throw new Error('only')
      },
      sleep: noSleep,
    }).catch(() => {})
    assert.equal(calls, 1)
  })
})

describe('parseArgs', () => {
  it('默认什么开关都不开', () => {
    const args = parseArgs([])
    assert.deepEqual(args, { preflightOnly: false, force: false, verbose: false, port: null, help: false })
  })

  it('识别四个开关', () => {
    const args = parseArgs(['--preflight-only', '--force', '--verbose', '--help'])
    assert.equal(args.preflightOnly, true)
    assert.equal(args.force, true)
    assert.equal(args.verbose, true)
    assert.equal(args.help, true)
  })

  it('--port 读下一个参数', () => {
    assert.equal(parseArgs(['--port', '9400']).port, 9400)
  })

  it('--port 后面不是数字时忽略', () => {
    assert.equal(parseArgs(['--port', 'abc']).port, null)
    assert.equal(parseArgs(['--port']).port, null)
  })

  it('未知参数被忽略而不是抛错', () => {
    assert.equal(parseArgs(['--whatever', '-x']).force, false)
  })
})
