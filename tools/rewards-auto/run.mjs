/**
 * Entry point: earn today's Microsoft Rewards search points, then close Edge.
 *
 * The full sequence, and why it is ordered this way:
 *
 *   1. Preflight. A second Edge cannot open a debug port against a profile that
 *      is already in use, so background Edge processes must go first. A *visible*
 *      Edge window is the opposite case -- the user is using it, so the run bows
 *      out and the scheduled task retries later.
 *   2. Junction. Chromium 136+ refuses to expose a debug port when
 *      `--user-data-dir` is literally the default profile path; going through a
 *      junction keeps the real signed-in profile while sidestepping that check.
 *   3. Headed launch, then focus emulation + minimize. Headless earns nothing,
 *      and a minimized window earns nothing without focus emulation, so all
 *      three are required together.
 *   4. Read status, and stop immediately if today's points are already in.
 *   5. Search until the pool is full, giving up after two searches in a row that
 *      add nothing (that is the signature of a backend change, not of bad luck).
 *   6. Close Edge, always, and leave a JSONL log with the outcome.
 *
 * Exit code 0 means "nothing more to do" -- including the already-full and
 * skipped cases, which are successes, not errors. Exit code 1 means the run
 * could not do its job and the log says why.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { connect } from './lib/cdp.mjs'
import { loadConfig, stateDir } from './lib/config.mjs'
import {
  closeEdge,
  decidePreflight,
  ensureJunction,
  isPortOpen,
  killAllEdge,
  launchEdge,
  listEdgeProcesses,
  waitForDebugPort,
} from './lib/edge.mjs'
import { createLogger, defaultLogPath, summaryRecord } from './lib/log.mjs'
import { describeState, isFull, readStatus, searchRemaining } from './lib/rewards.mjs'
import { pickQueries, rngMs, searchOnce } from './lib/search.mjs'

/** Statuses that mean the run did its job; anything else exits non-zero. */
const SUCCESS_STATUS = new Set([
  'ok',
  'already-full',
  'skipped-edge-busy',
  'closed-with-extra-targets',
])

/**
 * Does a search that added no points indicate a broken session?
 *
 * No, when the daily maximum is already banked: a `--force` run keeps searching
 * past the cap, and every one of those searches gains zero by design. Counting
 * them as failures made a perfectly good run report `no-progress`.
 */
export function countsAsCreditingFailure(gained, fullNow) {
  return gained <= 0 && !fullNow
}

/** Parse the small CLI surface. Unknown flags are ignored on purpose. */
export function parseArgs(argv) {
  const out = { preflightOnly: false, force: false, verbose: false, port: null, help: false }
  const args = Array.isArray(argv) ? argv : []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--preflight-only') out.preflightOnly = true
    else if (arg === '--force') out.force = true
    else if (arg === '--verbose') out.verbose = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--port') {
      const value = Number(args[i + 1])
      if (Number.isFinite(value) && value > 0) {
        out.port = value
        i += 1
      }
    }
  }
  return out
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The usage text printed by `--help`. */
export const USAGE = `ms-rewards-auto -- earn daily Microsoft Rewards search points

  node run.mjs                    earn today's points (no-op if already full)
  node run.mjs --preflight-only   report what Edge is doing and what the run would do
  node run.mjs --force            search even if today's points are already full
  node run.mjs --port 9333        pin the debugging port
  node run.mjs --verbose          echo log records to stderr as well

Config: %LOCALAPPDATA%\\ms-rewards-auto\\config.json (optional, JSON overrides).
`

/**
 * Pick the page target out of `/json/list`.
 *
 * Two things here are easy to get wrong, so both are pinned by tests:
 *
 *   - The HTTP listing names the id `id`, while `Target.attachToTarget` wants
 *     `targetId`. Passing the listing entry straight through sends
 *     `targetId: undefined` and Chrome answers "Invalid parameters".
 *   - Filtering on `type === 'page'` skips service workers, iframes and other
 *     targets that cannot be navigated to a search page.
 *
 * @returns The target with `targetId` filled in, or `null` when there is none.
 */
