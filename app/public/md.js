/**
 * Minimal markdown renderer, deliberately hand-written.
 *
 * The app must run from a folder copy with no `npm install`, so pulling in
 * marked/markdown-it is not an option. Only the constructs the knowledge map
 * actually emits are supported: headings, bold/italic/inline code, links, nested
 * lists, blockquotes, fenced code and horizontal rules.
 *
 * Everything is HTML-escaped first, so note content can never inject markup.
 */

/**
 * Escape the five characters that could break out of HTML text.
 *
 * @param value - any value.
 * @returns escaped string.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Escape, then apply the inline markdown rules.
 *
 * Order matters: code spans are protected first so `**` inside them survives.
 *
 * @param text - raw inline text.
 * @returns HTML string.
 */
export function inline(text) {
  const codes = []
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
  out = out.replace(/\u0000(\d+)\u0000/g, (_, idx) => `<code>${codes[Number(idx)]}</code>`)
  return out
}

/**
 * Render a nested list from indented markdown bullets.
 *
 * @param items - `[{ level, text }]`.
 * @returns HTML string.
 */
function renderList(items) {
  const out = []
  // `depth` counts the currently open <ul> elements. The first item always opens
  // one — without that the shallowest level would emit bare <li> elements, which
  // browsers silently drop out of the list.
  let depth = 0
  for (const item of items) {
    // An indent jump of more than one level cannot be represented in nested
    // <ul>s without empty lists in between, so clamp to one deeper than now.
    const level = Math.max(0, Math.min(item.level, depth))
    while (depth < level + 1) {
      out.push('<ul>')
      depth += 1
    }
    while (depth > level + 1) {
      out.push('</ul>')
      depth -= 1
    }
    out.push(`<li>${inline(item.text)}</li>`)
  }
  while (depth > 0) {
    out.push('</ul>')
    depth -= 1
  }
  return out.join('')
}

/**
 * Turn a markdown string into HTML.
 *
 * @param markdown - raw markdown.
 * @returns HTML string.
 */
export function renderMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // Fenced code: consume until the closing fence, and let a mermaid block keep
    // its source in a labeled box instead of pretending to render it.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] || 'text'
      const body = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      const label = lang === 'mermaid' ? '思维导图源码' : lang
      out.push(`<pre class="code" data-lang="${escapeHtml(label)}"><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const depth = Math.min(6, heading[1].length + 1)
      out.push(`<h${depth}>${inline(heading[2])}</h${depth}>`)
      i += 1
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr>')
      i += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const quote = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`)
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/\t/g, '    ')
        const indent = raw.match(/^\s*/)?.[0].length ?? 0
        items.push({ level: indent >= 4 ? 2 : indent >= 2 ? 1 : 0, text: raw.replace(/^\s*[-*+]\s+/, '').trim() })
        i += 1
      }
      out.push(renderList(items))
      continue
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, '').trim())}</li>`)
        i += 1
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Paragraph: gather consecutive plain lines.
    const paragraph = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^```/.test(lines[i])
    ) {
      paragraph.push(lines[i])
      i += 1
    }
    out.push(`<p>${inline(paragraph.join(' '))}</p>`)
  }
  return out.join('\n')
}

/**
 * Render a nested `{ text, children }` tree as collapsible items.
 *
 * Used for both the knowledge-point outline and the mermaid mind map, which after
 * parsing have the same shape.
 *
 * @param nodes - array of `{ text, children }`.
 * @param options - `depth` for recursion, `collapse` to start collapsed.
 * @returns HTML string.
 */
export function renderTree(nodes, { depth = 0, collapse = false } = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  if (!list.length) return ''
  const items = list.map((node) => {
    const children = Array.isArray(node.children) ? node.children : []
    const label = inline(node.text)
    const body = children.length ? renderTree(children, { depth: depth + 1, collapse }) : ''
    if (depth === 0 && children.length) {
      return `<li class="tree-root"><details${collapse ? '' : ' open'}><summary>${label}</summary>${body}</details></li>`
    }
    if (children.length) return `<li><div class="tree-label">${label}</div>${body}</li>`
    return `<li><span class="tree-leaf">${label}</span></li>`
  })
  return `<ul class="tree depth-${depth}">${items.join('')}</ul>`
}

/**
 * Render a flat mind-map node layout (children as pills) for the overview.
 *
 * @param nodes - roots from the parser.
 * @returns HTML string.
 */
export function renderMindmap(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  if (!list.length) return '<div class="empty">暂无思维导图</div>'
  return list
    .map((root) => {
      const kids = Array.isArray(root.children) ? root.children : []
      return `<div class="mind-root"><div class="mind-node root">${inline(root.text)}</div>
        <div class="mind-kids">${kids
          .map((kid) => {
            const grand = Array.isArray(kid.children) ? kid.children : []
            return `<div class="mind-branch"><div class="mind-node">${inline(kid.text)}</div>${
              grand.length ? `<div class="mind-grand">${grand.map((g) => `<span>${inline(g.text)}</span>`).join('')}</div>` : ''
            }</div>`
          })
          .join('')}</div></div>`
    })
    .join('')
}

/**
 * Strip markdown to plain text (for titles in lists and toasts).
 *
 * @param markdown - any markdown.
 * @param maxLen - truncation length.
 * @returns plain text.
 */
export function plain(markdown, maxLen = 120) {
  const text = String(markdown ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text
}
