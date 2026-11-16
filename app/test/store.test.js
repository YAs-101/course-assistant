/**
 * Tests for the knowledge-map readers.
 *
 * These parse files written by two other plugins, so the contract tested here is
 * "tolerant": a missing file, a mid-write file and an unexpected shape must all
 * produce usable empty values rather than an exception, because a status endpoint
 * that throws takes the whole UI down with it.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  KEY_SEP,
  formatSize,
  listNotes,
  normalizeBridge,
  normalizeState,
  readBridge,
  readJsonFile,
  readKnowledgeMap,
  readManual,
  readTextFile,
  splitManual,
} from '../lib/store.mjs'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'course-store-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function seedMap(dir) {
  mkdirSync(join(dir, '.state', 'manuals'), { recursive: true })
  mkdirSync(join(dir, '音乐鉴赏'), { recursive: true })
  mkdirSync(join(dir, '笔记'), { recursive: true })
  writeFileSync(join(dir, '.state', 'state.json'), JSON.stringify({
    subjects: {
      AI工具: { createdAt: 1, videos: ['DSH 教程'] },
      音乐鉴赏: { createdAt: 2, videos: ['星铁主题曲', '明日方舟'] },
    },
    seen: { a: 1, b: 2 },
    lastTitle: '明日方舟',
    lastRunAt: 1794834935790,
  }), 'utf8')
  writeFileSync(join(dir, '.state', 'manuals', '音乐鉴赏.md'), [
    '# 音乐鉴赏 学习手册',
    '',
    '<!-- OVERVIEW_START -->',
    '```mermaid',
    'mindmap',
    '  root((课程知识地图))',
    '    音乐鉴赏',
    '```',
    '<!-- OVERVIEW_END -->',
    '',
    '---',
    '',
    '## 星铁主题曲',
    '',
    '> 一句话简介',
    '',
    '### 核心知识点',
    '- 主题曲结构',
    '  - 前奏动机',
    '- 配器思路',
    '',
    '### 弹幕与评论讨论焦点',
    '大家都在聊编曲',
    '',
    '### 思维导图',
    '```mermaid',
    'mindmap',
    '  root((星铁主题曲))',
    '    结构',
    '```',
    '',
    '## 明日方舟',
    '',
    '> 另一条简介',
    '',
    '### 核心知识点',
    '- 联动曲',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, '.state', 'manuals', 'index.md'), '# 视频课程知识地图\n', 'utf8')
  writeFileSync(join(dir, '音乐鉴赏', '学习手册.docx'), 'PK\u0003\u0004fake', 'utf8')
  writeFileSync(join(dir, '课程总览.docx'), 'PK\u0003\u0004fake2', 'utf8')
  writeFileSync(join(dir, '笔记', '笔记-星铁主题曲-20261116-1945.docx'), 'PK\u0003\u0004note', 'utf8')
  writeFileSync(join(dir, '笔记', '遗留.md'), '# 中间文件', 'utf8')
}

describe('readJsonFile / readTextFile', () => {
  it('缺失文件报告 missing', () => {
    assert.equal(readJsonFile(join(tempDir(), 'x.json')).reason, 'missing')
    assert.equal(readTextFile(join(tempDir(), 'x.txt')).ok, false)
  })

  it('损坏 JSON 不抛错', () => {
    const dir = tempDir()
    const file = join(dir, 'broken.json')
    writeFileSync(file, '{oops', 'utf8')
    const result = readJsonFile(file)
    assert.equal(result.ok, false)
    assert.ok(result.reason)
  })

  it('剥离 BOM', () => {
    const dir = tempDir()
    const file = join(dir, 'bom.md')
    writeFileSync(file, '\uFEFF# 标题', 'utf8')
    assert.equal(readTextFile(file).text, '# 标题')
  })
})

describe('normalizeState', () => {
  it('规整学科与视频', () => {
    const state = normalizeState({ subjects: { A: { createdAt: 5, videos: ['v1', '', null] } }, seen: { x: 1 }, lastTitle: 't', lastRunAt: 9 })
    assert.equal(state.subjects.length, 1)
    assert.deepEqual(state.subjects[0].videos, ['v1'])
    assert.equal(state.lastRunAt, 9)
  })

  it('拒绝非对象', () => {
    const state = normalizeState(null)
    assert.deepEqual(state.subjects, [])
    assert.equal(state.lastTitle, '')
  })

  it('缺字段时补默认值', () => {
    const state = normalizeState({ subjects: { A: {} } })
    assert.deepEqual(state.subjects[0].videos, [])
    assert.equal(state.subjects[0].createdAt, 0)
  })
})

describe('readKnowledgeMap', () => {
  it('读出学科、手册与笔记', () => {
    const dir = tempDir()
    seedMap(dir)
    const km = readKnowledgeMap(dir)
    assert.equal(km.stateOk, true)
    assert.equal(km.subjects.length, 2)
    const music = km.subjects.find((s) => s.name === '音乐鉴赏')
    assert.equal(music.videos.length, 2)
    assert.equal(music.manualMdOk, true)
    assert.equal(music.manualDocxOk, true)
    assert.equal(km.notes.notes.length, 1)
    assert.equal(km.seenCount, 2)
  })

  it('目录为空时不抛错', () => {
    const km = readKnowledgeMap(tempDir())
    assert.equal(km.stateOk, false)
    assert.deepEqual(km.subjects, [])
    assert.equal(km.notes.notes.length, 0)
  })

  it('state.json 里消失但磁盘上还有手册的学科会被列出并标记 orphan', () => {
    // 两个轮询者（应用与 DSH 内的插件）写同一份 state.json，持有旧内存副本的一方
    // 会把学科写丢，但手册文件还在。此时不能让它从界面上消失。
    const dir = tempDir()
    seedMap(dir)
    writeFileSync(join(dir, '.state', 'manuals', 'Rust编程.md'), [
      '# Rust编程 学习手册',
      '<!-- OVERVIEW_START -->',
      '## 学科总览',
      '<!-- OVERVIEW_END -->',
      '## Rust 所有权与借用检查器 30 分钟入门',
      '### 核心知识点',
      '- 借用',
    ].join('\n'), 'utf8')
    const km = readKnowledgeMap(dir)
    assert.equal(km.subjects.length, 3)
    const orphan = km.subjects.find((s) => s.name === 'Rust编程')
    assert.ok(orphan, '应当列出仅有手册的学科')
    assert.equal(orphan.orphan, true)
    assert.equal(orphan.manualMdOk, true)
    // 视频名从手册段落标题反推，且不含总览块里那个 ## 学科总览
    assert.deepEqual(orphan.videos, ['Rust 所有权与借用检查器 30 分钟入门'])
    // 正常学科不受影响
    assert.equal(km.subjects.find((s) => s.name === '音乐鉴赏').orphan, false)
  })
  it('index.md 不会被当成一个学科', () => {
    const dir = tempDir()
    seedMap(dir)
    const km = readKnowledgeMap(dir)
    assert.equal(km.subjects.some((s) => s.name === 'index'), false)
  })
})

describe('splitManual', () => {
  it('分离总览与各视频段落', () => {
    const text = [
      '# 音乐鉴赏 学习手册',
      '<!-- OVERVIEW_START -->',
      '总览内容',
      '<!-- OVERVIEW_END -->',
      '## 视频一',
      '### 核心知识点',
      '- a',
      '## 视频二',
      '### 核心知识点',
      '- b',
    ].join('\n')
    const split = splitManual(text)
    assert.equal(split.title, '音乐鉴赏 学习手册')
    assert.equal(split.overview, '总览内容')
    assert.equal(split.sections.length, 2)
    assert.equal(split.sections[0].title, '视频一')
    assert.match(split.sections[1].markdown, /- b/)
  })

  it('总览块里的 ## 学科总览 不算一个视频段落', () => {
    // 真实手册的总览块自带一个 `## 学科总览` 标题；若把它当成视频，学科会多出
    // 一条名为「学科总览」的幽灵记录，视频数也会 +1。
    const text = [
      '# Rust编程 学习手册',
      '<!-- OVERVIEW_START -->',
      '## 学科总览',
      '```mermaid',
      'mindmap',
      '  root((Rust编程))',
      '```',
      '<!-- OVERVIEW_END -->',
      '## Rust 所有权与借用检查器 30 分钟入门',
      '### 核心知识点',
      '- 所有权',
    ].join('\n')
    const split = splitManual(text)
    assert.equal(split.sections.length, 1)
    assert.equal(split.sections[0].title, 'Rust 所有权与借用检查器 30 分钟入门')
    assert.match(split.overview, /mindmap/)
  })

  it('没有总览标记时 overview 为空', () => {
    const split = splitManual('## 只有段落\n内容')
    assert.equal(split.overview, '')
    assert.equal(split.sections.length, 1)
  })

  it('空文本不抛错', () => {
    const split = splitManual('')
    assert.deepEqual(split.sections, [])
    assert.equal(split.title, '')
  })
})

describe('readManual', () => {
  it('按学科读取手册', () => {
    const dir = tempDir()
    seedMap(dir)
    const manual = readManual(dir, '音乐鉴赏')
    assert.equal(manual.ok, true)
    assert.equal(manual.sections.length, 2)
    assert.match(manual.overview, /mindmap/)
  })

  it('不存在的学科给出原因', () => {
    const dir = tempDir()
    seedMap(dir)
    const manual = readManual(dir, '不存在的学科')
    assert.equal(manual.ok, false)
    assert.match(manual.reason, /尚未生成/)
  })

  it('拒绝路径穿越的学科名', () => {
    const dir = tempDir()
    seedMap(dir)
    assert.equal(readManual(dir, '../etc').ok, false)
    assert.equal(readManual(dir, 'a/b').ok, false)
  })

  it('缺学科名时失败', () => {
    assert.equal(readManual(tempDir(), '').ok, false)
  })
})

describe('listNotes', () => {
  it('只收 docx 并带大小', () => {
    const dir = tempDir()
    seedMap(dir)
    const notes = listNotes(dir)
    assert.equal(notes.notes.length, 1)
    assert.match(notes.notes[0].name, /\.docx$/)
    assert.ok(notes.notes[0].size > 0)
  })

  it('收手册与总览', () => {
    const dir = tempDir()
    seedMap(dir)
    const { handbooks } = listNotes(dir)
    assert.equal(handbooks.length, 2)
    const kinds = handbooks.map((h) => h.kind).sort()
    assert.deepEqual(kinds, ['handbook', 'overview'])
  })

  it('空目录返回空数组', () => {
    const notes = listNotes(tempDir())
    assert.deepEqual(notes.notes, [])
    assert.deepEqual(notes.handbooks, [])
  })
})

describe('normalizeBridge', () => {
  it('按分隔符拆出学科与标题', () => {
    const bridge = normalizeBridge({
      version: 1,
      initialized: true,
      delivered: { ['音乐鉴赏' + KEY_SEP + '星铁主题曲']: { sessionId: 's1', docxPath: 'p' } },
      pending: {},
      abandoned: {},
    })
    assert.equal(bridge.delivered.length, 1)
    assert.equal(bridge.delivered[0].subject, '音乐鉴赏')
    assert.equal(bridge.delivered[0].title, '星铁主题曲')
    assert.equal(bridge.delivered[0].sessionId, 's1')
  })

  it('空账本不崩溃', () => {
    const bridge = normalizeBridge(null)
    assert.deepEqual(bridge.delivered, [])
    assert.equal(bridge.version, 0)
  })
})

describe('readBridge', () => {
  it('心跳新鲜时 alive=true', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    const now = 1_000_000
    writeFileSync(join(dir, '.state', 'bridge.heartbeat.json'), JSON.stringify({ at: now - 1000, due: 0, phase: 'idle' }), 'utf8')
    const bridge = readBridge(dir, now)
    assert.equal(bridge.alive, true)
    assert.equal(bridge.ageMs, 1000)
  })

  it('心跳过期时 alive=false', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    const now = 1_000_000
    writeFileSync(join(dir, '.state', 'bridge.heartbeat.json'), JSON.stringify({ at: now - 60000 }), 'utf8')
    assert.equal(readBridge(dir, now).alive, false)
  })

  it('没有心跳文件时 ageMs 为 null', () => {
    const bridge = readBridge(tempDir())
    assert.equal(bridge.ageMs, null)
    assert.equal(bridge.alive, false)
  })

  it('读取日志尾部', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.state'), { recursive: true })
    writeFileSync(join(dir, '.state', 'bridge.log'), '[t] 已投递\n[t] 失败\n', 'utf8')
    const bridge = readBridge(dir)
    assert.equal(bridge.logTail.length, 2)
  })
})

describe('formatSize', () => {
  it('按量级给单位', () => {
    assert.equal(formatSize(0), '0 B')
    assert.equal(formatSize(512), '512 B')
    assert.equal(formatSize(2048), '2 KB')
    assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB')
  })

  it('非法输入返回 0 B', () => {
    assert.equal(formatSize('x'), '0 B')
    assert.equal(formatSize(-5), '0 B')
  })
})
