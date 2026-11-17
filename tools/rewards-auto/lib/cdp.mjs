/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Node 22+ ships a global `WebSocket`, so this needs no dependency -- which
 * matters because the repository has always claimed zero third-party packages.
 *
 * Only what the runner uses is exposed: `send` with a session id, `evaluate`
 * for page JS, and an `onClose` hook so the caller can tell a clean
 * `Browser.close` from a browser that died on its own.
 */

/** Error thrown when the CDP socket reports a protocol-level failure. */
export class CdpError extends Error {
  constructor(message, { method, code, data } = {}) {
    super(message)
    this.name = 'CdpError'
    this.method = method ?? null
    this.code = code ?? null
    this.data = data ?? null
  }
}

/**
 * Open a CDP connection to a browser websocket URL.
 *
 * The protocol is flat-session style: every message carries an optional
 * `sessionId`, and replies come back with the same id. Requests are matched by
 * a monotonically increasing `id`.
 *
 * @param url - the `webSocketDebuggerUrl` from `/json/version`.
 * @param options - `timeoutMs` bounds a single call; `onClose` is notified once.
 * @returns a client with `send`, `evaluate`, `close`.
 */
export async function connect(url, { timeoutMs = 30000, onClose } = {}) {
  if (!url) throw new CdpError('connect: url is required')
  const ws = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  let closedReason = null
  const listeners = new Set()

  const failAll = (reason) => {
    closedReason = reason
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new CdpError(`connection closed: ${reason}`, { method: entry.method }))
    }
    pending.clear()
    for (const fn of listeners) {
      try {
        fn(reason)
      } catch {
        /* a listener must not break teardown */
      }
    }
    listeners.clear()
    if (typeof onClose === 'function') {
      try {
        onClose(reason)
      } catch {
        /* ignore */
      }
    }
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpError(`websocket open timed out after ${timeoutMs}ms`))
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', (event) => {
      clearTimeout(timer)
      const detail = event?.message || event?.error?.message || 'websocket error'
      reject(new CdpError(detail))
    })
  })

  ws.addEventListener('message', (event) => {
    let msg = null
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (msg.id === undefined) return // an event we did not subscribe to
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    if (msg.error) {
      entry.reject(
        new CdpError(`${entry.method}: ${msg.error.message ?? 'protocol error'}`, {
          method: entry.method,
          code: msg.error.code,
          data: msg.error.data,
        }),
      )
      return
    }
    entry.resolve(msg.result)
  })

  ws.addEventListener('close', () => failAll('websocket closed'))
  ws.addEventListener('error', () => failAll('websocket error'))

  /**
   * Send one CDP command and resolve with its result.
   *
   * `sessionId` routes the command to an attached target (flatten mode).
   */
  const send = (method, params = {}, sessionId, { timeoutMs: callTimeout = timeoutMs } = {}) => {
    if (closedReason) {
      return Promise.reject(new CdpError(`connection closed: ${closedReason}`, { method }))
    }
    const id = nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new CdpError(`${method}: timed out after ${callTimeout}ms`, { method }))
      }, callTimeout)
      pending.set(id, { resolve, reject, timer, method })
      try {
        ws.send(JSON.stringify(payload))
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError(`${method}: send failed: ${error.message}`, { method }))
      }
    })
  }

  /**
   * Evaluate an expression in a page and return its value by value.
   *
   * `awaitPromise` is on by default because every rewards call is an `await
   * fetch(...)`; `returnByValue` keeps the result JSON-serializable over the wire.
   */
  const evaluate = async (expression, sessionId, { awaitPromise = true } = {}) => {
    const result = await send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      sessionId,
      { timeoutMs: Math.max(timeoutMs, 30000) },
    )
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails
      const text =
        detail.exception?.description || detail.exception?.value || detail.text || 'evaluate failed'
      throw new CdpError(`evaluate: ${String(text).split('\n')[0]}`, { data: detail })
    }
    return result?.result?.value
  }

  return {
    send,
    evaluate,
    get closed() {
      return closedReason
    },
    /** Subscribe to close events; returns an unsubscribe function. */
    onClosed(fn) {
      if (typeof fn !== 'function') return () => {}
      if (closedReason) {
        fn(closedReason)
        return () => {}
      }
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /**
     * Close the socket from our side.
     *
     * `Browser.close` normally closes it first, so a late call is a no-op.
     */
    close() {
      if (closedReason) return
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      failAll('closed by client')
    },
  }
}
