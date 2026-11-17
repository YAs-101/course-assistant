/**
 * Tests for the scheduled-task XML.
 *
 * This file exists because the task definition is the one piece that cannot be
 * verified by reading code: `schtasks /Create` either accepts the XML or fails
 * with a message that does not name the offending field. Two failures are known:
 * a `UserId` that is not a full SID ("No mapping between account names and
 * security IDs was done") and a UTF-8 file ("the task XML is not valid"). Both
 * are pinned here so a refactor cannot quietly reintroduce them.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { TASK_NAME, buildTaskXml, writeTaskXml, xmlEscape } from '../lib/task.mjs'

// 示例值，不是任何真实账号：真机上那串 SID 和路径不该进公开仓库。
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const VBS = 'C:\\Users\\Example\\source\\课程助手\\tools\\rewards-auto\\launch.vbs'

let dir = null
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewards-task-'))
})
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('buildTaskXml', () => {
  it('登录触发器与主体都用完整 SID', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    const userIds = [...xml.matchAll(/<UserId>([^<]+)<\/UserId>/g)].map((m) => m[1])
    assert.equal(userIds.length, 2, 'expected one UserId in the trigger and one in the principal')
    for (const value of userIds) assert.equal(value, SID)
  })

  it('不包含短用户名（这是实测失败的写法）', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.ok(!xml.includes('<UserId>user</UserId>'))
    // 用完整 SID 生成时，机器名根本不该出现在 XML 里。
    assert.ok(!xml.includes('DESKTOP-'))
    assert.ok(!xml.includes('\\user'))
  })

  it('含登录触发器、2 分钟延迟、30 分钟重复 2 小时', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.match(xml, /<LogonTrigger>/)
    assert.match(xml, /<Delay>PT2M<\/Delay>/)
    assert.match(xml, /<Interval>PT30M<\/Interval>/)
    assert.match(xml, /<Duration>PT2H<\/Duration>/)
  })

  it('含防重入与超时设置', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/)
    assert.match(xml, /<ExecutionTimeLimit>PT15M<\/ExecutionTimeLimit>/)
    assert.match(xml, /<RunOnlyIfNetworkAvailable>true<\/RunOnlyIfNetworkAvailable>/)
  })

  it('以交互令牌、最低权限运行', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/)
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/)
    assert.ok(!xml.includes('HighestAvailable'))
  })

  it('电池供电时也启动（笔记本场景）', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/)
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/)
  })

  it('动作是 wscript 跑 launch.vbs，路径带引号', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.match(xml, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/)
    assert.match(xml, /<Arguments>"[^"]*launch\.vbs"<\/Arguments>/)
  })

  it('路径里有空格也不会破坏 XML', () => {
    const xml = buildTaskXml({ sid: SID, vbsPath: 'C:\\a b\\c d\\launch.vbs' })
    assert.match(xml, /<Arguments>"C:\\a b\\c d\\launch\.vbs"<\/Arguments>/)
  })

  it('时间参数可覆盖', () => {
    const xml = buildTaskXml({
      sid: SID,
      vbsPath: VBS,
      delayMinutes: 5,
      repeatMinutes: 15,
      durationHours: 4,
      timeLimitMinutes: 20,
    })
    assert.match(xml, /<Delay>PT5M<\/Delay>/)
    assert.match(xml, /<Interval>PT15M<\/Interval>/)
    assert.match(xml, /<Duration>PT4H<\/Duration>/)
    assert.match(xml, /<ExecutionTimeLimit>PT20M<\/ExecutionTimeLimit>/)
  })

  it('缺 sid 抛错', () => {
    assert.throws(() => buildTaskXml({ vbsPath: VBS }), /sid is required/)
  })

  it('短用户名被明确拒绝，而不是生成一个会被 schtasks 打回的 XML', () => {
    assert.throws(() => buildTaskXml({ sid: 'user', vbsPath: VBS }), /is not a SID/)
    assert.throws(() => buildTaskXml({ sid: 'DESKTOP-EXAMPLE\\user', vbsPath: VBS }), /is not a SID/)
  })

  it('缺 vbsPath 抛错', () => {
    assert.throws(() => buildTaskXml({ sid: SID }), /vbsPath is required/)
  })

  it('默认任务名是 MSRewards-AutoDaily', () => {
    assert.equal(TASK_NAME, 'MSRewards-AutoDaily')
    const xml = buildTaskXml({ sid: SID, vbsPath: VBS })
    assert.ok(xml.includes('<Task version="1.2"'))
  })
})

describe('xmlEscape', () => {
  it('转义五个 XML 敏感字符', () => {
    assert.equal(xmlEscape('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f')
  })

  it('null 变成空串', () => {
    assert.equal(xmlEscape(null), '')
    assert.equal(xmlEscape(undefined), '')
  })
})

describe('writeTaskXml', () => {
  it('写成 UTF-16LE 且带 BOM（schtasks 的硬要求）', () => {
    const file = join(dir, 'task.xml')
    writeTaskXml(file, buildTaskXml({ sid: SID, vbsPath: VBS }))
    const bytes = readFileSync(file)
    assert.equal(bytes[0], 0xff)
    assert.equal(bytes[1], 0xfe)
    // UTF-16LE ASCII text has a zero byte right after each character.
    assert.equal(bytes[2], 0x3c) // '<'
    assert.equal(bytes[3], 0x00)
  })

  it('重复写入不会叠加两个 BOM', () => {
    const file = join(dir, 'task2.xml')
    writeTaskXml(file, '\uFEFF<xml/>')
    writeTaskXml(file, readFileSync(file, 'utf16le'))
    const text = readFileSync(file, 'utf16le')
    assert.equal((text.match(/\uFEFF/g) ?? []).length, 1)
    assert.match(text, /<xml\/>/)
  })

  it('中文路径在磁盘上往返无损', () => {
    const file = join(dir, 'task3.xml')
    writeTaskXml(file, buildTaskXml({ sid: SID, vbsPath: VBS }))
    assert.match(readFileSync(file, 'utf16le'), /课程助手/)
  })
})
