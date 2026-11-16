import assert from 'node:assert/strict'
import test from 'node:test'

import { keyOf, safeName, splitKey, stamp, stampFull, hash8, errText } from '../lib/util.js'

const NUL = String.fromCharCode(0)

test('safeName replaces Windows-forbidden characters', () => {
  assert.equal(safeName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i')
  assert.equal(safeName('  spaced   title  '), 'spaced title')
})

test('safeName keeps surrogate pairs intact', () => {
  const out = safeName('😀😀😀😀', 2)
  assert.equal(Array.from(out).length, 2)
  assert.equal(out, '😀😀')
})

test('safeName never returns an empty stem', () => {
  assert.equal(safeName(''), 'untitled')
  assert.equal(safeName('   '), 'untitled')
  assert.equal(safeName(null), 'untitled')
  assert.equal(safeName('***', 0), 'untitled')
})

test('keyOf/splitKey round-trip a title containing the separator', () => {
  const title = 'a' + NUL + 'b --- c'
  assert.deepEqual(splitKey(keyOf('AI工具', title)), { subject: 'AI工具', title })
})

test('splitKey tolerates a key without a separator', () => {
  assert.deepEqual(splitKey('lonely'), { subject: 'lonely', title: '' })
})

test('stamp keeps a sortable minute-resolution form', () => {
  const when = new Date(2026, 10, 16, 9, 5, 7)
  assert.equal(stamp(when), '20261116-0905')
  assert.equal(stampFull(when), '20261116-090507')
})

test('hash8 is stable and short', () => {
  assert.equal(hash8('abc'), hash8('abc'))
  assert.equal(hash8('abc').length, 8)
  assert.notEqual(hash8('abc'), hash8('abd'))
})

test('errText bounds the message', () => {
  assert.equal(errText(new Error('boom')), 'boom')
  assert.equal(errText('x'.repeat(600)).length, 501)
})
