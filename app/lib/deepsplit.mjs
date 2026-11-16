/**
 * Turn the generated markdown into presentation-ready structure.
 *
 * The plugin's output is already well shaped (`### 核心知识点` with nested
 * bullets, `### 弹幕与评论讨论焦点`, `### 思维导图` with a mermaid `mindmap`). The UI
 * could dump raw markdown, but reading a knowledge point is much nicer as a card,
 * and the mind map is much nicer as a real tree than as mermaid source. Both
 * conversions live here so they are testable without a browser.
 */

/** Section headings the generator emits, in order. */
export const KNOWN_SECTIONS = Object.freeze(['核心知识点', '弹幕与评论讨论焦点', '评论区讨论焦点', '思维导图', '要点'])

/**
 * Split one video section's markdown into its `###` blocks.
 *
 * @param markdown - section body (everything after the `## 标题` line).
 * @returns `{ intro, blocks: [{title, body}] }`.
 */
export function splitBlocks(markdown) {
  const src = String(markdown ?? '')
  const lines = src.split(/\r?\n/)
  const blocks = []
  const intro = []
  let current = null
  for (const line of lines) {
    const heading = /^###\s+(.+)$/.exec(line)
    if (heading) {
      if (current) blocks.push(current)
      current = { title: heading[1].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else intro.push(line)
  }
  if (current) blocks.push(current)
  return {
    intro: intro.join('\n').trim(),
    blocks: blocks.map((b) => ({ title: b.title, body: b.lines.join('\n').trim() })),
  }
}

/**
 * Parse a bullet list into a nesting-aware outline.
 *
 * The generator nests knowledge points with indented `-` bullets (2 or 4 spaces,
 * sometimes `*`). Tabs are treated as 4 spaces.
 *
 * @param body - markdown text containing bullets.
 * @returns array of `{ level, text }` in document order.
 */
export function parseBullets(body) {
  const out = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    // A tab counts as one nesting step (two spaces) rather than four: the notes
    // mix tab- and space-indented outlines, and expanding a tab to four spaces
    // would make every tabbed bullet skip a level.
    const m = /^([ \t]*)[-*+]\s+(.*)$/.exec(raw.replace(/\t/g, '  '))
    if (!m) continue
    const indent = m[1].length
    const level = Math.min(2, Math.floor(indent / 2))
    const text = m[2].trim()
    if (text) out.push({ level, text })
  }
  return out
}

/**
 * Build a tree from a flat bullet outline.
 *
 * @param bullets - output of parseBullets.
 * @returns array of `{ text, children }` roots.
 */
export function buildOutlineTree(bullets) {
  const roots = []
  const stack = []
  for (const bullet of Array.isArray(bullets) ? bullets : []) {
    const node = { text: bullet.text, children: [] }
    while (stack.length && stack[stack.length - 1].level >= bullet.level) stack.pop()
    if (!stack.length) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ level: bullet.level, node })
  }
  return roots
}

/**
 * Parse a mermaid `mindmap` block into a tree.
 *
 * The generated overview looks like:
 *
 *   ```mermaid
 *   mindmap
 *     root((课程知识地图))
 *       AI工具
 *       音乐鉴赏
 *   ```
 *
 * Indentation is the only structural signal, so the shallowest entry becomes the
 * root and everything deeper nests under it.
 *
 * @param text - markdown or a raw mindmap body.
 * @returns `{ root, nodes }` or null when no mindmap is present.
 */
