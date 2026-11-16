/**
 * Local end-to-end dry run.
 *
 * Uses the REAL knowledge-map directory layout, the REAL state.json that
 * dsh-video-coursemap writes, the REAL md2docx.py conversion and the REAL note
 * directory -- only the four host services are faked, because a plain Node
 * process cannot mount them. Everything runs inside a temp copy, so the
 * production .state/ and 笔记/ stay untouched.
 *
 * Run: node tools/e2e-dryrun.mjs
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import bridge from '../index.js'
import { SEGMENT_DELIMITER } from '../lib/manual.js'
import { readBridge } from '../lib/state.js'

const SOURCE_STATE = 'D:\\Datas\\课程助手\\课程知识地图\\.state'
const NEW_VIDEO = '实测视频：桥接插件端到端验证'
const NEW_SECTION = '## ' + NEW_VIDEO + '\n\n> 这是一节用于验证投递链的假课程。\n\n### 核心知识点\n- **第一点**\n  - 细节说明\n- **第二点**'

function fail(message) {
  console.error('E2E FAIL: ' + message)
  process.exitCode = 1
}

function makeCtx(calls) {
  const services = {
    sessionController: {
      async create(request) {
        calls.push(['create', request])
        return { sessionId: 'sess-' + calls.length }
      },
      async prompt(request) {
        calls.push(['prompt', request])
        return { accepted: true }
      },
      async rename(request) {
        calls.push(['rename', request])
        return { title: request.title, seq: 1 }
      },
    },
    fileUploads: {
      async uploadStream(request) {
        const size = await new Promise((resolve, reject) => {
          let bytes = 0
          request.data.on('data', (chunk) => { bytes += chunk.length })
          request.data.on('end', () => resolve(bytes))
          request.data.on('error', reject)
        })
        calls.push(['upload', request.name, size])
        return { receiptId: 'rcpt-' + calls.length }
      },
    },
    sessions: { get: (id) => ({ id }), async flush() {} },
  }
  return { get: (name) => services[name], effect: (fn) => fn(), tools: { register: () => () => {} } }
}

const work = mkdtempSync(join(tmpdir(), 'bridge-e2e-'))
const stateDir = join(work, '.state')
const manualsDir = join(stateDir, 'manuals')
mkdirSync(manualsDir, { recursive: true })
// cpSync on this machine crashes the process (0xC0000409), so copy file by file.
copyFileSync(join(SOURCE_STATE, 'state.json'), join(stateDir, 'state.json'))
for (const name of readdirSync(join(SOURCE_STATE, 'manuals'))) {
  copyFileSync(join(SOURCE_STATE, 'manuals', name), join(manualsDir, name))
}

const statePath = join(stateDir, 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const subject = Object.keys(state.subjects)[0]
state.subjects[subject].videos.push(NEW_VIDEO)
writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')

const manualPath = join(stateDir, 'manuals', subject + '.md')
writeFileSync(manualPath, readFileSync(manualPath, 'utf8').replace(/\s+$/, '') + SEGMENT_DELIMITER + NEW_SECTION + '\n', 'utf8')

// Pretend a previous boot already settled the historic videos: the dry run must
// exercise delivery of BOTH the old and the newly detected video.
writeFileSync(join(stateDir, 'bridge.json'), JSON.stringify({ version: 1, initialized: true, delivered: {}, pending: {}, abandoned: {}, sessions: {} }), 'utf8')

const calls = []
// The real state.json grows as the user watches videos, so the expected count
// is derived from it instead of hard-coded. fetchContent stays off: this run
// proves the delivery chain, and grounding has its own offline tests.
const expected = Object.values(state.subjects).reduce((total, entry) => total + entry.videos.length, 0)

const plugin = bridge.apply(makeCtx(calls), {
  outputDir: work,
  deliverCwd: work,
  watchIntervalMs: 600000,
  pythonPath: null,
  fetchContent: false,
})

const first = await plugin.scanOnce({ force: true })
console.log('scan1', JSON.stringify(first))
if (first.delivered !== expected) fail('expected ' + expected + ' deliveries, got ' + first.delivered)

const notesDir = join(work, '笔记')
const docx = readdirSync(notesDir).filter((name) => name.endsWith('.docx'))
console.log('docx', docx.join(' | '))
if (docx.length !== expected) fail('expected ' + expected + ' .docx files, got ' + docx.length)
if (readdirSync(notesDir).some((name) => name.endsWith('.md'))) fail('intermediate .md files were left behind')

const ledger = readBridge(join(stateDir, 'bridge.json'))
const records = Object.values(ledger.delivered)
if (records.length !== expected) fail('expected ' + expected + ' settled records, got ' + records.length)
if (records.some((record) => record.skipped)) fail('nothing should be recorded as skipped')
if (records.some((record) => !record.sessionId)) fail('every record needs a session id')
if (records.some((record) => record.degraded)) fail('both videos are in the manual, so nothing should degrade')

// The prompt really carries the .docx as a file part, and the upload was the docx bytes.
const prompts = calls.filter((call) => call[0] === 'prompt')
if (prompts.length !== expected) fail('expected ' + expected + ' prompt deliveries, got ' + prompts.length)
for (const [, request] of prompts) {
  if (request.content[0].type !== 'file' || !request.content[0].receiptId) fail('prompt is missing the file part')
  if (request.content[1].type !== 'text' || request.content[1].text.trim() === '') fail('prompt is missing its text part')
}
const uploads = calls.filter((call) => call[0] === 'upload')
for (const [, name, size] of uploads) {
  if (!name.endsWith('.docx')) fail('uploaded the wrong file: ' + name)
  if (!(size > 1000)) fail('uploaded an empty docx: ' + size + ' bytes')
}

// Unzip one note and confirm the video section text really landed in the Word body.
const probe = records.find((record) => record.title === NEW_VIDEO)
const xml = execFileSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('" + probe.docxPath + "'); $e=$z.Entries | Where-Object { $_.FullName -eq 'word/document.xml' }; $r=New-Object IO.StreamReader($e.Open()); $r.ReadToEnd()",
], { encoding: 'utf8', timeout: 120000 })
if (!xml.includes('核心知识点')) fail('the Word body is missing the section heading')
if (!xml.includes('这是一节用于验证投递链的假课程')) fail('the Word body is missing the section quote')

const callsAfterFirst = calls.length
const second = await plugin.scanOnce({ force: true })
console.log('scan2', JSON.stringify(second))
if (second.delivered !== 0) fail('a second scan must stay silent')
if (calls.length !== callsAfterFirst) fail('a second scan must not touch the host, calls=' + calls.length)

console.log('E2E OK: ' + (process.exitCode === 1 ? 'with failures' : 'all assertions passed'))
console.log('artifacts in ' + work)
