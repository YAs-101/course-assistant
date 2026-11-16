import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSection, headingOf, normalizeTitle, splitManual, SEGMENT_DELIMITER } from '../lib/manual.js'

const FENCE = '\u0060\u0060\u0060'
const HEADER = '# AI工具 学习手册\n\n<!-- OVERVIEW_START -->\n## 学科总览\n' + FENCE + 'mermaid\nmindmap\n  root((AI工具))\n' + FENCE + '\n<!-- OVERVIEW_END -->'
const VIDEO_A = '## 【全网最全】DeepSeek Harness超详细教程！\n\n> 一句话简介\n\n### 核心知识点\n- **主题一**\n  - 要点'
const VIDEO_B = '## 从零开始学 Python\n\n> 另一门课'

const MANUAL = [HEADER, VIDEO_A, VIDEO_B].join(SEGMENT_DELIMITER) + '\n'

test('splitManual cuts on the exact coursemap delimiter', () => {
  const segments = splitManual(MANUAL)
  assert.equal(segments.length, 3)
  assert.equal(headingOf(segments[1]), '【全网最全】DeepSeek Harness超详细教程！')
})

test('splitManual returns nothing for blank input', () => {
  assert.deepEqual(splitManual(''), [])
  assert.deepEqual(splitManual(null), [])
})

test('headingOf ignores a segment that does not start with H2', () => {
  assert.equal(headingOf('# 学习手册'), '')
  assert.equal(headingOf(''), '')
})

test('normalizeTitle folds punctuation, spaces, and case', () => {
  assert.equal(normalizeTitle('## 【全网最全】DSH 教程！'), normalizeTitle('全网最全 DSH 教程'))
})

test('extractSection prefers an exact heading match', () => {
  const found = extractSection(MANUAL, '【全网最全】DeepSeek Harness超详细教程！')
  assert.equal(found.found, true)
  assert.equal(found.how, 'exact')
  assert.ok(found.section.startsWith('## 【全网最全】'))
})

test('extractSection still matches an LLM-rewritten heading', () => {
  const found = extractSection(MANUAL, '全网最全 DeepSeek Harness 超详细教程')
  assert.equal(found.found, true)
  assert.equal(found.how, 'normalized')
})

test('extractSection never lets a short title swallow a longer one', () => {
  const manual = ['## 学科总览', '## DSH', '## DSH 进阶实战'].join(SEGMENT_DELIMITER)
  const found = extractSection(manual, 'DSH 进阶实战')
  assert.equal(found.found, true)
  assert.equal(found.how, 'exact')
  assert.equal(extractSection(manual, 'Py').found, false)
})

test('extractSection reports a miss instead of guessing', () => {
  const found = extractSection(MANUAL, '完全不存在的另一个视频标题啊')
  assert.equal(found.found, false)
  assert.equal(found.how, 'miss')
  assert.equal(found.section, '')
})

test('extractSection handles empty and unmatchable titles', () => {
  assert.equal(extractSection(MANUAL, '').how, 'empty-title')
  assert.equal(extractSection(MANUAL, '！！！').how, 'unmatchable-title')
})
