/**
 * Direct DeepSeek API access, so the app works with no DeepSeek Harness running.
 *
 * The coursemap engine only needs an async iterable of `{type:'text-delta'}`
 * chunks, so everything here funnels into `stream()` with that shape. The key is
 * read from the DSH credentials file on demand and is never logged or returned
 * by any endpoint -- `status()` only reports whether a key was found.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where DSH keeps its credentials on this machine. */
export const DEFAULT_CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')

/** Default endpoint and model. */
export const API_BASE = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-flash'

/** Models this account exposes (verified against GET /models). */
export const KNOWN_MODELS = Object.freeze(['deepseek-flash', 'deepseek-v4-pro'])

/**
 * Extract `DEEPSEEK_API_KEY` from the credentials YAML.
 *
 * A full YAML parser is deliberately avoided: the file is `refs:` plus a flat
 * map, and only one scalar is needed. Both quoted and bare forms are accepted.
 *
 * @param text - file content.
 * @returns the key, or null.
 */
export function extractApiKey(text) {
  const src = String(text ?? '')
  const re = /^\s*DEEPSEEK_API_KEY\s*:\s*(.*)$/m
  const m = re.exec(src)
  if (!m) return null
  let value = m[1].trim()
  if (!value) return null
  const quoted = /^(['"])(.*)\1$/.exec(value)
  if (quoted) value = quoted[2]
  value = value.replace(/\s+#.*$/, '').trim()
  if (!value || value === 'null' || value === '~') return null
  return value
}

/**
 * Load the API key from a file.
 *
 * @param file - credentials path (configurable so a different machine works).
 * @returns `{ key, file, reason }`; `key` is null when unavailable.
 */
export function loadApiKey(file = DEFAULT_CREDENTIALS) {
  const path = file || DEFAULT_CREDENTIALS
  if (!existsSync(path)) return { key: null, file: path, reason: '凭据文件不存在' }
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch (error) {
    return { key: null, file: path, reason: `读取凭据失败：${error?.message ?? error}` }
  }
  const key = extractApiKey(text)
  if (!key) return { key: null, file: path, reason: '凭据文件里没有 DEEPSEEK_API_KEY' }
  return { key, file: path, reason: null }
}

/**
 * Turn a fetch body of SSE lines into text deltas.
 *
 * Yields the same `{type:'text-delta', text}` shape the host LLM service uses, so
 * the coursemap engine and the bridge summarizer both accept it unchanged.
 *
 * @param stream - a ReadableStream of UTF-8 bytes.
 * @param signal - abort signal.
 * @yields delta chunks.
 */
export async function* readSse(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new Error('请求已取消')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json
        try { json = JSON.parse(payload) } catch { continue }
        const delta = json?.choices?.[0]?.delta
        const text = delta?.content
        if (typeof text === 'string' && text) yield { type: 'text-delta', text }
        else if (typeof json?.choices?.[0]?.message?.content === 'string' && json.choices[0].message.content) {
          // Non-streaming fallback shape, in case `stream` is ignored upstream.
          yield { type: 'text-delta', text: json.choices[0].message.content }
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

/**
 * Build an `llm` service object compatible with what the plugins expect.
 *
 * `stream()` is synchronous-but-iterable by contract (the caller does
 * `for await`), so it returns an async generator. `listProviders()` exists so the
 * plugins' model resolution short-circuits on our single configured model.
 *
 * @param options - getKey(), model, baseUrl, onNote().
 * @returns the forged service plus a `describe()` helper.
 */
export function createLlmService({ getKey, model = DEFAULT_MODEL, baseUrl = API_BASE, onNote = () => {} } = {}) {
  let lastError = null
  let lastCallAt = 0
  let calls = 0

  async function request({ system, messages, maxTokens, signal }) {
    const key = getKey()
    if (!key) throw new Error('没有可用的 DEEPSEEK_API_KEY')
    const body = {
      model,
      stream: true,
      max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : 4096,
      messages: [],
    }
    if (system) body.messages.push({ role: 'system', content: String(system) })
    for (const message of Array.isArray(messages) ? messages : []) {
      const content = Array.isArray(message?.content)
        ? message.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
        : String(message?.content ?? '')
      if (!content) continue
      body.messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
    }
    const response = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) {
      let detail = ''
      try { detail = (await response.text()).slice(0, 400) } catch { detail = '' }
      throw new Error(`DeepSeek API ${response.status}${detail ? '：' + detail : ''}`)
    }
    return response
  }

  const service = {
    /**
     * Stream one completion.
     *
     * @param requestOptions - provider/model/system/messages/maxTokens/signal.
     * @returns async iterable of text deltas.
     */
    stream(requestOptions = {}) {
      return (async function* run() {
        calls += 1
        lastCallAt = Date.now()
        try {
          const response = await request({ ...requestOptions, model: requestOptions.model || model })
          if (!response.body) throw new Error('DeepSeek API 返回了空响应体')
          yield* readSse(response.body, requestOptions.signal)
          lastError = null
        } catch (error) {
          lastError = `${error?.message ?? error}`.slice(0, 500)
          onNote(`LLM 调用失败：${lastError}`)
          throw error
        }
      })()
    },
    /** Providers are fake: one provider, one model, so model resolution is deterministic. */
    listProviders() {
      return [{ id: 'deepseek', name: 'DeepSeek', defaultModel: model, models: [{ id: model }] }]
    },
    /** Report the last failure without leaking the key. */
    describe() {
      return { model, baseUrl, calls, lastCallAt, lastError, keyFile: getKey() ? 'loaded' : 'missing' }
    },
  }
  return service
}

/**
 * Collect a whole completion into a string (small helper for one-shot prompts).
 *
 * @param service - an `llm` service from createLlmService.
 * @param options - prompt options.
 * @returns the assistant text.
 */
export async function collect(service, options) {
  let text = ''
  for await (const chunk of service.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/**
 * Quick liveness probe used by the status endpoint (cheap, cached by caller).
 *
 * @param key - API key.
 * @param baseUrl - endpoint base.
 * @returns `{ ok, reason }`.
 */
export async function probeApi(key, baseUrl = API_BASE) {
  if (!key) return { ok: false, reason: '缺少 API Key' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(baseUrl + '/models', {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    const data = await response.json().catch(() => null)
    const models = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : []
    return { ok: true, reason: null, models }
  } catch (error) {
    return { ok: false, reason: `${error?.message ?? error}`.slice(0, 200) }
  } finally {
    clearTimeout(timer)
  }
}
