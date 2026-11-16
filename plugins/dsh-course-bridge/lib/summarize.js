/**
 * dsh-course-bridge: grounding one note in real video material.
 *
 * dsh-video-coursemap writes its section from the video title alone, so the
 * "弹幕与评论讨论焦点" part of its manual is invented whenever the content
 * fetch failed. The bridge therefore collects the real material itself (see
 * lib/bili.js) and re-summarises it here, and it always appends the raw
 * evidence as an appendix: even when the model is unavailable the note still
 * carries verifiable quotes instead of plausible fiction.
 *
 * Output Markdown stays inside the subset scripts/md2docx.py renders:
 * H1/H2/H3 headings, "- " bullets, "> " quotes, fenced blocks, bold/italic.
 * No tables, links, images, or numbered lists.
 *
 * @module dsh-course-bridge/lib/summarize
 */
import { randomUUID } from 'node:crypto'

const DEFAULT_LLM_TIMEOUT_MS = 180000

/** System prompt for the grounded summary. */
export const NOTE_SYSTEM = [
  '你是一位严谨的课程笔记整理师。用户会给你一个 B 站视频的真实素材：',
  '简介、字幕、弹幕精选、热门评论。',
  '你的唯一任务是把这些真实素材压缩成一份可复习的知识笔记。',
  '',
  '硬性要求：',
  '1. 只能使用素材中出现的信息；素材没提到的内容一律不写，绝不补充你认为应该有的知识。',
  '2. 每条结论都要能追溯到素材；引用原话时用 > 引用块，并尽量保留原样。',
  '3. 弹幕和评论是观众的真实反应，要如实归纳观众关注什么、在哪里有分歧，不要美化。',
  '4. 素材稀少时就把笔记写短，并用一句话说明素材不足，不要凑字数。',
  '',
  '输出格式（严格遵守，只输出正文）：',
  '### 视频讲了什么',
  '- 用 2~4 条概括内容主线',
  '### 核心知识点',
  '- 3~6 条，每条以加粗短语开头，后面跟一句解释',
  '### 观众在讨论什么',
  '- 从弹幕与评论归纳 2~4 条，标注这是观众观点；有争议时明确指出分歧双方',
  '### 可以马上做的事',
  '- 1~3 条可执行的练习或下一步学习建议',
  '',
  '不要输出表格、链接、图片、编号列表；不要整段复述素材原文。',
].join(String.fromCharCode(10))

const NL = String.fromCharCode(10)
const EMPTY = String()

/**
 * Describe one collected content blob for the model.
 *
 * Long fields are truncated field by field rather than as a whole, so a video
 * with a huge danmaku stream still contributes its description and comments.
 *
 * @param content - result of collectContent.
 * @param options - per-field caps.
 */
export function materialPrompt(content, { descLimit = 1200, transcriptLimit = 6000, danmakuLimit = 80, commentsLimit = 25 } = {}) {
  const lines = []
  lines.push('视频标题：' + String(content.matchedTitle || EMPTY))
  if (content.owner) lines.push('UP 主：' + content.owner)
  if (content.bvid) lines.push('BV 号：' + content.bvid)
  const stat = content.stat || {}
  const plays = Number(stat.view || 0)
  if (plays > 0) lines.push('播放量：' + String(plays))
  lines.push(EMPTY)
  lines.push('## 视频简介')
  const desc = String(content.desc || EMPTY).trim()
  lines.push(desc === EMPTY ? '（简介为空）' : desc.slice(0, descLimit))
  const transcript = String(content.transcript || EMPTY).trim()
  if (transcript !== EMPTY) {
    lines.push(EMPTY)
    lines.push('## 字幕（节选）')
    lines.push(transcript.slice(0, transcriptLimit))
  }
  const danmaku = Array.isArray(content.danmaku) ? content.danmaku.slice(0, danmakuLimit) : []
  lines.push(EMPTY)
  lines.push('## 弹幕（共 ' + String(content.danmakuTotal || 0) + ' 条，以下是随机节选）')
  if (danmaku.length === 0) {
    lines.push('（没有取到弹幕）')
  } else {
    for (const item of danmaku) lines.push('- ' + item)
  }
  const comments = Array.isArray(content.comments) ? content.comments.slice(0, commentsLimit) : []
  lines.push(EMPTY)
  lines.push('## 热门评论（按点赞排序）')
  if (comments.length === 0) {
    lines.push('（没有取到评论）')
  } else {
    for (const item of comments) lines.push('- [' + String(item.likes) + ' 赞] ' + item.message)
  }
  return lines.join(NL)
}

/**
 * Deterministic appendix holding the raw material behind the summary.
 *
 * This is the part a reader can verify: quotes are shown verbatim, so an
 * incorrect paraphrase above it is detectable.
 *
 * @param content - result of collectContent.
 * @param options - how many quotes to keep.
 * @returns Markdown, or an empty string when there is nothing to show.
 */
