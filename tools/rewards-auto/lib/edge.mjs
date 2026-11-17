/**
 * Edge process handling: is it safe to start, how to start it with a debuggable
 * profile, and how to make it go away afterwards.
 *
 * Three facts from measuring this machine shape the whole module:
 *
 *   1. Chromium 136+ refuses `--remote-debugging-port` when `--user-data-dir`
 *      is literally the default profile path. Routing the same directory
 *      through an NTFS junction changes the literal path and is accepted, so
 *      the runner keeps the real signed-in profile instead of a copy. (A copy
 *      does not work: Edge's app-bound cookie encryption ties the cookies to
 *      the original profile identity.)
 *   2. A second Edge instance cannot open a debug port while the default
 *      profile is already in use, so any background Edge must be killed first.
 *   3. Headless Edge earns no rewards points; only a headed window with real
 *      key events does. Hence the window is started visible, then minimized.
 *
 * SAFETY: deleting a junction with a recursive delete follows it into the real
 * Edge profile and destroys it. Only `cmd /c rmdir "<link>"` is allowed here,
 * and `removeJunction` refuses anything that is not a reparse point.
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, lstatSync, readlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'

/** Run a command and collect its output; never rejects. */
function run(command, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: error ?? null,
      })
    })
  })
}

/**
 * Parse the `<pid> <windowHandle>` lines emitted by the process listing.
 *
 * Plain text rather than JSON on purpose: this machine runs Windows PowerShell
 * 5.1, where `ConvertTo-Json` has no `-AsArray` switch (that is 6.0+). Asking
 * for it made the whole listing fail, which the caller read as "no Edge
 * running" -- so a visible Edge window was never detected and the run went on
 * to launch a doomed second instance. Emitting two columns needs no JSON at all
 * and behaves the same on 5.1 and 7.
 *
 * @returns `[{ pid, hasWindow }]`, or `[]` for blank/invalid input.
 */
export function parseProcessList(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .map((parts) => ({ pid: Number(parts[0]), win: Number(parts[1]) }))
    .filter((row) => Number.isFinite(row.pid) && row.pid > 0)
    .map((row) => ({ pid: row.pid, hasWindow: Number.isFinite(row.win) && row.win !== 0 }))
}

/**
 * Enumerate msedge processes and whether each owns a visible window.
 *
 * `MainWindowHandle` is 0 for the many helper processes Edge keeps in the
 * background; a non-zero handle means the user can actually see a window, which
 * is the signal that the runner must stay out of the way.
 *
 * @returns `[{ pid, hasWindow }]`, empty when Edge is not running.
 */
export async function listEdgeProcesses() {
  // `exit 0` matters: with no msedge running, `Get-Process -ErrorAction
  // SilentlyContinue` still leaves powershell.exe with exit code 1, which is
  // otherwise indistinguishable from a broken command.
  const script =
    'Get-Process -Name msedge -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { "$($_.Id) $($_.MainWindowHandle.ToInt64())" }; exit 0'
  const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
  // A failing command must not read as "Edge is not running": that would
  // silently disable the visible-window guard, which this module already got
  // wrong once.
  if (result.error?.code === 'ENOENT') {
    throw new Error('could not run powershell.exe (not found in PATH)')
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim() || 'no output'
    throw new Error(`could not list msedge processes (exit ${result.code}): ${detail}`)
  }
  return parseProcessList(result.stdout)
}

/**
 * Decide what the preflight should do, given the current Edge processes.
 *
 * Pure so the three-way policy is testable without a browser:
 *
 *   - nothing running            -> proceed
 *   - only background processes  -> kill them, then proceed
 *   - any visible window         -> skip this attempt entirely
 *
 * The visible-window case is deliberate: killing a window the user just opened
 * would be hostile, and the task retries later anyway.
 *
 * @returns `'proceed' | 'kill-background' | 'skip-visible-window'`.
 */
