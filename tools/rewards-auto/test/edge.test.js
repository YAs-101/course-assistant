/**
 * Tests for the Edge lifecycle decisions.
 *
 * The policy being pinned: a visible Edge window belongs to the user and the run
 * must never close it, while background-only processes have to go because a
 * second instance cannot open a debug port against a profile already in use.
 * Getting this backwards means either killing the user's browsing or silently
 * failing to attach, so the three-way decision is tested directly.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decidePreflight, isReparsePoint, parseProcessList, readLinkTarget, samePath } from '../lib/edge.mjs'

describe('parseProcessList', () => {
  it('解析 pid 与窗口句柄两列', () => {
    const rows = parseProcessList('9412 0\n9413 132456\n9414 0\n')
    assert.deepEqual(rows, [
      { pid: 9412, hasWindow: false },
      { pid: 9413, hasWindow: true },
      { pid: 9414, hasWindow: false },
    ])
  })

  it('空输出表示 Edge 没在跑', () => {
    assert.deepEqual(parseProcessList(''), [])
    assert.deepEqual(parseProcessList('   \n\n'), [])
    assert.deepEqual(parseProcessList(null), [])
  })

  it('非数字行被丢掉而不是变成 NaN 的进程', () => {
    assert.deepEqual(parseProcessList('garbage\n12 0'), [{ pid: 12, hasWindow: false }])
  })

  it('缺第二列时按无窗口处理', () => {
    assert.deepEqual(parseProcessList('77'), [{ pid: 77, hasWindow: false }])
  })

  it('能识别真实 PowerShell 输出里的可见窗口（这就是之前判错的路径）', () => {
    const rows = parseProcessList('19380 132456\n19384 0\n19385 0')
    assert.equal(decidePreflight(rows), 'skip-visible-window')
  })
})

describe('decidePreflight', () => {
  it('没有 Edge 进程时直接继续', () => {
    assert.equal(decidePreflight([]), 'proceed')
  })

  it('只有后台进程（无窗口）时杀掉再继续', () => {
    assert.equal(decidePreflight([{ pid: 1, hasWindow: false }]), 'kill-background')
    assert.equal(
      decidePreflight([
        { pid: 1, hasWindow: false },
        { pid: 2, hasWindow: false },
        { pid: 3, hasWindow: false },
      ]),
      'kill-background',
    )
  })

  it('任意一个有可见窗口时跳过本轮', () => {
    assert.equal(decidePreflight([{ pid: 1, hasWindow: true }]), 'skip-visible-window')
    assert.equal(
      decidePreflight([
        { pid: 1, hasWindow: false },
        { pid: 2, hasWindow: true },
      ]),
      'skip-visible-window',
    )
  })

  it('输入不是数组时按无进程处理', () => {
    assert.equal(decidePreflight(null), 'proceed')
    assert.equal(decidePreflight(undefined), 'proceed')
  })

  it('数组里的空项不会让判断崩掉', () => {
    assert.equal(decidePreflight([null, { pid: 1, hasWindow: false }]), 'kill-background')
  })
})

describe('samePath', () => {
  it('忽略大小写和斜杠方向', () => {
    assert.equal(samePath('C:\\Users\\Example\\X', 'c:/users/example/x'), true)
  })

  it('忽略末尾反斜杠', () => {
    assert.equal(samePath('C:\\Users\\Example\\X\\', 'C:\\Users\\Example\\X'), true)
  })

  it('不同路径返回 false', () => {
    assert.equal(samePath('C:\\A', 'C:\\B'), false)
  })

  it('空值返回 false', () => {
    assert.equal(samePath(null, 'C:\\A'), false)
    assert.equal(samePath('C:\\A', ''), false)
  })
})

describe('junction 判定', () => {
  it('普通目录不是 reparse point', () => {
    assert.equal(isReparsePoint(process.cwd()), false)
  })

  it('不存在的路径返回 false 而不是抛错', () => {
    assert.equal(isReparsePoint('C:\\definitely\\not\\here\\xyz'), false)
    assert.equal(readLinkTarget('C:\\definitely\\not\\here\\xyz'), null)
  })
})
