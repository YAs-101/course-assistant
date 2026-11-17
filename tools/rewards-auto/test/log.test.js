/**
 * Tests for the JSONL run log.
 *
 * The log is the only record of an unattended run, so the contract is strict:
 * every line parses on its own, and a run always ends with a `summary` record
 * carrying the status and the point deltas. A summary that is missing exactly
 * when something failed would defeat the purpose.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  RUN_STATUS,
  createLogger,
  defaultLogPath,
  lastSummary,
  parseLogBody,
  stamp,
  summaryRecord,
} from '../lib/log.mjs'

let dir = null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewards-log-'))
})
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('stamp / defaultLogPath', () => {
  it('时间戳形如 yyyyMMdd-HHmmss', () => {
    const value = stamp(new Date(2026, 10, 17, 9, 5, 3))
    assert.equal(value, '20261117-090503')
  })

  it('日志路径落在 logs 目录里且以 .jsonl 结尾', () => {
    const path = defaultLogPath('C:\\state\\logs', new Date(2026, 10, 17, 9, 5, 3))
    assert.equal(path, 'C:\\state\\logs\\run-20261117-090503.jsonl')
  })
})

describe('createLogger', () => {
  it('每行都是合法且独立的 JSON', () => {
    const file = join(dir, 'run.jsonl')
    const log = createLogger({ file })
    log.info('start', { port: 9333 })
    log.warn('config ignored', { warning: 'bad json' })
    log.error('boom', { message: 'edge missing' })
    log.write({ level: 'summary', status: 'ok' })
    log.close()

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 4)
    for (const line of lines) {
      const record = JSON.parse(line)
      assert.equal(typeof record.at, 'string')
      assert.ok(!Number.isNaN(Date.parse(record.at)))
    }
    const records = parseLogBody(readFileSync(file, 'utf8'))
    assert.equal(records[0].message, 'start')
    assert.equal(records[0].port, 9333)
    assert.equal(records[1].level, 'warn')
  })

  it('自动创建目录', () => {
    const file = join(dir, 'nested', 'deeper', 'run.jsonl')
    const log = createLogger({ file })
    log.info('hi')
    log.close()
    assert.equal(parseLogBody(readFileSync(file, 'utf8')).length, 1)
  })

  it('缺 file 参数直接抛错', () => {
    assert.throws(() => createLogger({}), /file is required/)
  })

  it('close 之后不再写入', () => {
    const file = join(dir, 'closed.jsonl')
    const log = createLogger({ file })
    log.info('before')
    log.close()
    assert.equal(log.write({ level: 'info', message: 'after' }), false)
    assert.equal(parseLogBody(readFileSync(file, 'utf8')).length, 1)
  })

  it('写失败时调用 onError 而不是抛出去', () => {
    const failures = []
    // A directory path cannot be appended to as a file.
    const log = createLogger({ file: dir, onError: (error) => failures.push(error) })
    assert.equal(log.write({ level: 'info', message: 'nope' }), false)
    assert.equal(failures.length, 1)
  })
})

describe('summaryRecord', () => {
  it('必含状态、余额与搜索进度', () => {
    const record = summaryRecord({
      status: 'ok',
      preBalance: 1425,
      postBalance: 1437,
      preProgress: 3,
      postProgress: 15,
      searches: 4,
      durationMs: 1234,
    })
    assert.equal(record.level, 'summary')
    assert.equal(record.status, 'ok')
    assert.equal(record.pointDelta, 12)
    assert.equal(record.preProgress, 3)
    assert.equal(record.postProgress, 15)
    assert.equal(record.searches, 4)
    assert.equal(record.durationMs, 1234)
  })

  it('缺余额时点差为 null 而不是 NaN', () => {
    const record = summaryRecord({ status: 'failed' })
    assert.equal(record.pointDelta, null)
    assert.equal(record.preBalance, null)
  })

  it('额外字段被折叠进 extra', () => {
    const record = summaryRecord({ status: 'ok', extra: { preflight: 'proceed' } })
    assert.deepEqual(record.extra, { preflight: 'proceed' })
  })
})

describe('parseLogBody / lastSummary', () => {
  it('跳过空行与损坏的行', () => {
    const body = '{"a":1}\n\nnot json\n{"b":2}\n'
    const records = parseLogBody(body)
    assert.equal(records.length, 2)
    assert.equal(records[1].b, 2)
  })

  it('取最后一条 summary', () => {
    const body = [
      JSON.stringify({ level: 'info', message: 'start' }),
      JSON.stringify({ level: 'summary', status: 'already-full' }),
      JSON.stringify({ level: 'summary', status: 'ok' }),
    ].join('\n')
    assert.equal(lastSummary(parseLogBody(body)).status, 'ok')
  })

  it('没有 summary 时返回 null', () => {
    assert.equal(lastSummary(parseLogBody('{"level":"info"}')), null)
    assert.equal(lastSummary([]), null)
  })
})

describe('RUN_STATUS', () => {
  it('覆盖计划里的全部结局', () => {
    for (const status of [
      'ok',
      'already-full',
      'skipped-edge-busy',
      'not-signed-in',
      'no-progress',
      'closed-with-extra-targets',
      'edge-left-running',
      'failed',
    ]) {
      assert.ok(RUN_STATUS.includes(status), `missing ${status}`)
    }
  })

  it('是冻结的常量', () => {
    assert.ok(Object.isFrozen(RUN_STATUS))
  })
})
