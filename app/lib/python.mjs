/**
 * Locate a Python interpreter that can run `md2docx.py`.
 *
 * The coursemap plugin resolves Python once at startup with the same priority
 * order used here (DSH's bundled runtime first, then PATH), so reporting the same
 * choice in the UI keeps the explanation honest when a conversion fails.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Check that a candidate interpreter actually runs.
 *
 * `--version` writes to stderr on some builds, so both streams are inspected.
 *
 * @param candidate - path or command name.
 * @param timeoutMs - spawn timeout.
 * @returns `{ ok, version }`.
 */
export function probePython(candidate, { timeoutMs = 8000 } = {}) {
  const result = spawnSync(candidate, ['--version'], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })
  if (result.error) return { ok: false, version: '' }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) return { ok: false, version: text }
  return { ok: /python\s+\d/i.test(text) || /^\d+\.\d+/.test(text), version: text }
}

/**
 * Find a usable Python interpreter.
 *
 * Order: every DSH runtime bundle under `~/.dsh/dsh-runtimes/*` (newest name
 * wins by slice order), then `python`, then `python3`.
 *
 * @param extra - explicit path from settings, tried first.
 * @returns `{ path, source, version }`; `path` is null when nothing worked.
 */
export function findPythonSync(extra = null) {
  const tried = []
  const candidates = []
  if (extra && String(extra).trim()) candidates.push({ path: String(extra).trim(), source: 'config' })

  const runtimes = join(homedir(), '.dsh', 'dsh-runtimes')
  if (existsSync(runtimes)) {
    let names = []
    try { names = readdirSync(runtimes) } catch { names = [] }
    for (const name of names) {
      candidates.push({
        path: join(runtimes, name, 'dependencies', 'python', 'python.exe'),
        source: 'dsh-runtime',
      })
    }
  }
  candidates.push({ path: 'python', source: 'path' })
  candidates.push({ path: 'python3', source: 'path' })

  for (const candidate of candidates) {
    if (candidate.source !== 'path' && !existsSync(candidate.path)) continue
    const probe = probePython(candidate.path)
    tried.push({ path: candidate.path, ok: probe.ok, version: probe.version })
    if (probe.ok) return { path: candidate.path, source: candidate.source, version: probe.version, tried }
  }
  return { path: null, source: null, version: '', tried }
}

/**
 * Verify that an interpreter can import `docx` (what md2docx.py needs).
 *
 * @param pythonPath - interpreter path.
 * @returns `{ ok, version, reason }`.
 */
export function probePythonDocx(pythonPath) {
  if (!pythonPath) return { ok: false, version: '', reason: '未找到 Python' }
  const result = spawnSync(pythonPath, ['-c', 'import docx; print(docx.__version__ if hasattr(docx,"__version__") else "ok")'], {
    timeout: 15000,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.error) return { ok: false, version: '', reason: result.error.message }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) return { ok: false, version: '', reason: text.slice(0, 300) }
  return { ok: true, version: text.split('\n').pop()?.slice(0, 40) ?? '', reason: null }
}
