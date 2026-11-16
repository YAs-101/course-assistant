/**
 * Read-only views over the knowledge-map directory.
 *
 * Everything the UI shows on the right-hand side comes from files the coursemap
 * plugin and the bridge plugin already write. This module never writes into that
 * directory: it only reports what is there, and degrades to empty values when a
 * file is missing, still being written, or corrupt.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Separator used in bridge ledger keys: `<学科>\u0000<标题>`. */
export const KEY_SEP = '\u0000'

/**
 * Read and parse a JSON file, tolerating every failure mode.
 *
 * A `state.json` caught mid-write is a very real case (the plugin writes with
 * temp+rename, but the bridge and the app may read between steps), so a parse
 * failure is reported as `{ ok: false }` and callers continue with empty data
 * rather than crashing the whole status endpoint.
 *
 * @param file - absolute path.
 * @returns `{ ok, value, size, mtime, reason }`.
 */
export function readJsonFile(file) {
  if (!existsSync(file)) return { ok: false, value: null, size: 0, mtime: 0, reason: 'missing' }
  try {
    const stat = statSync(file)
    const text = readFileSync(file, 'utf8')
    const value = JSON.parse(text)
    return { ok: true, value, size: stat.size, mtime: stat.mtimeMs, reason: null }
  } catch (error) {
    return { ok: false, value: null, size: 0, mtime: 0, reason: `${error?.message ?? error}` }
  }
}

/**
 * Read a UTF-8 text file, returning '' when unreadable.
 *
 * Note: never read these files through PowerShell's `Get-Content` on this
 * machine -- PowerShell 5.1 decodes BOM-less UTF-8 as ANSI and turns every
 * Chinese character into mojibake. Node's utf8 decode is correct.
 *
 * @param file - absolute path.
 * @returns `{ text, size, mtime, ok }`.
 */
export function readTextFile(file) {
  if (!existsSync(file)) return { text: '', size: 0, mtime: 0, ok: false }
  try {
    const stat = statSync(file)
    return { text: readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), size: stat.size, mtime: stat.mtimeMs, ok: true }
  } catch {
    return { text: '', size: 0, mtime: 0, ok: false }
  }
}

/**
 * Normalize the coursemap `state.json` into a shape the UI can trust.
 *
 * @param raw - parsed state.json value.
 * @returns `{ subjects: [{name, videos, createdAt}], seen, lastTitle, lastRunAt }`.
 */
export function normalizeState(raw) {
  const out = { subjects: [], seen: {}, lastTitle: '', lastRunAt: 0 }
  if (!raw || typeof raw !== 'object') return out
  const subjects = raw.subjects && typeof raw.subjects === 'object' ? raw.subjects : {}
  for (const [name, entry] of Object.entries(subjects)) {
    const videos = Array.isArray(entry?.videos) ? entry.videos.filter((v) => typeof v === 'string' && v.trim()) : []
    out.subjects.push({
      name: String(name),
      videos,
      createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : 0,
    })
  }
  if (raw.seen && typeof raw.seen === 'object') out.seen = raw.seen
  if (typeof raw.lastTitle === 'string') out.lastTitle = raw.lastTitle
  if (Number.isFinite(raw.lastRunAt)) out.lastRunAt = raw.lastRunAt
  return out
}

/**
 * Load the whole knowledge-map directory.
 *
 * @param outputDir - knowledge-map root.
 * @returns a snapshot with subjects, manual paths, notes and the overview.
 */
export function readKnowledgeMap(outputDir) {
  const stateDir = join(outputDir, '.state')
  const stateFile = join(stateDir, 'state.json')
  const manualDir = join(stateDir, 'manuals')
  const indexFile = join(manualDir, 'index.md')

  const stateRead = readJsonFile(stateFile)
  const state = normalizeState(stateRead.value)

  const subjects = state.subjects.map((entry) => {
    const manualMd = join(manualDir, `${entry.name}.md`)
    const manualDocx = join(outputDir, entry.name, '学习手册.docx')
    const mdStat = statOf(manualMd)
    const docxStat = statOf(manualDocx)
    return {
      ...entry,
      orphan: false,
      manualMd,
      manualDocx,
      manualMdOk: mdStat !== null,
      manualDocxOk: docxStat !== null,
      manualUpdatedAt: Math.max(mdStat?.mtimeMs ?? 0, docxStat?.mtimeMs ?? 0),
    }
  })

  // state.json is not authoritative: two pollers (the app and the copy of the
  // plugin inside DeepSeek Harness) write the same file, and whichever holds the
  // older in-memory copy can drop a subject that already has a manual on disk.
  // The manuals directory is the durable record, so surface orphaned manuals
  // instead of letting a video vanish from the UI.
  let manualNames = []
  try { manualNames = readdirSync(manualDir) } catch { manualNames = [] }
  for (const name of manualNames) {
    if (!/\.md$/i.test(name) || name === 'index.md') continue
    const stem = name.replace(/\.md$/i, '')
    if (subjects.some((s) => s.name === stem)) continue
    const manualMd = join(manualDir, name)
    const mdStat = statOf(manualMd)
    const manualDocx = join(outputDir, stem, '学习手册.docx')
    const docxStat = statOf(manualDocx)
    const read = readTextFile(manualMd)
    const videos = read.ok ? splitManual(read.text).sections.map((s) => s.title).filter(Boolean) : []
    subjects.push({
      name: stem,
      videos,
      createdAt: 0,
      orphan: true,
      manualMd,
      manualDocx,
      manualMdOk: mdStat !== null,
      manualDocxOk: docxStat !== null,
      manualUpdatedAt: Math.max(mdStat?.mtimeMs ?? 0, docxStat?.mtimeMs ?? 0),
    })
  }

  return {
    outputDir,
    stateFile,
    stateOk: stateRead.ok,
    stateReason: stateRead.reason,
    stateUpdatedAt: stateRead.mtime,
    subjects,
    seenCount: Object.keys(state.seen).length,
    lastTitle: state.lastTitle,
    lastRunAt: state.lastRunAt,
    indexFile,
    index: readTextFile(indexFile),
    notes: listNotes(outputDir),
  }
}