export function pickPageTarget(targets) {
  const list = Array.isArray(targets) ? targets : []
  const page = list.find(
    (target) => target?.type === 'page' && (target.targetId || target.id) && target.webSocketDebuggerUrl,
  )
  if (!page) return null
  return { ...page, targetId: page.targetId ?? page.id }
}

/** Find the page target the browser opened at startup. */
export async function findPageTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await response.json()
  const page = pickPageTarget(targets)
  if (!page) {
    const count = Array.isArray(targets) ? targets.length : 0
    throw new Error(`no page target on port ${port} (found ${count} target(s))`)
  }
  return page
}

/** Attach to a target in flat mode and return its session id. */
export async function attach(cdp, targetId) {
  const result = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const sid = result?.sessionId
  if (!sid) throw new Error('attachToTarget returned no sessionId')
  return sid
}

/**
 * Read the status, retrying while the dashboard is still filling in.
 *
 * The flyout endpoint answers 200 very soon after navigation, but the counters
 * can be absent for the first second or two -- observed on this machine as a
 * "counters.PCSearch missing" failure on a run that then succeeded unchanged.
 * Retrying turns that race into a short wait; a genuinely signed-out session
 * still fails, just after a few more attempts.
 *
 * @returns the last read result, or throws the last error.
 */
export async function readStatusWithRetry({
  read,
  attempts = 4,
  delayMs = 1500,
  sleep = defaultSleep,
  onRetry = () => {},
}) {
  let lastError = null
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      return await read()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        onRetry(attempt, error)
        await sleep(delayMs)
      }
    }
  }
  throw lastError
}

/**
 * Run the whole job.
 *
 * Dependencies are injectable (`makeCdp`, `launch`, `listProcs`, `logger`,
 * `sleeper`) so the orchestration can be exercised without starting a browser.
 * There is exactly one exit path: every branch sets `status`, and the teardown
 * block below it computes the log summary and the return value. That is
 * deliberate -- an early `return` from inside the `try` would skip the
 * teardown that closes Edge.
 *
 * @returns `{ status, exitCode, summary }`.
 */
