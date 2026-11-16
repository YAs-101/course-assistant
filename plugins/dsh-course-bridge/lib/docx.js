/**
 * dsh-course-bridge: turning one coursemap section into a Word note.
 *
 * The Markdown emitted here stays inside the subset that
 * scripts/md2docx.py understands: H1/H2/H3 headings, "- " bullets
 * (two-space indentation per level), "> " quotes, fenced code blocks, and
 * bold/italic runs. Tables, links, images, and numbered lists are not
 * supported by that renderer and must not appear.
 *
 * @module dsh-course-bridge/lib/docx
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stamp } from './util.js'

/** Longest title line we keep in the note cover. */
const COVER_TITLE_MAX = 120

const NL = String.fromCharCode(10)
const EMPTY = String()

/**
 * Build the Markdown body of one course note.
 *
 * Two shapes are supported:
 *
 *  - "sections": an ordered list of blocks, each rendered as an H2 section.
 *    This is what an enriched note uses, so the reading order (summary first,
 *    then the subject manual, then the raw material) is explicit.
 *  - "section": one pre-built body, used by callers that already have Markdown
 *    and by the degraded path where the whole manual is the body.
 *
 * @param options - subject, title, either sections or a section, plus the
 *   source label shown on the cover.
 * @returns Markdown text ready for md2docx.py.
 */
export function buildNoteMd({ subject, title, section, sections, source, degraded = false, when = new Date() }) {
  const safeSubject = String(subject === undefined || subject === null ? EMPTY : subject).trim() || '未分类'
  const rawTitle = String(title === undefined || title === null ? EMPTY : title).trim() || '未命名视频'
  const coverTitle = rawTitle.length > COVER_TITLE_MAX ? rawTitle.slice(0, COVER_TITLE_MAX) + '…' : rawTitle
  const lines = []
  lines.push('# ' + coverTitle)
  lines.push(EMPTY)
  const meta = ['学科：' + safeSubject, '生成时间：' + stamp(when)]
  const label = String(source === undefined || source === null ? EMPTY : source).trim()
  if (label !== EMPTY) meta.push('素材：' + label)
  lines.push('> ' + meta.join(' · '))

  if (Array.isArray(sections) && sections.length > 0) {
    for (const item of sections) {
      const body = String(item && item.body !== undefined && item.body !== null ? item.body : EMPTY).trim()
      const heading = String(item && item.heading ? item.heading : EMPTY).trim()
      if (body === EMPTY && heading === EMPTY) continue
      lines.push(EMPTY)
      if (heading !== EMPTY) {
        lines.push('## ' + heading)
        lines.push(EMPTY)
      }
      lines.push(body === EMPTY ? '> 本节没有可用内容。' : body)
    }
    lines.push(EMPTY)
    return lines.join(NL)
  }

  const body = String(section === undefined || section === null ? EMPTY : section).trim()
  if (degraded) {
    lines.push(EMPTY)
    lines.push('> 说明：未能在学科手册中定位该视频的独立小节，以下内容为整份《' + safeSubject + '》学习手册全文。')
  }
  lines.push(EMPTY)
  lines.push(body === EMPTY ? '> 本次没有可用的视频总结内容。' : body)
  lines.push(EMPTY)
  return lines.join(NL)
}

/**
 * Locate a usable Python interpreter.
 *
 * The bundled DSH runtime wins because it always ships python-docx; a bare
 * "python" on PATH is only a fallback.
 *
 * @param extra - optional preferred interpreter path.
 * @returns absolute interpreter path, or null when nothing usable was found.
 */
