/**
 * Tests for config loading.
 *
 * A scheduled run has no console, so a config file that cannot be read must not
 * abort the run: it falls back to defaults and records a warning. The reverse
 * mistake -- silently accepting a broken file and running with defaults -- would
 * hide a typo in a path the user was trying to override, so the warning is part
 * of the contract too.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  DEFAULTS,
  defaultConfigPath,
  defaultStatePath,
  defaultUserDataDir,
  loadConfig,
  mergeConfig,
  resolveConfig,
  stateDir,
} from '../lib/config.mjs'

let dir = null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewards-config-'))
})
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

const FAKE_ENV = { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }

describe('路径推导', () => {
  it('三处路径都挂在 %LOCALAPPDATA%\\ms-rewards-auto 下', () => {
    assert.equal(stateDir(FAKE_ENV), 'C:\\Users\\Test\\AppData\\Local\\ms-rewards-auto')
    assert.equal(
      defaultConfigPath(FAKE_ENV),
      'C:\\Users\\Test\\AppData\\Local\\ms-rewards-auto\\config.json',
    )
    assert.equal(
      defaultUserDataDir(FAKE_ENV),
      'C:\\Users\\Test\\AppData\\Local\\Microsoft\\Edge\\User Data',
    )
  })

  it('没有 LOCALAPPDATA 时退到 USERPROFILE', () => {
    const path = defaultConfigPath({ USERPROFILE: 'C:\\Users\\Fallback' })
    assert.match(path, /Fallback/)
    assert.match(path, /ms-rewards-auto/)
  })
})

describe('mergeConfig', () => {
  it('覆盖同名键，保留其余默认值', () => {
    const merged = mergeConfig(DEFAULTS, { port: 9400 })
    assert.equal(merged.port, 9400)
    assert.equal(merged.maxSearchesPerRun, DEFAULTS.maxSearchesPerRun)
  })

  it('undefined 不覆盖默认值', () => {
    const merged = mergeConfig(DEFAULTS, { port: undefined })
    assert.equal(merged.port, DEFAULTS.port)
  })

  it('数组整体替换而不是合并', () => {
    const merged = mergeConfig({ list: [1, 2, 3] }, { list: [9] })
    assert.deepEqual(merged.list, [9])
  })

  it('非对象补丁返回原配置副本', () => {
    const merged = mergeConfig(DEFAULTS, null)
    assert.equal(merged.port, DEFAULTS.port)
    assert.notEqual(merged, DEFAULTS)
  })
})

describe('resolveConfig', () => {
  it('null 占位解析成绝对路径', () => {
    const resolved = resolveConfig(DEFAULTS, FAKE_ENV)
    assert.equal(resolved.userDataDir, defaultUserDataDir(FAKE_ENV))
    assert.equal(resolved.linkDir, join(stateDir(FAKE_ENV), 'udlink'))
    assert.equal(resolved.stateFile, join(stateDir(FAKE_ENV), 'state.json'))
  })

  it('daily marker 路径与 stateDir 一致', () => {
    assert.equal(defaultStatePath(FAKE_ENV), join(stateDir(FAKE_ENV), 'state.json'))
  })

  it('显式给的 stateFile 不被覆盖', () => {
    const resolved = resolveConfig({ ...DEFAULTS, stateFile: 'D:\\custom\\state.json' }, FAKE_ENV)
    assert.equal(resolved.stateFile, 'D:\\custom\\state.json')
  })

  it('显式配置不被覆盖', () => {
    const resolved = resolveConfig({ ...DEFAULTS, userDataDir: 'D:\\custom' }, FAKE_ENV)
    assert.equal(resolved.userDataDir, 'D:\\custom')
  })
})

describe('loadConfig', () => {
  it('文件不存在时用默认值，且没有警告', () => {
    const result = loadConfig({ file: join(dir, 'missing.json'), env: FAKE_ENV })
    assert.equal(result.source, 'default')
    assert.equal(result.warning, null)
    assert.equal(result.config.port, DEFAULTS.port)
    assert.equal(result.config.userDataDir, defaultUserDataDir(FAKE_ENV))
  })

  it('合法覆盖文件被合并', () => {
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ port: 9401, maxSearchesPerRun: 4 }), 'utf8')
    const result = loadConfig({ file, env: FAKE_ENV })
    assert.equal(result.source, 'file')
    assert.equal(result.warning, null)
    assert.equal(result.config.port, 9401)
    assert.equal(result.config.maxSearchesPerRun, 4)
    assert.equal(result.config.edgeExe, DEFAULTS.edgeExe)
  })

  it('带 BOM 的文件也能解析', () => {
    const file = join(dir, 'bom.json')
    writeFileSync(file, '\uFEFF{"port":9402}', 'utf8')
    const result = loadConfig({ file, env: FAKE_ENV })
    assert.equal(result.config.port, 9402)
  })

  it('损坏的 JSON 回落默认值并给出警告', () => {
    const file = join(dir, 'broken.json')
    writeFileSync(file, '{ port: 9403, ', 'utf8')
    const result = loadConfig({ file, env: FAKE_ENV })
    assert.equal(result.source, 'default')
    assert.match(result.warning, /invalid JSON/)
    assert.equal(result.config.port, DEFAULTS.port)
  })

  it('空文件按默认值处理，不报警告', () => {
    const file = join(dir, 'empty.json')
    writeFileSync(file, '   \n', 'utf8')
    const result = loadConfig({ file, env: FAKE_ENV })
    assert.equal(result.warning, null)
    assert.equal(result.config.port, DEFAULTS.port)
  })

  it('顶层是数组时视为无效配置', () => {
    const file = join(dir, 'array.json')
    writeFileSync(file, '[1,2,3]', 'utf8')
    const result = loadConfig({ file, env: FAKE_ENV })
    assert.equal(result.warning, 'config is not an object')
  })
})
