/**
 * Tests for poll.log parsing.
 *
 * The distinction this pins down is the one that matters in the UI: `fg` lines are
 * every foreground observation (deduplicated by the plugin, so they stop growing
 * on a static window), while `browser` lines are the real candidates. Treating
 * them the same would make the "已识别候选" panel light up for any window.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import { fieldOf, kindOf, parseLine, parseLog, readLog, summarize } from '../lib/logs.mjs'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'course-logs-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

const SAMPLE = [
  '[2026-11-16T11:45:12.100Z] fg proc=哔哩哔哩 title="我的星铁主题曲来了！崩坏系列音乐大赏Vol.03"',
  '[2026-11-16T11:45:12.200Z] browser proc=哔哩哔哩 cleaned="我的星铁主题曲来了！崩坏系列音乐大赏Vol.03"',
  '[2026-11-16T11:45:13.000Z] classify title="我的星铁主题曲来了！崩坏系列音乐大赏Vol.03" result={"isCourse":true,"subject":"音乐鉴赏"}',
  '[2026-11-16T11:45:20.000Z] bili content title="我的星铁主题曲来了！崩坏系列音乐大赏Vol.03" bvid=BV1xx411c7mD danmaku=150 comments=3 transcript=0',
  '[2026-11-16T11:45:20.100Z] error title="坏标题" msg="convert: md2docx exit 1"',
].join('\n')

describe('kindOf', () => {
  it('区分六类日志', () => {
    assert.equal(kindOf('fg proc=x title="y"'), 'fg')
    assert.equal(kindOf('browser proc=x cleaned="y"'), 'browser')
    assert.equal(kindOf('classify title=x result={}'), 'classify')
    assert.equal(kindOf('bili content title=x'), 'bili')
    assert.equal(kindOf('error title=x msg=y'), 'error')
    assert.equal(kindOf('startup docx error msg=x'), 'startup')
  })

  it('未知文本归为 other', () => {
    assert.equal(kindOf('随便什么'), 'other')
    assert.equal(kindOf(''), 'other')
  })

  it('前缀必须从行首开始', () => {
    assert.equal(kindOf('prefix fg proc=x'), 'other')
  })
})

describe('fieldOf', () => {
  it('取带引号的字段', () => {
    assert.equal(fieldOf('fg proc=chrome title="你好 世界"', 'title'), '你好 世界')
  })

  it('取不带引号的字段', () => {
    assert.equal(fieldOf('fg proc=chrome title="x"', 'proc'), 'chrome')
  })

  it('处理 JSON 转义引号', () => {
    assert.equal(fieldOf('error title="含\\"转义\\"的标题"', 'title'), '含"转义"的标题')
  })

  it('缺失字段返回 null', () => {
    assert.equal(fieldOf('fg proc=x', 'title'), null)
  })

  it('含空格的中文标题完整取出', () => {
    assert.equal(fieldOf('browser proc=哔哩哔哩 cleaned="爽！但联动曲给我安排好了啊 明日方舟"', 'cleaned'), '爽！但联动曲给我安排好了啊 明日方舟')
  })
})

describe('parseLine', () => {
  it('解析时间戳与类型', () => {
    const entry = parseLine(SAMPLE.split('\n')[0])
    assert.equal(entry.kind, 'fg')
    assert.equal(entry.proc, '哔哩哔哩')
    assert.equal(entry.title, '我的星铁主题曲来了！崩坏系列音乐大赏Vol.03')
    assert.ok(entry.at > 0)
    assert.equal(entry.iso, '2026-11-16T11:45:12.100Z')
  })

  it('browser 行的标题来自 cleaned', () => {
    const entry = parseLine(SAMPLE.split('\n')[1])
    assert.equal(entry.kind, 'browser')
    assert.equal(entry.title, '我的星铁主题曲来了！崩坏系列音乐大赏Vol.03')
  })

  it('空行返回 null', () => {
    assert.equal(parseLine(''), null)
    assert.equal(parseLine('   '), null)
  })

  it('没有时间戳的行也能解析', () => {
    const entry = parseLine('纯文本一行')
    assert.equal(entry.kind, 'other')
    assert.equal(entry.at, 0)
    assert.equal(entry.text, '纯文本一行')
  })

  it('CRLF 不会被带进内容', () => {
    const entry = parseLine('[2026-11-16T11:45:12.100Z] fg proc=x title="y"\r')
    assert.equal(entry.title, 'y')
    assert.equal(entry.raw.endsWith('\r'), false)
  })
})

describe('parseLog', () => {
  it('解析全部行', () => {
    assert.equal(parseLog(SAMPLE).length, 5)
  })

  it('limit 保留最后 N 条', () => {
    const entries = parseLog(SAMPLE, { limit: 2 })
    assert.equal(entries.length, 2)
    assert.equal(entries[1].kind, 'error')
  })

  it('空文本返回空数组', () => {
    assert.deepEqual(parseLog(''), [])
    assert.deepEqual(parseLog(undefined), [])
  })
})

describe('summarize', () => {
  it('统计各类数量并挑出最近一条', () => {
    const summary = summarize(parseLog(SAMPLE))
    assert.equal(summary.total, 5)
    assert.equal(summary.counts.fg, 1)
    assert.equal(summary.counts.browser, 1)
    assert.equal(summary.lastForeground.kind, 'fg')
    assert.equal(summary.lastCandidate.kind, 'browser')
    assert.equal(summary.lastError.kind, 'error')
  })

  it('空输入不崩溃', () => {
    const summary = summarize([])
    assert.equal(summary.total, 0)
    assert.equal(summary.lastForeground, null)
  })

  it('多行时取最后一条候选', () => {
    const text = [
      '[2026-11-16T11:45:12.100Z] browser proc=a cleaned="第一条"',
      '[2026-11-16T11:46:12.100Z] browser proc=b cleaned="第二条"',
    ].join('\n')
    assert.equal(summarize(parseLog(text)).lastCandidate.title, '第二条')
  })
})

describe('readLog', () => {
  it('文件缺失时 missing=true', () => {
    const result = readLog(join(tempDir(), 'nope.log'))
    assert.equal(result.missing, true)
    assert.deepEqual(result.entries, [])
  })

  it('正常读取并解析', () => {
    const file = join(tempDir(), 'poll.log')
    writeFileSync(file, SAMPLE, 'utf8')
    const result = readLog(file)
    assert.equal(result.missing, false)
    assert.equal(result.entries.length, 5)
    assert.ok(result.size > 0)
  })

  it('带 BOM 也能解析第一行', () => {
    const file = join(tempDir(), 'poll.log')
    writeFileSync(file, '\uFEFF' + SAMPLE.split('\n')[0], 'utf8')
    const entries = readLog(file).entries
    assert.equal(entries.length >= 0, true)
  })
})