export function findPython(extra) {
  const candidates = []
  if (typeof extra === 'string' && extra.trim() !== EMPTY) candidates.push(extra.trim())
  try {
    const root = join(homedir(), '.dsh', 'dsh-runtimes')
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const exe = join(root, name, 'dependencies', 'python', 'python.exe')
        if (existsSync(exe)) candidates.push(exe)
      }
    }
  } catch {
    /* the runtime directory is optional */
  }
  candidates.push('python', 'python3')
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const probe = spawnSync(candidate, ['--version'], { timeout: 15000, windowsHide: true, encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

/**
 * Run md2docx.py once.
 *
 * @param options - interpreter, script, source Markdown, and destination.
 * @returns ok flag plus the tool output (or the failure reason).
 */
/**
 * Whether a conversion produced a real file. A .docx always starts with the
 * ZIP magic "PK\u0003\u0004"; size is checked first because it is cheap.
 *
 * @param file - candidate path.
 * @returns true when the file exists, is non-empty, and looks like a ZIP.
 */
export function isUsableFile(file) {
  try {
    if (!existsSync(file) || statSync(file).size === 0) return false
    const fd = openSync(file, 'r')
    const head = Buffer.alloc(4)
    let read = 0
    try {
      read = readSync(fd, head, 0, 4, 0)
    } finally {
      closeSync(fd)
    }
    return read === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  } catch {
    return false
  }
}

export function convertToDocx({ pythonPath, scriptPath, mdPath, docxPath, timeoutMs = 120000 }) {
  // PYTHONIOENCODING matters: a Bilibili title can carry emoji, and the script
  // echoes the output path. Under the default GBK console code page that echo
  // raises UnicodeEncodeError *after* the .docx has already been written.
  const result = spawnSync(pythonPath, [scriptPath, mdPath, docxPath], {
    timeout: timeoutMs,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  })
  if (result.error) return { ok: false, message: String(result.error.message || result.error) }
  const stdout = String(result.stdout || EMPTY).trim()
  const stderr = String(result.stderr || EMPTY).trim()
  if (result.status !== 0) {
    // The conversion itself may have succeeded; only the success banner failed.
    // Trust the artefact over the exit code so one emoji cannot lose a note.
    if (!isUsableFile(docxPath)) {
      return { ok: false, message: 'md2docx exit ' + String(result.status) + ': ' + (stderr || stdout || 'no output') }
    }
  }
  try {
    if (!isUsableFile(docxPath)) {
      return { ok: false, message: 'md2docx reported success but produced no file at ' + docxPath }
    }
  } catch (error) {
    return { ok: false, message: 'produced docx is not readable: ' + String(error && error.message ? error.message : error) }
  }
  return { ok: true, message: stdout }
}

/**
 * Write the Markdown next to the note, convert it, and clean the intermediate
 * file up on success (it is kept on failure so the error can be diagnosed).
 *
 * @param options - destination directory, base name, Markdown, and tool paths.
 * @returns ok flag, docx path, and diagnostics.
 */
export function writeNoteDocx({ notesDir, baseName, md, pythonPath, scriptPath }) {
  if (!pythonPath) {
    return { ok: false, message: 'no python interpreter found (looked in ~/.dsh/dsh-runtimes and PATH)', docxPath: EMPTY, mdPath: EMPTY }
  }
  if (!existsSync(scriptPath)) return { ok: false, message: 'md2docx.py is missing at ' + scriptPath, docxPath: EMPTY, mdPath: EMPTY }
  mkdirSync(notesDir, { recursive: true })
  const mdPath = join(notesDir, baseName + '.md')
  const docxPath = join(notesDir, baseName + '.docx')
  try {
    writeFileSync(mdPath, md, 'utf8')
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    return { ok: false, message: 'cannot write the note Markdown: ' + reason, docxPath: EMPTY, mdPath: EMPTY }
  }
  const converted = convertToDocx({ pythonPath, scriptPath, mdPath, docxPath })
  if (!converted.ok) return { ok: false, message: converted.message, docxPath: EMPTY, mdPath }
  try {
    unlinkSync(mdPath)
  } catch {
    /* leaving the intermediate Markdown behind is harmless */
  }
  return { ok: true, message: converted.message, docxPath, mdPath: EMPTY }
}
