import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildNoteMd, convertToDocx, findPython, isUsableFile, writeNoteDocx } from '../lib/docx.js'
import { SEGMENT_DELIMITER } from '../lib/manual.js'

const SCRIPT = join(process.cwd(), 'scripts', 'md2docx.py')
const FENCE = String.fromCharCode(96).repeat(3)

test('buildNoteMd emits an H1 cover, a quote, and the section body', () => {
  const md = buildNoteMd({ subject: 'AI工具', title: '示例视频', section: '## 示例视频\n\n> 简介' })
  assert.ok(md.startsWith('# 示例视频\n'))
  assert.match(md, /> 学科：AI工具 · 生成时间：\d{8}-\d{4}/)
  assert.ok(md.trimEnd().endsWith('> 简介'))
})

test('buildNoteMd marks a degraded note and survives empty input', () => {
  const md = buildNoteMd({ subject: '', title: '', section: '', degraded: true })
  assert.match(md, /^# 未命名视频/)
  assert.match(md, /学科：未分类/)
  assert.match(md, /整份《未分类》学习手册全文/)
  assert.match(md, /本次没有可用的视频总结内容/)
})

test('buildNoteMd trims an over-long title', () => {
  const md = buildNoteMd({ subject: 's', title: 'x'.repeat(400), section: 'body' })
  const first = md.split('\n')[0]
  assert.equal(first.length, 123, "'# ' + 120 chars + the ellipsis")
  assert.ok(first.endsWith('…'))
})

test('buildNoteMd renders ordered sections with their headings', () => {
  const md = buildNoteMd({
    subject: '音乐鉴赏',
    title: '示例视频',
    source: '视频简介/字幕/弹幕/评论 + 模型总结',
    sections: [
      { heading: '知识总结（基于真实素材）', body: '### 视频讲了什么\n- 主线' },
      { heading: '课程知识地图初稿（仅由标题推断，未经素材核对）', body: '### 核心知识点\n- 要点' },
    ],
  })
  assert.match(md, /素材：视频简介\/字幕\/弹幕\/评论 \+ 模型总结/)
  const first = md.indexOf('## 知识总结（基于真实素材）')
  const second = md.indexOf('## 课程知识地图初稿')
  assert.ok(first > 0 && second > first, 'sections must keep the order they were given in')
  assert.ok(md.includes('### 视频讲了什么'), 'inner headings must survive')
})

test('buildNoteMd labels an empty section instead of emitting a blank page', () => {
  const md = buildNoteMd({ subject: 's', title: 't', sections: [{ heading: '空', body: '' }, { heading: '', body: '' }] })
  assert.match(md, /## 空/)
  assert.match(md, /本节没有可用内容/)
  assert.equal((md.match(/本节没有可用内容/g) || []).length, 1, 'a fully empty section is skipped')
})

test('findPython locates an interpreter on this machine', () => {
  const python = findPython()
  assert.equal(typeof python, 'string')
  assert.notEqual(python, '')
})

test('writeNoteDocx refuses clearly when the script is missing', () => {
  const out = writeNoteDocx({ notesDir: tmpdir(), baseName: 'x', md: '# x', pythonPath: 'python', scriptPath: join(tmpdir(), 'nope.py') })
  assert.equal(out.ok, false)
  assert.match(out.message, /md2docx\.py is missing/)
})

test('writeNoteDocx converts a real note and removes the intermediate Markdown', () => {
  const python = findPython()
  assert.notEqual(python, null, 'python is required for this test')
  const dir = mkdtempSync(join(tmpdir(), 'bridge-docx-'))
  const body = '## 真实转换测试\n\n> 简介\n\n### 核心知识点\n- **主题一**\n  - 要点\n\n' + FENCE + 'mermaid\nmindmap\n  root((测试))\n    分支\n' + FENCE
  const md = buildNoteMd({ subject: 'AI工具', title: '真实转换测试', section: body })
  const out = writeNoteDocx({ notesDir: dir, baseName: 'note', md, pythonPath: python, scriptPath: SCRIPT })
  assert.equal(out.ok, true, out.message)
  assert.equal(existsSync(out.docxPath), true)
  assert.equal(existsSync(join(dir, 'note.md')), false)
  const magic = readFileSync(out.docxPath).subarray(0, 4).toString('hex')
  assert.equal(magic, '504b0304')
})

test('convertToDocx reports a failure instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-docx-fail-'))
  const mdPath = join(dir, 'in.md')
  writeNoteDocx({ notesDir: dir, baseName: 'seed', md: '# seed', pythonPath: 'python', scriptPath: SCRIPT })
  const out = convertToDocx({ pythonPath: 'definitely-not-python-xyz', scriptPath: SCRIPT, mdPath, docxPath: join(dir, 'o.docx') })
  assert.equal(out.ok, false)
})

test('SEGMENT_DELIMITER matches what coursemap appendVideo writes', () => {
  assert.equal(SEGMENT_DELIMITER, '\n\n---\n\n')
})

test('isUsableFile rejects empty and non-ZIP files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-docx-'))
  const empty = join(dir, 'empty.docx')
  writeFileSync(empty, '')
  assert.equal(isUsableFile(empty), false)
  assert.equal(isUsableFile(join(dir, 'missing.docx')), false)

  const text = join(dir, 'text.docx')
  writeFileSync(text, 'not a zip at all')
  assert.equal(isUsableFile(text), false)
})

test('a note whose title carries emoji still converts', () => {
  // A Bilibili title like "爽！…🫵😠明日方舟音乐大赏17" used to make md2docx die
  // on the GBK console when it echoed the output path, losing a finished .docx.
  const dir = mkdtempSync(join(tmpdir(), 'bridge-docx-'))
  const md = buildNoteMd({ subject: '音乐鉴赏', title: '爽！但联动曲给我安排好了啊🫵😠明日方舟音乐大赏17', section: '### 核心知识点\n- 联动曲' })
  const out = writeNoteDocx({
    notesDir: dir,
    baseName: '笔记-emoji-🫵😠',
    md,
    pythonPath: findPython(),
    scriptPath: join(import.meta.dirname, '..', 'scripts', 'md2docx.py'),
  })
  assert.equal(out.ok, true, out.message)
  assert.equal(isUsableFile(out.docxPath), true)
})
