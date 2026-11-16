import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  emptyBridge,
  isSettled,
  listVideos,
  markAllDelivered,
  normalizeBridge,
  parseStateText,
  readBridge,
  readState,
  selectDue,
  writeBridge,
} from '../lib/state.js'
import { keyOf } from '../lib/util.js'

const STATE = JSON.stringify({
  subjects: { AI工具: { createdAt: 1, videos: ['video one', 'video two'] }, 前端: { videos: ['video three'] } },
  seen: { 'video one': 1 },
  lastTitle: 'video three',
  lastRunAt: 9,
})

test('parseStateText normalizes the coursemap shape', () => {
  const parsed = parseStateText(STATE)
  assert.equal(parsed.ok, true)
  assert.deepEqual(Object.keys(parsed.state.subjects), ['AI工具', '前端'])
  assert.equal(parsed.state.subjects['前端'].createdAt, 0)
  assert.equal(parsed.state.lastRunAt, 9)
})

test('parseStateText reports corrupt input instead of throwing', () => {
  assert.equal(parseStateText('{not json').ok, false)
  assert.equal(parseStateText('[]').ok, false)
  assert.equal(parseStateText('null').ok, false)
  assert.match(parseStateText('{oops').reason, /not valid JSON/)
})

test('parseStateText drops junk video entries', () => {
  const parsed = parseStateText(JSON.stringify({ subjects: { s: { videos: ['ok', '', 3, null] } } }))
  assert.deepEqual(parsed.state.subjects.s.videos, ['ok'])
})

test('listVideos flattens subject to videos in file order', () => {
  const videos = listVideos(parseStateText(STATE).state)
  assert.deepEqual(
    videos.map((v) => v.title),
    ['video one', 'video two', 'video three'],
  )
  assert.equal(videos[0].key, keyOf('AI工具', 'video one'))
})

test('normalizeBridge keeps known buckets and drops garbage', () => {
  const bridge = normalizeBridge({ version: 1, initialized: true, delivered: { a: { title: 't' } }, pending: 'nope' })
  assert.equal(bridge.initialized, true)
  assert.deepEqual(Object.keys(bridge.delivered), ['a'])
  assert.deepEqual(bridge.pending, {})
})

test('emptyBridge is a fresh object each time', () => {
  const a = emptyBridge()
  a.delivered.x = {}
  assert.deepEqual(emptyBridge().delivered, {})
})

test('selectDue skips settled videos, backoff, and exhausted attempts', () => {
  const videos = listVideos(parseStateText(STATE).state)
  const bridge = emptyBridge()
  bridge.delivered[videos[0].key] = { title: 'video one' }
  bridge.abandoned[videos[1].key] = { reason: 'gave up' }
  bridge.pending[videos[2].key] = { attempts: 1, nextTryAt: 5000 }

  assert.deepEqual(selectDue({ videos, bridge, now: 1000 }), [])
  const due = selectDue({ videos, bridge, now: 6000 })
  assert.deepEqual(due.map((v) => v.title), ['video three'])
  assert.equal(due[0].attempts, 1)
})

test('selectDue skips a video that reached the attempt ceiling', () => {
  const videos = listVideos(parseStateText(STATE).state)
  const bridge = emptyBridge()
  bridge.pending[videos[0].key] = { attempts: 5 }
  const due = selectDue({ videos, bridge, now: 0, maxAttempts: 5 })
  assert.deepEqual(due.map((v) => v.title), ['video two', 'video three'])
})

test('markAllDelivered settles history without inventing a session', () => {
  const videos = listVideos(parseStateText(STATE).state)
  const bridge = markAllDelivered(emptyBridge(), videos, 42)
  assert.equal(Object.keys(bridge.delivered).length, 3)
  assert.equal(bridge.delivered[videos[0].key].sessionId, '')
  assert.equal(bridge.delivered[videos[0].key].skipped, true)
  assert.equal(isSettled(bridge, videos[0].key), true)
})

test('readState/readBridge/writeBridge survive a real file round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-state-'))
  const statePath = join(dir, 'state.json')
  writeFileSync(statePath, STATE, 'utf8')
  assert.equal(readState(statePath).ok, true)
  assert.equal(readState(join(dir, 'missing.json')).ok, false)

  const bridgePath = join(dir, 'nested', 'bridge.json')
  assert.deepEqual(readBridge(bridgePath).delivered, {})
  const bridge = emptyBridge()
  bridge.delivered['k'] = { title: 't' }
  writeBridge(bridgePath, bridge)
  assert.equal(readBridge(bridgePath).delivered.k.title, 't')

  writeFileSync(bridgePath, 'not json', 'utf8')
  assert.equal(Object.keys(readBridge(bridgePath).delivered).length, 0)
})
