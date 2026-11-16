/**
 * Tests for the path helpers.
 *
 * These functions are the sandbox boundary for `/api/file` and the discovery
 * that decides whether the power switch can work at all, so they are tested
 * directly rather than only through HTTP.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  DEFAULT_OUTPUT_DIR,
  APP_DIR,
  findBridgeDir,
  findCoursemapModule,
  homeOutputDir,
  isInside,
  joinInside,
  resolveInside
} from '../lib/paths.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ca-paths-'))
}

describe('resolveInside', () => {
  const root = 'C:\\data\\map'

  it('放行普通的相对路径', () => {
    const got = resolveInside(root, '笔记/a.docx')
    assert.equal(got.ok, true)
    assert.equal(got.path, join(root, '笔记', 'a.docx'))
  })

  it('放行带前导斜杠的相对路径（前端常这么传）', () => {
    const got = resolveInside(root, '/笔记/a.docx')
    assert.equal(got.ok, true)
    assert.equal(got.path, join(root, '笔记', 'a.docx'))
  })

  it('拒绝空路径', () => {
    assert.equal(resolveInside(root, '').ok, false)
    assert.equal(resolveInside(root, '   ').ok, false)
    assert.equal(resolveInside(root, '/').ok, false)
  })

  it('拒绝非字符串', () => {
    const got = resolveInside(root, null)
    assert.equal(got.ok, false)
    assert.match(got.reason, /字符串/)
  })

  it('拒绝根目录未配置', () => {
    const got = resolveInside('', 'a.txt')
    assert.equal(got.ok, false)
    assert.match(got.reason, /根目录/)
  })

  it('拒绝盘符绝对路径', () => {
    assert.equal(resolveInside(root, 'C:\\Windows\\win.ini').ok, false)
    assert.equal(resolveInside(root, 'D:/other/x.txt').ok, false)
  })

  it('拒绝 .. 穿越（正斜杠与反斜杠两种写法）', () => {
    assert.equal(resolveInside(root, '../server.mjs').ok, false)
    assert.equal(resolveInside(root, '..\\server.mjs').ok, false)
    assert.equal(resolveInside(root, 'a/../../x.txt').ok, false)
    assert.equal(resolveInside(root, 'a\\..\\..\\x.txt').ok, false)
  })

  it('嵌套较深的正常路径仍然放行', () => {
    const got = resolveInside(root, 'AI工具/2026/子目录/笔记.docx')
    assert.equal(got.ok, true)
  })
})

describe('isInside', () => {
  it('自身算在内', () => {
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\b'), true)
  })

  it('子路径在内', () => {
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\b\\c'), true)
  })

  it('前缀相同的兄弟目录不在内（a 与 ab）', () => {
    assert.equal(isInside('C:\\a\\b', 'C:\\a\\bc'), false)
  })

  it('上级目录不在内', () => {
    assert.equal(isInside('C:\\a\\b', 'C:\\a'), false)
  })

  it('大小写不同视为同一个目录（Windows 语义）', () => {
    assert.equal(isInside('C:\\a\\B', 'c:\\A\\b\\c'), true)
  })
})

describe('joinInside', () => {
  const root = 'C:\\data\\map'

  it('拼接多段', () => {
    assert.equal(joinInside(root, 'a', 'b', 'c.txt'), join(root, 'a', 'b', 'c.txt'))
  })

  it('跳过空段', () => {
    assert.equal(joinInside(root, 'a', '', 'b.txt'), join(root, 'a', 'b.txt'))
    assert.equal(joinInside(root, 'a', null, undefined, 'b.txt'), join(root, 'a', 'b.txt'))
  })

  it('越界时返回 null 而不是抛出', () => {
    assert.equal(joinInside(root, '..', 'x.txt'), null)
  })
})

describe('homeOutputDir', () => {
  it('在给定家目录下拼出知识地图目录', () => {
    assert.equal(homeOutputDir('C:\\Users\\x'), join('C:\\Users\\x', '课程知识地图'))
  })

  it('不传时使用当前用户家目录，结果绝对且以知识地图结尾', () => {
    const got = homeOutputDir()
    assert.equal(got.endsWith(`${sep}课程知识地图`.replace(/^[\\/]/, sep)) || got.endsWith('课程知识地图'), true)
  })
})

describe('默认目录', () => {
  it('知识地图是 app 的兄弟目录', () => {
    assert.equal(DEFAULT_OUTPUT_DIR, join(APP_DIR, '..', '课程知识地图').replace(/[\\/]app[\\/]\.\./, ''))
    assert.equal(DEFAULT_OUTPUT_DIR.startsWith(APP_DIR), false)
    assert.equal(DEFAULT_OUTPUT_DIR.endsWith('课程知识地图'), true)
  })
})

describe('findCoursemapModule', () => {
  it('优先使用显式 override', () => {
    const dir = tempDir()
    const fake = join(dir, 'my-plugin.mjs')
    writeFileSync(fake, 'export function apply() {}\n', 'utf8')
    const got = findCoursemapModule(fake, join(dir, 'home'), dir)
    assert.equal(got.ok, true)
    assert.equal(got.path, fake)
    assert.equal(got.candidates[0], fake)
  })

  it('没有 override 时使用 app 内置副本，即便家目录里也有 DSH 插件', () => {
    const root = tempDir()
    const appDir = join(root, 'app')
    const vendored = join(appDir, 'vendor', 'dsh-video-coursemap', 'lib')
    mkdirSync(vendored, { recursive: true })
    writeFileSync(join(vendored, 'index.js'), 'export function apply() {}\n', 'utf8')
    const installed = join(root, 'home', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-video-coursemap', 'lib')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'index.js'), 'export function apply() {}\n', 'utf8')

    const got = findCoursemapModule(null, join(root, 'home'), appDir)
    assert.equal(got.ok, true)
    assert.equal(got.path, join(vendored, 'index.js'))
    // Both candidates were probed, vendored first.
    assert.equal(got.candidates.length, 2)
    assert.equal(got.candidates[1], join(installed, 'index.js'))
  })

  it('没有内置副本时回落到家目录里的 DSH 插件', () => {
    const root = tempDir()
    const appDir = join(root, 'app')
    mkdirSync(appDir, { recursive: true })
    const installed = join(root, 'home', '.dsh', 'profiles', 'web', 'node_modules', 'dsh-video-coursemap', 'lib')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'index.js'), 'export function apply() {}\n', 'utf8')

    const got = findCoursemapModule(null, join(root, 'home'), appDir)
    assert.equal(got.ok, true)
    assert.equal(got.path, join(installed, 'index.js'))
  })

  it('什么都没有时如实报告未找到，并列出探测过的路径', () => {
    const root = tempDir()
    const got = findCoursemapModule(null, join(root, 'home'), join(root, 'app'))
    assert.equal(got.ok, false)
    assert.equal(got.path, null)
    assert.equal(got.candidates.length >= 1, true)
  })

  it('空白 override 会被忽略，不当作路径', () => {
    const root = tempDir()
    const got = findCoursemapModule('   ', join(root, 'home'), join(root, 'app'))
    assert.equal(got.ok, false)
    assert.equal(got.candidates[0], join(root, 'app', 'vendor', 'dsh-video-coursemap', 'lib', 'index.js'))
  })
})

describe('findBridgeDir', () => {
  it('找得到兄弟目录里的 plugins/dsh-course-bridge', () => {
    const root = tempDir()
    const appDir = join(root, 'app')
    const bridge = join(root, 'plugins', 'dsh-course-bridge')
    mkdirSync(appDir, { recursive: true })
    mkdirSync(bridge, { recursive: true })
    assert.equal(findBridgeDir(appDir), bridge)
  })

  it('兄弟目录没有时回落到 app 内的 vendor 副本', () => {
    const root = tempDir()
    const appDir = join(root, 'app')
    const vendored = join(appDir, 'vendor', 'dsh-course-bridge')
    mkdirSync(vendored, { recursive: true })
    assert.equal(findBridgeDir(appDir), vendored)
  })

  it('都没有时返回 null', () => {
    const root = tempDir()
    const appDir = join(root, 'app')
    mkdirSync(appDir, { recursive: true })
    assert.equal(findBridgeDir(appDir), null)
  })
})