export function materialMarkdown(content, { danmakuLimit = 20, commentsLimit = 10 } = {}) {
  if (!content || content.ok !== true) return EMPTY
  const lines = []
  const desc = String(content.desc || EMPTY).trim()
  if (desc !== EMPTY) {
    lines.push('### 视频简介')
    for (const sentence of desc.split(/\n+/)) {
      const value = sentence.trim()
      if (value !== EMPTY) lines.push('> ' + value)
    }
  }
  const danmaku = Array.isArray(content.danmaku) ? content.danmaku.slice(0, danmakuLimit) : []
  if (danmaku.length > 0) {
    lines.push(EMPTY)
    lines.push('### 弹幕节选（共 ' + String(content.danmakuTotal || 0) + ' 条）')
    for (const item of danmaku) lines.push('- ' + item)
  }
  const comments = Array.isArray(content.comments) ? content.comments.slice(0, commentsLimit) : []
  if (comments.length > 0) {
    lines.push(EMPTY)
    lines.push('### 热门评论')
    for (const item of comments) lines.push('- ' + item.message + '（' + String(item.likes) + ' 赞）')
  }
  return lines.join(NL)
}

/**
 * Resolve the provider/model to summarise with.
 *
 * Order matches dsh-video-coursemap: explicit configuration, then the agent
 * default selection, then the first registered provider.
 *
 * @param ctx - plugin context.
 * @param config - optional explicit provider/model.
 * @returns "{ provider, model }" or null when nothing is registered.
 */
export function resolveModel(ctx, config = {}) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  try {
    const selection = ctx.get ? ctx.get('agentDefaultModel') : undefined
    const value = selection && typeof selection.currentSelection === 'function' ? selection.currentSelection() : null
    if (value && typeof value.provider === 'string' && typeof value.model === 'string') {
      return { provider: value.provider, model: value.model }
    }
  } catch {
    /* the default selection is optional */
  }
  try {
    const llm = ctx.get ? ctx.get('llm') : undefined
    const providers = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : []
    for (const provider of providers) {
      const models = Array.isArray(provider.models) ? provider.models : []
      const modelId = models[0] && models[0].id ? models[0].id : provider.defaultModel || provider.model
      if (provider.id && modelId) return { provider: provider.id, model: modelId }
    }
  } catch {
    /* no provider registry is not fatal: the caller falls back */
  }
  return null
}

/**
 * Stream one completion and return its text.
 *
 * @param options - context, model, system prompt, user message, caps.
 * @returns the assistant text.
 */
export async function callLlm(ctx, { provider, model, system, text, maxTokens = 3000, timeoutMs = DEFAULT_LLM_TIMEOUT_MS }) {
  const llm = ctx.get ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') throw new Error('the llm service is not mounted')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('the summary request timed out')), timeoutMs)
  try {
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', id: randomUUID(), content: [{ type: 'text', text }] }],
      maxTokens,
      signal: controller.signal,
    })
    let output = EMPTY
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') output += chunk.text
    }
    return output
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turn collected material into the body of one note.
 *
 * The model writes the summary; the raw quotes are appended unconditionally.
 * When the model is unavailable the deterministic material is returned alone,
 * flagged with source "fallback" so the caller can say so in the note.
 *
 * @param options - context, collected content, and model overrides.
 * @returns markdown body plus provenance.
 */
export async function summarizeContent({ ctx, content, provider, model, maxTokens = 3000, log, danmakuLimit = 20, commentsLimit = 10 }) {
  const appendix = materialMarkdown(content, { danmakuLimit, commentsLimit })
  const parts = []
  let source = 'fallback'
  let message = EMPTY
  if (content && content.ok === true) {
    const resolved = provider && model ? { provider, model } : resolveModel(ctx, {})
    if (resolved === null) {
      message = 'no llm provider is available; the note keeps the raw material only'
    } else {
      try {
        const prompt = materialPrompt(content)
        const text = await callLlm(ctx, {
          provider: resolved.provider,
          model: resolved.model,
          system: NOTE_SYSTEM,
          text: prompt,
          maxTokens,
        })
        const trimmed = String(text || EMPTY).trim()
        if (trimmed !== EMPTY) {
          parts.push(trimmed)
          source = 'llm'
          if (log) log('已用 ' + resolved.provider + '/' + resolved.model + ' 生成基于真实素材的总结')
        } else {
          message = 'the model returned no text'
        }
      } catch (error) {
        message = 'the summary model failed: ' + String(error && error.message ? error.message : error)
      }
    }
  } else {
    message = 'no bilibili content was collected: ' + (content && content.reason ? content.reason : 'not attempted')
  }
  if (appendix !== EMPTY) {
    parts.push(EMPTY)
    parts.push('### 原始素材（可核对）')
    parts.push(appendix)
  }
  if (parts.length === 0) {
    return { ok: false, source: 'none', markdown: EMPTY, message: message || 'nothing to summarise' }
  }
  const incomplete = !content || content.ok !== true || (Array.isArray(content.errors) && content.errors.length > 0)
  return { ok: true, source, markdown: parts.join(NL), message, incomplete }
}