/**
 * Stat a path without throwing.
 *
 * @param file - absolute path.
 * @returns stat object or null.
 */
export function statOf(file) {
  try {
    if (!existsSync(file)) return null
    return statSync(file)
  } catch {
    return null
  }
}

/**
 * List docx notes plus each subject's handbook.
 *
 * @param outputDir - knowledge-map root.
 * @param notesDirName - subdirectory holding per-video notes.
 * @returns `{ notes: [...], handbooks: [...] }` with sizes and mtimes.
 */
export function listNotes(outputDir, notesDirName = '笔记') {
  const notesDir = join(outputDir, notesDirName)
  const notes = []
  if (existsSync(notesDir)) {
    let names = []
    try { names = readdirSync(notesDir) } catch { names = [] }
    for (const name of names) {
      if (!/\.docx$/i.test(name)) continue
      const full = join(notesDir, name)
      const stat = statOf(full)
      if (!stat) continue
      notes.push({ name, path: full, rel: join(notesDirName, name), size: stat.size, mtime: stat.mtimeMs, kind: 'note' })
    }
  }
  notes.sort((a, b) => b.mtime - a.mtime)

  const handbooks = []
  const overview = join(outputDir, '课程总览.docx')
  const overviewStat = statOf(overview)
  if (overviewStat) {
    handbooks.push({ name: '课程总览.docx', path: overview, rel: '课程总览.docx', size: overviewStat.size, mtime: overviewStat.mtimeMs, kind: 'overview' })
  }
  let entries = []
  try { entries = readdirSync(outputDir, { withFileTypes: true }) } catch { entries = [] }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const full = join(outputDir, entry.name, '学习手册.docx')
    const stat = statOf(full)
    if (!stat) continue
    handbooks.push({ name: `${entry.name}/学习手册.docx`, path: full, rel: join(entry.name, '学习手册.docx'), size: stat.size, mtime: stat.mtimeMs, kind: 'handbook', subject: entry.name })
  }
  return { notes, handbooks }
}

/**
 * Split one subject manual into an overview block and per-video sections.
 *
 * The manual layout written by the plugin is:
 *
 *   # <学科> 学习手册
 *   <!-- OVERVIEW_START --> ... mermaid ... <!-- OVERVIEW_END -->
 *   ## <视频标题>
 *   > 简介
 *   ### 核心知识点
 *   ...
 *
 * @param text - manual markdown.
 * @returns `{ title, overview, sections: [{title, markdown}] }`.
 */