export function decidePreflight(procs) {
  const list = Array.isArray(procs) ? procs : []
  if (list.length === 0) return 'proceed'
  if (list.some((proc) => proc && proc.hasWindow)) return 'skip-visible-window'
  return 'kill-background'
}

/** Sleep helper shared by the polling loops below. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Kill every msedge process and wait until none is left.
 *
 * Throws rather than proceeding when the processes survive, because starting a
 * second instance against the same profile would silently fail to open a debug
 * port and the run would hang instead of reporting the real problem.
 */
export async function killAllEdge({ timeoutMs = 8000 } = {}) {
  await run('taskkill', ['/IM', 'msedge.exe', '/F'], { timeoutMs })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const procs = await listEdgeProcesses()
    if (procs.length === 0) return { killed: true }
    if (Date.now() > deadline) {
      throw new Error(
        `could not stop Edge: ${procs.length} process(es) still running after ${timeoutMs}ms`,
      )
    }
    await sleep(300)
  }
}

/** True when the path exists and is a reparse point (symlink or junction). */
export function isReparsePoint(path) {
  try {
    const stat = lstatSync(path)
    return stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** Where an existing link points, or null when it is not a link. */
export function readLinkTarget(path) {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/** Normalize a Windows path for comparison (case- and separator-insensitive). */
export function samePath(a, b) {
  if (!a || !b) return false
  const norm = (value) =>
    String(value)
      .replace(/[\\/]+/g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Make sure `linkPath` is a junction pointing at `targetPath`.
 *
 * An existing junction to the right place is reused (that is the normal case
 * after the first run). An existing junction to somewhere else, or a real
 * directory, is an error: silently replacing it could hide a path mistake that
 * costs the user their browser profile.
 *
 * @returns `{ created, linkPath, targetPath }`.
 */
export async function ensureJunction({ linkPath, targetPath }) {
  if (!linkPath || !targetPath) throw new Error('ensureJunction: linkPath and targetPath required')
  if (!existsSync(targetPath)) {
    throw new Error(`Edge User Data directory not found: ${targetPath}`)
  }
  if (isReparsePoint(linkPath)) {
    const current = readLinkTarget(linkPath)
    if (samePath(current, targetPath)) return { created: false, linkPath, targetPath }
    throw new Error(
      `refusing to replace junction ${linkPath}: it points at ${current ?? '<unknown>'}, ` +
        `not ${targetPath}`,
    )
  }
  if (existsSync(linkPath)) {
    throw new Error(
      `refusing to use ${linkPath}: a real directory is in the way (expected a junction)`,
    )
  }
  const result = await run('cmd', ['/c', 'mklink', '/J', linkPath, targetPath])
  if (result.code !== 0) {
    throw new Error(
      `mklink failed (exit ${result.code}): ${(result.stderr || result.stdout).trim() || 'no output'}`,
    )
  }
  if (!isReparsePoint(linkPath)) throw new Error(`mklink reported success but ${linkPath} is not a junction`)
  return { created: true, linkPath, targetPath }
}

/**
 * Delete the junction without ever following it.
 *
 * `rmdir` on a junction removes the link only. Anything recursive would wipe
 * the real profile, so this is the single place allowed to touch it.
 */
export async function removeJunction(linkPath) {
  if (!existsSync(linkPath)) return { removed: false }
  if (!isReparsePoint(linkPath)) {
    throw new Error(`refusing to remove ${linkPath}: not a junction (recursive delete would be unsafe)`)
  }
  const result = await run('cmd', ['/c', 'rmdir', linkPath])
  if (result.code !== 0) {
    throw new Error(`rmdir failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`)
  }
  return { removed: true }
}

/** Ask the OS for a free TCP port by binding and immediately releasing one. */
export function freePortCandidate() {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.on('error', () => resolve(null))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : null
      server.close(() => resolve(port))
    })
  })
}

/** True when something is already serving the CDP endpoint on this port. */
export async function isPortOpen(port, { timeoutMs = 800 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Launch Edge headed, against the junctioned profile, with a debug port.
 *
 * No `--headless`: headless builds report a `HeadlessChrome` user agent and the
 * rewards backend stops crediting searches. The window is sized like a real one
 * and minimized by the caller once attached.
 *
 * @returns `{ child, pid }`; the caller owns teardown.
 */
export function launchEdge({
  exePath,
  userDataDir,
  port,
  width = 1280,
  height = 900,
  startUrl = 'about:blank',
}) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--window-position=0,0',
    `--window-size=${width},${height}`,
    startUrl,
  ]
  const child = spawn(exePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  return { child, pid: child.pid ?? null, args }
}

/**
 * Wait until the CDP endpoint answers, then return its browser websocket URL.
 *
 * Retries across the configured port range so a port that turns out to be taken
 * between the free-port probe and the launch costs a retry rather than an
 * outage.
 */
export async function waitForDebugPort({
  port,
  portRange = 1,
  timeoutMs = 30000,
  isOpen = isPortOpen,
  now = Date.now,
  pause = sleep,
} = {}) {
  const deadline = now() + timeoutMs
  let lastError = null
  for (;;) {
    for (let offset = 0; offset < Math.max(1, portRange); offset += 1) {
      const candidate = port + offset
      if (await isOpen(candidate)) {
        try {
          const response = await fetch(`http://127.0.0.1:${candidate}/json/version`)
          const info = await response.json()
          if (info?.webSocketDebuggerUrl) {
            return { port: candidate, webSocketDebuggerUrl: info.webSocketDebuggerUrl, info }
          }
        } catch (error) {
          lastError = error
        }
      }
    }
    if (now() > deadline) {
      throw new Error(
        `debug port never opened on ${port}${portRange > 1 ? `-${port + portRange - 1}` : ''} ` +
          `after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}` +
          ' (is another Edge already using this profile?)',
      )
    }
    await pause(250)
  }
}

/**
 * Shut Edge down and confirm it is gone.
 *
 * Order matters: `Browser.close` is the graceful path and lets Edge flush its
 * profile, `taskkill /PID` is the fallback, and the `/IM` sweep only runs when
 * nothing visible is on screen -- killing a window the user opened mid-run
 * would be wrong, so that case is reported instead.
 *
 * @returns `{ status }` where status is `'closed'`, `'edge-left-running'` or
 *   `'closed-with-extra-targets'`.
 */
export async function closeEdge({
  cdp,
  pid,
  timeoutMs = 15000,
  listProcs = listEdgeProcesses,
  pause = sleep,
}) {
  const deadline = Date.now() + timeoutMs
  let extraTargets = false
  if (cdp) {
    try {
      await cdp.send('Browser.close', {}, undefined, { timeoutMs: 5000 })
    } catch {
      /* the socket usually dies as the browser exits; the process check decides */
    }
  }
  // Give the graceful path a moment before forcing anything.
  for (let i = 0; i < 20; i += 1) {
    const procs = await listProcs()
    if (procs.length === 0) return { status: extraTargets ? 'closed-with-extra-targets' : 'closed' }
    if (procs.some((proc) => proc.hasWindow)) {
      return { status: 'edge-left-running', processes: procs }
    }
    await pause(250)
  }
  if (pid) {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 })
  }
  let procs = await listProcs()
  if (procs.length > 0) {
    if (procs.some((proc) => proc.hasWindow)) {
      return { status: 'edge-left-running', processes: procs }
    }
    extraTargets = true
    await run('taskkill', ['/IM', 'msedge.exe', '/F'], { timeoutMs: 8000 })
    for (;;) {
      procs = await listProcs()
      if (procs.length === 0) break
      if (Date.now() > deadline) {
        throw new Error(`Edge still running after forced kill: ${procs.length} process(es)`)
      }
      await pause(250)
    }
  }
  return { status: extraTargets ? 'closed-with-extra-targets' : 'closed' }
}