export async function run({
  argv = [],
  env = process.env,
  logger,
  makeCdp = connect,
  launch = launchEdge,
  listProcs = listEdgeProcesses,
  sleeper = defaultSleep,
} = {}) {
  const args = parseArgs(argv)
  const startedAt = Date.now()
  const { config, warning, source, file } = loadConfig({ env })
  const dir = stateDir(env)
  const echo = (message) => {
    if (args.verbose) console.error(message)
  }
  const log =
    logger ??
    createLogger({
      file: defaultLogPath(join(dir, 'logs')),
      onError: (error) => echo(`log write failed: ${error.message}`),
    })

  log.info('start', { args, configSource: source, configFile: file, port: args.port ?? config.port })
  if (warning) log.warn('config ignored', { warning })
  echo(`config: ${source} (${file})`)

  let cdp = null
  let edgePid = null
  let edgeLaunched = false
  let preState = null
  let postState = null
  let searches = 0
  let status = 'failed'
  let reason = null
  let preflightDecision = null

  const setResult = (nextStatus, nextReason = null) => {
    status = nextStatus
    if (nextReason !== null) reason = nextReason
  }

  try {
    // 1. Preflight ------------------------------------------------------------
    const before = await listProcs()
    preflightDecision = decidePreflight(before)
    const visible = before.filter((proc) => proc.hasWindow).length
    log.info('preflight', { decision: preflightDecision, processCount: before.length, visible })

    if (args.preflightOnly) {
      setResult('ok', `preflight:${preflightDecision}`)
    } else if (preflightDecision === 'skip-visible-window') {
      log.warn('skipping: an Edge window is visible; the scheduled task will retry')
      setResult('skipped-edge-busy', 'visible Edge window')
    } else {
      if (preflightDecision === 'kill-background') {
        log.info('killing background Edge', { count: before.length })
        await killAllEdge({ timeoutMs: 8000 })
      }

      // 2. Junction -----------------------------------------------------------
      const link = await ensureJunction({ linkPath: config.linkDir, targetPath: config.userDataDir })
      log.info('junction', { created: link.created, linkPath: link.linkPath })

      // 3. Launch -------------------------------------------------------------
      const port = args.port ?? config.port
      if (await isPortOpen(port)) throw new Error(`port ${port} already serves a CDP endpoint`)
      if (!existsSync(config.edgeExe)) throw new Error(`Edge not found: ${config.edgeExe}`)
      const launched = launch({
        exePath: config.edgeExe,
        userDataDir: config.linkDir,
        port,
        width: config.windowWidth,
        height: config.windowHeight,
        startUrl: 'about:blank',
      })
      edgeLaunched = true
      edgePid = launched.pid
      log.info('edge launched', { pid: edgePid, port })
      if (config.startDelayMs) await sleeper(config.startDelayMs)

      const portInfo = await waitForDebugPort({
        port,
        portRange: config.portRange,
        timeoutMs: config.debugPortTimeoutMs,
      })
      log.info('debug port ready', { port: portInfo.port, browser: portInfo.info?.Browser ?? null })

      // 4. Attach -------------------------------------------------------------
      cdp = await makeCdp(portInfo.webSocketDebuggerUrl, { timeoutMs: config.debugPortTimeoutMs })
      const target = await findPageTarget(portInfo.port)
      const sid = await attach(cdp, target.targetId)
      await cdp.send('Page.enable', {}, sid)
      if (config.focusEmulation) {
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid)
      }
      if (config.minimize) {
        try {
          const { windowId } = await cdp.send('Browser.getWindowForTarget', {}, sid)
          await cdp.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'minimized' },
          })
          log.info('window minimized', { windowId })
        } catch (error) {
          // Not fatal: the searches below still work in a visible window.
          log.warn('could not minimize window', { message: error.message })
        }
      }

      // 5. Baseline -----------------------------------------------------------
      await cdp.send('Page.navigate', { url: config.homeUrl }, sid, { timeoutMs: 30000 })
      await sleeper(1500)
      preState = await readStatusWithRetry({
        read: () => readStatus({ cdp, sid }),
        sleep: sleeper,
        onRetry: (attempt, error) =>
          log.warn('status not ready yet', { attempt, message: error.message }),
      })
      postState = preState
      log.info('status', { stage: 'pre', text: describeState(preState), ...preState })

      if (!preState.isRewardsUser) {
        setResult('not-signed-in', 'userInfo.isRewardsUser is false')
      } else if (isFull(preState) && !args.force) {
        log.info('already full', { progress: preState.pcSearch })
        setResult('already-full')
      } else {
        // 6. Search loop ------------------------------------------------------
        const needed = searchRemaining(preState)
        const planned = args.force
          ? Math.min(config.maxSearchesPerRun, 3)
          : Math.min(config.maxSearchesPerRun, Math.max(1, Math.ceil(needed / 3)))
        const queries = pickQueries(planned)
        log.info('search plan', { needed, planned, queries })

        let failures = 0
        let halted = false
        for (const query of queries) {
          if (Date.now() - startedAt > config.maxRuntimeMs) {
            log.warn('runtime budget exhausted', { budgetMs: config.maxRuntimeMs })
            break
          }
          if (isFull(postState) && !args.force) break
          searches += 1

          let attempt = null
          try {
            attempt = await searchOnce({ cdp, sid, query, config, sleep: sleeper, log })
          } catch (error) {
            failures += 1
            log.error('search failed', { query, message: error.message, failures })
            if (failures >= config.maxFailures) {
              halted = true
              break
            }
            continue
          }
          if (!attempt.typed || attempt.resultCount === 0) {
            failures += 1
            log.warn('search did not land', {
              query,
              typed: attempt.typed,
              results: attempt.resultCount,
            })
            if (failures >= config.maxFailures) {
              halted = true
              break
            }
            continue
          }

          const previous = postState
          try {
            postState = await readStatusWithRetry({
              read: () => readStatus({ cdp, sid }),
              attempts: 2,
              delayMs: 1000,
              sleep: sleeper,
            })
          } catch (error) {
            failures += 1
            log.error('status read failed after search', { message: error.message })
            if (failures >= config.maxFailures) {
              halted = true
              break
            }
            continue
          }

          const gained = (postState.pcSearch?.progress ?? 0) - (previous?.pcSearch?.progress ?? 0)
          log.info('search result', {
            query,
            gained,
            progress: postState.pcSearch,
            balance: postState.balance,
          })
          // A zero gain at the cap is the expected outcome, not a failure: the
          // daily maximum is simply already banked (this is what --force hits).
          if (countsAsCreditingFailure(gained, isFull(postState))) {
            failures += 1
            // Two searches that add nothing means the backend is not crediting
            // this session at all; more searches will not change that.
            if (failures >= config.maxFailures) {
              setResult('no-progress', `${failures} consecutive searches added no points`)
              halted = true
              break
            }
          } else {
            failures = 0
          }
          await sleeper(rngMs(800, 2200))
        }

        if (!halted) {
          if (isFull(postState)) setResult('ok')
          else setResult('ok', 'search budget used without reaching the daily maximum')
        }
      }
    }
  } catch (error) {
    reason = reason ?? error.message
    log.error('run failed', { message: error.message, stack: error.stack })
    if (status !== 'not-signed-in' && status !== 'no-progress') setResult('failed', error.message)
  }

  // 7. Teardown (single exit path) --------------------------------------------
  if (edgeLaunched) {
    try {
      const closed = await closeEdge({ cdp, pid: edgePid, timeoutMs: config.closeTimeoutMs })
      log.info('edge closed', { result: closed.status })
      if (closed.status === 'edge-left-running' && SUCCESS_STATUS.has(status)) {
        setResult('edge-left-running', 'Edge still has a visible window; left it open')
      } else if (closed.status === 'closed-with-extra-targets' && status === 'ok') {
        setResult('closed-with-extra-targets', 'extra Edge targets were open and were closed too')
      }
    } catch (error) {
      log.error('close failed', { message: error.message })
      if (SUCCESS_STATUS.has(status)) setResult('failed', `close failed: ${error.message}`)
    }
  }
  if (cdp) {
    try {
      cdp.close()
    } catch {
      /* ignore */
    }
  }

  const summary = summaryRecord({
    status,
    reason,
    preBalance: preState?.balance ?? null,
    postBalance: postState?.balance ?? null,
    preProgress: preState?.pcSearch?.progress ?? null,
    postProgress: postState?.pcSearch?.progress ?? null,
    searches,
    durationMs: Date.now() - startedAt,
    extra: preflightDecision ? { preflight: preflightDecision } : null,
  })
  log.write(summary)
  log.close()
  echo(
    `done: ${status} searches=${searches} points ${summary.preBalance}->${summary.postBalance} ` +
      `progress ${summary.preProgress}->${summary.postProgress}`,
  )

  return { status, exitCode: SUCCESS_STATUS.has(status) ? 0 : 1, summary, preflight: preflightDecision }
}

/** CLI wrapper: prints a one-line result and sets the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const result = await run({ argv })
  const summary = result.summary ?? {}
  const line =
    `status=${result.status} searches=${summary.searches ?? 0} ` +
    `points=${summary.preBalance ?? '?'}->${summary.postBalance ?? '?'} ` +
    `progress=${summary.preProgress ?? '?'}->${summary.postProgress ?? '?'}`
  if (result.exitCode === 0) process.stdout.write(line + '\n')
  else process.stderr.write(`${line} reason=${summary.reason ?? 'unknown'}\n`)
  return result.exitCode
}

if (process.argv[1] && process.argv[1].endsWith('run.mjs')) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`fatal: ${error.message}\n`)
      process.exitCode = 1
    },
  )
}