export function parseMindmap(text) {
  const src = String(text ?? '')
  const fenced = /```mermaid\s*\n([\s\S]*?)```/.exec(src)
  // Without a fence, only accept text that actually declares `mindmap` on its own
  // line. Otherwise any prose passed in here (e.g. a subject overview that has no
  // diagram) would be silently rendered as a mind map of unrelated lines.
  if (!fenced && !/^\s*mindmap\s*$/m.test(src)) return null
  const body = fenced ? fenced[1] : src
  const lines = body.split(/\r?\n/).filter((line) => line.trim() && !/^\s*mindmap\s*$/.test(line))
  if (!lines.length) return null
  const items = []
  for (const line of lines) {
    const indent = (line.match(/^[ \t]*/)?.[0] ?? '').replace(/\t/g, '    ').length
    let label = line.trim()
    // `root((课程知识地图))` -> `课程知识地图`; `a[标签]` -> `标签`.
    const shape = /\(\("?([^")]*)"?\)\)/.exec(label)
    if (shape) label = shape[1]
    else {
      const bracket = /\["?([^"\]]*)"?\]/.exec(label)
      if (bracket) label = bracket[1]
      else label = label.replace(/^\(\("?|"\)\)$/g, '')
    }
    label = label.trim()
    if (!label) continue
    items.push({ indent, label })
  }
  if (!items.length) return null
  const roots = []
  const stack = []
  for (const item of items) {
    const node = { text: item.label, children: [] }
    while (stack.length && stack[stack.length - 1].indent >= item.indent) stack.pop()
    if (!stack.length) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ indent: item.indent, node })
  }
  return { root: roots[0] ?? null, nodes: roots }
}

/**
 * Build the structured view of one video's note.
 *
 * @param markdown - the `## <标题>` section body.
 * @param overview - the subject overview markdown (holds the mermaid block).
 * @returns `{ intro, knowledge: [{text,children}], knowledgeFlat, discussion, mindmap, sections }`.
 */
export function buildNoteView(markdown, overview = '') {
  const { intro, blocks } = splitBlocks(markdown)
  let knowledge = []
  let knowledgeFlat = []
  let discussion = ''
  let mindmap = null
  for (const block of blocks) {
    if (block.title.includes('核心知识点') || block.title.includes('要点')) {
      knowledgeFlat = parseBullets(block.body)
      knowledge = buildOutlineTree(knowledgeFlat)
    } else if (block.title.includes('弹幕') || block.title.includes('评论')) {
      discussion = block.body
    } else if (block.title.includes('思维导图')) {
      mindmap = parseMindmap(block.body)
    }
  }
  if (!mindmap) mindmap = parseMindmap(overview)
  return { intro, knowledge, knowledgeFlat, discussion, mindmap, sections: blocks }
}

/**
 * One-line summary of a note, for list rows.
 *
 * @param markdown - section body.
 * @param maxLen - truncation length.
 * @returns plain text.
 */
export function summarizeNote(markdown, maxLen = 90) {
  const src = String(markdown ?? '')
  const quote = /^>\s*(.+)$/m.exec(src)
  let text = quote ? quote[1] : ''
  if (!text) {
    // Fall back to the first piece of real prose. List markers are stripped
    // because a row showing "- 主题动机贯穿全曲" reads like a formatting bug, and
    // headings are skipped since they repeat the section title already on screen.
    const first = src
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#') && !line.startsWith('>'))
    text = first ? first.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '') : ''
  }
  text = text.replace(/[*`_]/g, '').trim()
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '…'
}

/**
 * Count knowledge points in a note (used for the "videos × points" stat).
 *
 * @param markdown - section body.
 * @returns number of top-level points.
 */
export function countPoints(markdown) {
  const { blocks } = splitBlocks(markdown)
  for (const block of blocks) {
    if (block.title.includes('核心知识点') || block.title.includes('要点')) return parseBullets(block.body).filter((b) => b.level === 0).length
  }
  return 0
}

/** System prompt for the optional "expand one knowledge point" call. */
export const EXPAND_SYSTEM = [
  '你是一位耐心的课程助教，负责把一个知识点讲透。',
  '只输出 Markdown 正文，不要输出 JSON、代码围栏或前后缀说明。',
  '结构固定为三段：',
  '### 一句话解释',
  '### 为什么重要',
  '### 怎么用（可执行示例）',
  '总长度 200–400 字，中文，避免套话与空泛形容词。',
].join('\n')

/**
 * Build the user prompt for expanding a knowledge point.
 *
 * @param options - title, point, section (surrounding context).
 * @returns prompt text.
 */
export function expandPrompt({ title, point, section = '', subject = '' }) {
  const parts = []
  if (subject) parts.push(`学科：${subject}`)
  if (title) parts.push(`视频标题：${title}`)
  parts.push(`需要讲透的知识点：${point}`)
  const context = String(section ?? '').trim()
  if (context) parts.push(`原笔记上下文（节选）：\n${context.slice(0, 2500)}`)
  parts.push('请按系统提示的三段结构输出。')
  return parts.join('\n\n')
}