export function splitManual(text) {
  const src = String(text ?? '')
  const titleMatch = /^#\s+(.+)$/m.exec(src)
  const title = titleMatch ? titleMatch[1].trim() : ''

  let overview = ''
  const start = src.indexOf('<!-- OVERVIEW_START -->')
  const end = src.indexOf('<!-- OVERVIEW_END -->')
  if (start >= 0 && end > start) {
    overview = src.slice(start + '<!-- OVERVIEW_START -->'.length, end).trim()
  }

  const sections = []
  const lines = src.split(/\r?\n/)
  let current = null
  let inOverview = false
  for (const line of lines) {
    // The overview block uses a `## 学科总览` heading of its own. Without this
    // guard it would be collected as a video section, so a subject would show a
    // phantom entry named 学科总览 and count one video too many.
    if (line.includes('<!-- OVERVIEW_START -->')) { inOverview = true; continue }
    if (line.includes('<!-- OVERVIEW_END -->')) { inOverview = false; continue }
    if (inOverview) continue
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      if (current) sections.push(current)
      current = { title: heading[1].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(current)

  return {
    title,
    overview,
    sections: sections.map((s) => ({ title: s.title, markdown: s.lines.join('\n').trim() })),
  }
}

/**
 * Read one subject manual and split it.
 *
 * @param outputDir - knowledge-map root.
 * @param subject - subject name (used as the file stem).
 * @returns `{ ok, subject, title, overview, sections, mtime, reason }`.
 */
export function readManual(outputDir, subject) {
  if (typeof subject !== 'string' || !subject.trim()) return { ok: false, subject: '', title: '', overview: '', sections: [], mtime: 0, reason: '缺少学科名' }
  const name = subject.trim()
  if (name.includes('..') || /[\\/]/.test(name)) return { ok: false, subject: name, title: '', overview: '', sections: [], mtime: 0, reason: '学科名非法' }
  const file = join(outputDir, '.state', 'manuals', `${name}.md`)
  const read = readTextFile(file)
  if (!read.ok) return { ok: false, subject: name, title: '', overview: '', sections: [], mtime: 0, reason: '手册尚未生成' }
  const split = splitManual(read.text)
  return { ok: true, subject: name, title: split.title, overview: split.overview, sections: split.sections, mtime: read.mtime, reason: null }
}

/**
 * Normalize the bridge ledger (`bridge.json`).
 *
 * @param raw - parsed ledger.
 * @returns `{ initialized, delivered, pending, abandoned, sessions }` as arrays with a readable key.
 */
export function normalizeBridge(raw) {
  const pick = (bucket) => {
    const out = []
    if (!bucket || typeof bucket !== 'object') return out
    for (const [key, value] of Object.entries(bucket)) {
      const [subject, title] = key.includes(KEY_SEP) ? key.split(KEY_SEP) : ['', key]
      out.push({ key, subject, title, ...(value && typeof value === 'object' ? value : {}) })
    }
    return out
  }
  return {
    version: Number.isFinite(raw?.version) ? raw.version : 0,
    initialized: Boolean(raw?.initialized),
    delivered: pick(raw?.delivered),
    pending: pick(raw?.pending),
    abandoned: pick(raw?.abandoned),
    sessions: raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
  }
}

/**
 * Read the bridge diagnostics trio.
 *
 * `heartbeat.at` is the liveness signal: the bridge writes it on every scan, so
 * a stale value means DeepSeek Harness is not running (or the bridge is off).
 *
 * @param outputDir - knowledge-map root.
 * @param now - current epoch ms (injectable for tests).
 * @returns `{ boot, heartbeat, alive, ageMs, ledger, logTail }`.
 */
export function readBridge(outputDir, now = Date.now()) {
  const stateDir = join(outputDir, '.state')
  const boot = readJsonFile(join(stateDir, 'bridge.boot.json'))
  const heartbeat = readJsonFile(join(stateDir, 'bridge.heartbeat.json'))
  const ledger = readJsonFile(join(stateDir, 'bridge.json'))
  const log = readTextFile(join(stateDir, 'bridge.log'))
  const at = Number.isFinite(heartbeat.value?.at) ? heartbeat.value.at : 0
  const ageMs = at > 0 ? Math.max(0, now - at) : null
  const alive = ageMs !== null && ageMs < 15000
  const lines = log.text ? log.text.trimEnd().split('\n') : []
  return {
    boot: boot.ok ? boot.value : null,
    heartbeat: heartbeat.ok ? heartbeat.value : null,
    alive,
    ageMs,
    ledger: normalizeBridge(ledger.ok ? ledger.value : null),
    ledgerOk: ledger.ok,
    logTail: lines.slice(-40),
  }
}

/**
 * Flatten the knowledge map into a subject tree usable by the UI.
 *
 * @param outputDir - knowledge-map root.
 * @returns `{ subjects: [{ name, videos, sections }], notes }`.
 */
export function readTree(outputDir) {
  const km = readKnowledgeMap(outputDir)
  const subjects = km.subjects.map((entry) => {
    const manual = readManual(outputDir, entry.name)
    return {
      name: entry.name,
      videos: entry.videos,
      orphan: entry.orphan === true,
      manualMd: entry.manualMd,
      manualMdOk: entry.manualMdOk,
      manualDocx: entry.manualDocx,
      manualDocxOk: entry.manualDocxOk,
      updatedAt: entry.manualUpdatedAt,
      overview: manual.ok ? manual.overview : '',
      sections: manual.ok ? manual.sections : [],
      sectionTitles: manual.ok ? manual.sections.map((s) => s.title) : [],
    }
  })
  return { subjects, notes: km.notes, lastTitle: km.lastTitle, lastRunAt: km.lastRunAt, stateOk: km.stateOk, stateReason: km.stateReason }
}

/**
 * Human-readable file size for the UI.
 *
 * @param bytes - byte count.
 * @returns a short label such as `41 KB`.
 */
export function formatSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Basename helper re-exported so callers do not import `node:path` twice.
 *
 * @param p - path.
 * @returns the final segment.
 */
export function baseName(p) {
  return basename(String(p ?? ''))
}
