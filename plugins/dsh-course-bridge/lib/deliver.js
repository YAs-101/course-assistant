/**
 * dsh-course-bridge: delivering one course note into a fresh DSH session.
 *
 * The note is built in three layers, most valuable first:
 *
 *  1. a summary written from real material (description, subtitle, danmaku,
 *     comments) collected by lib/bili.js and condensed by lib/summarize.js;
 *  2. the section dsh-video-coursemap wrote for this video -- clearly labelled
 *     as an unreviewed first draft, because it was produced from the title
 *     alone and may invent its "discussion" claims;
 *  3. the raw quotes, so a reader can check (1) against the source.
 *
 * The delivery itself is host-service only -- no HTTP, no RPC:
 *
 *   sessionController.create   -> a new ordinary Session in deliverCwd
 *   fileUploads.uploadStream   -> the .docx becomes a staged attachment
 *   sessionController.prompt   -> a user message carrying the attachment
 *   sessionController.rename   -> a readable title
 *   sessions.flush             -> the transcript is durable on disk
 *
 * Every service is fetched with ctx.get(name) at call time. A missing service
 * surfaces as a normal thrown error so the caller can keep the note and retry
 * the delivery on a later scan.
 *
 * @module dsh-course-bridge/lib/deliver
 */
import { createReadStream, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { buildNoteMd, writeNoteDocx } from './docx.js'
import { extractSection } from './manual.js'
import { collectContent, describeContent } from './bili.js'
import { materialMarkdown, summarizeContent } from './summarize.js'

const EMPTY = String()

/** AbortSignal-like object for hosts whose prompt wrapper probes the signal. */
function inertSignal() {
  const controller = new AbortController()
  return controller.signal
}

/**
 * Fetch a required host service.
 * @param ctx - plugin context.
 * @param name - service name.
 */
export function requireService(ctx, name) {
  const service = ctx.get(name)
  if (service === undefined) throw new Error('required host service "' + name + '" is not mounted in this deployment')
  return service
}

/**
 * Give a freshly created delivery session the configured permission preset.
 *
 * A session created through the API starts on the deployment default, which in
 * a confined deployment can be unusable for the reading work we ask for (this
 * one refuses to grant a workspace ACL at all). Delegation uses the same three
 * session events to seed a child, so the pattern is the host's own.
 *
 * @param options - host services, target session, preset name, and logger.
 * @returns true when the preset was applied; false leaves the session default.
 */
export function applyPermissionPreset({ ctx, sessionId, name, log }) {
  if (!name) return false
  const presets = ctx.get('permissionPresets')
  if (!presets || typeof presets.resolve !== 'function') {
    if (log) log('权限预设 ' + name + ' 未生效：宿主没有 permissionPresets 服务，新会话沿用部署默认')
    return false
  }
  let spec
  try {
    spec = presets.resolve(name)
  } catch (error) {
    if (log) log('权限预设 ' + name + ' 未生效：' + String(error && error.message ? error.message : error))
    return false
  }
  const sessions = ctx.get('sessions')
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (!session || typeof session.append !== 'function') {
    if (log) log('权限预设 ' + name + ' 未生效：取不到会话 ' + sessionId + ' 的日志')
    return false
  }
  session.append('permission/preset', { preset: name })
  session.append('sandbox/mode', { mode: spec.sandbox, source: 'course-bridge' })
  session.append('approval/policy', { policy: spec.approval, source: 'course-bridge' })
  if (log) log('新会话 ' + sessionId + ' 的权限预设设为 ' + name + '（' + spec.sandbox + ' / ' + spec.approval + '）')
  return true
}

/** Human label for where the note body came from. */
export function sourceLabel(source) {
  if (source === 'llm') return '视频简介/字幕/弹幕/评论 + 模型总结'
  if (source === 'fallback') return '视频简介/弹幕/评论（原文）'
  return '课程知识地图（标题推断，未经素材核对）'
}

/**
 * Build the prompt text that accompanies the Word document.
 *
 * The wording asks the reader to verify rather than paraphrase, because the
 * material in the note is quoted and the summary on top of it is derived.
 *
 * @param video - subject and title of the detected video.
 * @param info - optional provenance: summary source and whether material was incomplete.
 */
export function promptText(video, info = {}) {
  const lines = []
  lines.push('【课程笔记已生成】')
  lines.push('学科：' + video.subject)
  lines.push('视频：' + video.title)
  const quality = []
  if (info.source) quality.push('总结来源：' + sourceLabel(info.source))
  if (info.incomplete) quality.push('注意：部分素材抓取失败，笔记已标注')
  if (quality.length > 0) lines.push(quality.join(' · '))
  lines.push(EMPTY)
  lines.push('附件是本视频的知识笔记 Word 文档，其中「知识总结」来自真实的简介/弹幕/评论，文末附了可核对的原始素材。')
  lines.push('请你通读附件，然后在当前会话里输出一份更凝练的学习总结：')
  lines.push('1. 用 3~5 条结论写出这个视频最值得记住的东西，优先用观众的真实反应佐证；')
  lines.push('2. 指出弹幕与评论区反映出的争议点或易错点，有分歧时写清双方观点；')
  lines.push('3. 给出一个可以立刻动手的练习或下一步学习建议。')
  lines.push('只写附件里有的内容，不要补充附件没有的知识。直接输出正文。')
  return lines.join(String.fromCharCode(10))
}

/**
 * Compose the section list of one note.
 *
 * @param options - manual section, summary result, and whether to include the draft.
 * @returns the ordered blocks handed to buildNoteMd.
 */
export function noteSections({ section, summary, includeManual = true, degraded = false }) {
  const blocks = []
  if (summary && summary.ok === true && summary.markdown.trim() !== EMPTY) {
    blocks.push({ heading: '知识总结（基于真实素材）', body: summary.markdown })
  }
  if (includeManual && !degraded && section.trim() !== EMPTY) {
    blocks.push({
      heading: '课程知识地图初稿（仅由标题推断，未经素材核对）',
      body: section,
    })
  }
  if (blocks.length === 0) {
    blocks.push({ heading: EMPTY, body: section })
  }
  return blocks
}

/**
 * Collect material and summarise it, degrading instead of failing.
 *
 * A note without Grounding is still worth delivering, so every failure here is
 * returned as a diagnostic rather than thrown.
 *
 * @param options - context, video, and the plugin config.
 * @returns "{ summary, content }" where either may be null.
 */
export async function groundNote({ ctx, video, config, log }) {
  if (config.fetchContent === false) return { summary: null, content: null }
  let content = null
  try {
    content = await collectContent(video.title, {
      threshold: config.matchThreshold,
      maxQueries: config.maxQueries,
      log,
    })
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    if (log) log('抓取 B 站素材失败（笔记将退回知识地图初稿）：' + reason)
    return { summary: null, content: null }
  }
  if (log) log('B 站素材：' + describeContent(content))
  if (!content || content.ok !== true) return { summary: null, content }
  if (config.summarize === false) {
    const markdown = materialMarkdown(content)
    if (markdown.trim() === EMPTY) return { summary: null, content }
    return { summary: { ok: true, source: 'fallback', markdown, message: 'summarisation disabled', incomplete: false }, content }
  }
  let summary = null
  try {
    summary = await summarizeContent({
      ctx,
      content,
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      log,
    })
  } catch (error) {
    const reason = String(error && error.message ? error.message : error)
    if (log) log('生成总结失败（笔记将退回素材原文）：' + reason)
  }
  return { summary, content }
}

/**
 * Deliver one note; the caller owns ledger bookkeeping.
 *
 * The expensive halves are separated so a retry after a presentation failure
 * reuses the already-converted .docx instead of paying for another collection,
 * another model call, and another Markdown conversion.
 *
 * @param options - plugin context, config, video, manual text, ledger record.
 * @returns outcome flags plus the session identity and the note path.
 */
export async function deliverOne({ ctx, config, video, manualText, previous, log }) {
  const ledgerRecord = previous && typeof previous === 'object' ? previous : {}
  const located = extractSection(manualText, video.title)
  const degraded = !located.found

  let docxPath = typeof ledgerRecord.docxPath === 'string' ? ledgerRecord.docxPath : EMPTY
  let summarySource = typeof ledgerRecord.summarySource === 'string' ? ledgerRecord.summarySource : EMPTY
  let incomplete = false

  if (docxPath === EMPTY || !existsSync(docxPath)) {
    const grounded = await groundNote({ ctx, video, config, log })
    const summary = grounded.summary
    if (summary && typeof summary.incomplete === 'boolean') incomplete = summary.incomplete
    if (summary && typeof summary.source === 'string') summarySource = summary.source
    const section = degraded ? manualText : located.section
    const md = buildNoteMd({
      subject: video.subject,
      title: video.title,
      sections: noteSections({ section, summary, includeManual: config.includeManualSection !== false, degraded }),
      section,
      source: sourceLabel(summarySource),
      degraded,
    })
    const converted = writeNoteDocx({
      notesDir: config.notesDir,
      baseName: config.noteBaseName(video),
      md,
      pythonPath: config.pythonPath,
      scriptPath: config.scriptPath,
    })
    if (!converted.ok) {
      return { ok: false, step: 'convert', message: converted.message, docxPath: EMPTY, sessionId: EMPTY, degraded, summarySource }
    }
    docxPath = converted.docxPath
    if (log) {
      const notes = []
      if (degraded) notes.push('降级：未定位到独立小节，使用整份手册')
      if (summarySource !== 'llm') notes.push('素材未取到真实弹幕/评论，笔记以原文为准')
      log('笔记已生成：' + docxPath + (notes.length > 0 ? '（' + notes.join('；') + '）' : EMPTY))
    }
  }

  const sessionController = requireService(ctx, 'sessionController')
  const fileUploads = requireService(ctx, 'fileUploads')

  let sessionId = typeof ledgerRecord.sessionId === 'string' ? ledgerRecord.sessionId : EMPTY
  if (sessionId === EMPTY) {
    const created = await sessionController.create(config.createRequest())
    sessionId = created.sessionId
    if (log) log('已新建会话：' + sessionId)
    // Only on creation: re-appending on every retry would pile up session events.
    applyPermissionPreset({ ctx, sessionId, name: config.sessionPermissionPreset, log })
  }

  const uploaded = await fileUploads.uploadStream({
    sessionId,
    data: createReadStream(docxPath),
    name: basename(docxPath),
  })
  if (!uploaded || typeof uploaded.receiptId !== 'string') {
    return { ok: false, step: 'upload', message: 'fileUploads.uploadStream returned no receiptId', docxPath, sessionId, degraded, summarySource }
  }

  const requestId = typeof ledgerRecord.requestId === 'string' && ledgerRecord.requestId !== EMPTY ? ledgerRecord.requestId : randomUUID()
  await sessionController.prompt(
    {
      sessionId,
      requestId,
      content: [
        { type: 'file', receiptId: uploaded.receiptId },
        { type: 'text', text: promptText(video, { source: summarySource, incomplete }) },
      ],
    },
    inertSignal(),
  )

  let title = EMPTY
  try {
    const renamed = await sessionController.rename({ sessionId, title: config.sessionTitleFor(video) })
    title = renamed && typeof renamed.title === 'string' ? renamed.title : EMPTY
  } catch (error) {
    if (log) log('会话已投递但改标题失败（不影响笔记）：' + String(error && error.message ? error.message : error))
  }

  try {
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (session !== undefined) await sessions.flush(session)
  } catch (error) {
    if (log) log('会话已投递但落盘 flush 失败（不影响笔记）：' + String(error && error.message ? error.message : error))
  }

  return { ok: true, step: 'done', message: 'delivered into ' + sessionId, docxPath, sessionId, degraded, requestId, title, summarySource }
}
