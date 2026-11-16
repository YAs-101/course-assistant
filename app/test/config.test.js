/**
 * Tests for the settings layer.
 *
 * The important behaviours are the guards, not the happy path: an interval below
 * the PowerShell probe cost must be refused (otherwise probes queue up), and a
 * half-written config must never prevent boot.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

import {
  DEFAULTS,
  MAX_POLL_MS,
  MIN_POLL_MS,
  applyPatch,
  normalizeConfig,
  readConfig,
  rebuildKeys,
  validateSetting,
  writeConfig,
} from '../lib/config.mjs'

const temps = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'course-app-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('validateSetting', () => {
  it('接受合法的轮询间隔', () => {
    assert.deepEqual(validateSetting('pollIntervalMs', 5000), { ok: true, value: 5000 })
    assert.deepEqual(validateSetting('pollIntervalMs', MIN_POLL_MS), { ok: true, value: MIN_POLL_MS })
  })

  it('拒绝低于探测成本的间隔', () => {
    const result = validateSetting('pollIntervalMs', 500)
    assert.equal(result.ok, false)
    assert.match(result.message, /2000/)
  })

  it('拒绝超过上限的间隔', () => {
    assert.equal(validateSetting('pollIntervalMs', MAX_POLL_MS + 1).ok, false)
  })

  it('拒绝非数字间隔', () => {
    assert.equal(validateSetting('pollIntervalMs', 'abc').ok, false)
  })

  it('校验布尔项', () => {
    assert.deepEqual(validateSetting('enabled', true), { ok: true, value: true })
    assert.equal(validateSetting('enabled', 'yes').ok, false)
  })

  it('拒绝空输出目录', () => {
    assert.equal(validateSetting('outputDir', '   ').ok, false)
  })

  it('允许把路径类配置置空', () => {
    assert.deepEqual(validateSetting('pythonPath', null), { ok: true, value: null })
    assert.deepEqual(validateSetting('coursemapModule', ''), { ok: true, value: null })
  })

  it('拒绝未知配置项', () => {
    const result = validateSetting('nonsense', 1)
    assert.equal(result.ok, false)
    assert.match(result.message, /未知配置项/)
  })

  it('整数项拒绝小数', () => {
    assert.equal(validateSetting('stablePolls', 2.5).ok, false)
    assert.deepEqual(validateSetting('stablePolls', 3), { ok: true, value: 3 })
  })
})

describe('normalizeConfig', () => {
  it('空对象得到默认值', () => {
    const { config, warnings } = normalizeConfig({})
    assert.deepEqual(config, { ...DEFAULTS })
    assert.deepEqual(warnings, [])
  })

  it('丢弃未知键但保留已知键', () => {
    const { config, warnings } = normalizeConfig({ pollIntervalMs: 4000, bogus: 1 })
    assert.equal(config.pollIntervalMs, 4000)
    assert.equal('bogus' in config, false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /bogus/)
  })

  it('非法值回落默认并给出警告', () => {
    const { config, warnings } = normalizeConfig({ pollIntervalMs: 10 })
    assert.equal(config.pollIntervalMs, DEFAULTS.pollIntervalMs)
    assert.equal(warnings.length, 1)
  })

  it('非对象输入不崩溃', () => {
    const { config, warnings } = normalizeConfig('nope')
    assert.equal(config.pollIntervalMs, DEFAULTS.pollIntervalMs)
    assert.equal(warnings.length, 1)
  })
})

describe('readConfig / writeConfig', () => {
  it('文件不存在时返回默认值且 existed=false', () => {
    const file = join(tempDir(), 'config.json')
    const loaded = readConfig(file)
    assert.equal(loaded.existed, false)
    assert.equal(loaded.config.pollIntervalMs, DEFAULTS.pollIntervalMs)
  })

  it('损坏的 JSON 不会抛错', () => {
    const dir = tempDir()
    const file = join(dir, 'config.json')
    writeFileSync(file, '{ this is not json', 'utf8')
    const loaded = readConfig(file)
    assert.equal(loaded.corrupt, true)
    assert.equal(loaded.config.outputDir, DEFAULTS.outputDir)
  })

  it('写入后能原样读回', () => {
    const file = join(tempDir(), 'config.json')
    const config = { ...DEFAULTS, pollIntervalMs: 7000, enabled: true }
    assert.deepEqual(writeConfig(config, file), { ok: true })
    const loaded = readConfig(file)
    assert.equal(loaded.config.pollIntervalMs, 7000)
    assert.equal(loaded.config.enabled, true)
  })

  it('写出的 JSON 带换行且可解析', () => {
    const file = join(tempDir(), 'config.json')
    writeConfig({ ...DEFAULTS }, file)
    const text = readFileSync(file, 'utf8')
    assert.ok(text.endsWith('\n'))
    assert.doesNotThrow(() => JSON.parse(text))
  })

  it('目录不存在时返回失败而不是抛错', () => {
    const result = writeConfig({ ...DEFAULTS }, join(tempDir(), 'missing', 'config.json'))
    assert.equal(result.ok, false)
    assert.match(result.message, /保存配置失败/)
  })
})

describe('applyPatch', () => {
  it('合并合法字段', () => {
    const result = applyPatch({ ...DEFAULTS }, { pollIntervalMs: 6000, enabled: true })
    assert.equal(result.ok, true)
    assert.equal(result.config.pollIntervalMs, 6000)
    assert.equal(result.config.enabled, true)
  })

  it('一次报告多个错误', () => {
    const result = applyPatch({ ...DEFAULTS }, { pollIntervalMs: 1, stablePolls: 99 })
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 2)
  })

  it('非对象请求体被拒绝', () => {
    assert.equal(applyPatch({ ...DEFAULTS }, null).ok, false)
  })

  it('拒绝未知键', () => {
    const result = applyPatch({ ...DEFAULTS }, { hack: true })
    assert.equal(result.ok, false)
    assert.match(result.errors[0], /未知配置项/)
  })
})

describe('rebuildKeys', () => {
  it('识别需要重建引擎的变更', () => {
    const a = { ...DEFAULTS }
    const b = { ...DEFAULTS, pollIntervalMs: 5000 }
    assert.deepEqual(rebuildKeys(a, b), ['pollIntervalMs'])
  })

  it('不需要重建的变更返回空', () => {
    const a = { ...DEFAULTS }
    const b = { ...DEFAULTS, enableDeepSplit: true, model: 'deepseek-v4-pro' }
    assert.deepEqual(rebuildKeys(a, b), [])
  })

  it('enabled 变更也算需要重建', () => {
    assert.deepEqual(rebuildKeys({ ...DEFAULTS }, { ...DEFAULTS, enabled: true }), ['enabled'])
  })
})
