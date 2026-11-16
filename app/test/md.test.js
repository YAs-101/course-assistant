/**
 * Tests for the hand-written markdown renderer.
 *
 * The security-facing assertion is the first one: everything is escaped before
 * any inline rule runs, so note text (which includes scraped Bilibili titles and
 * comment text) can never inject markup into the page.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { escapeHtml, inline, plain, renderMarkdown, renderMindmap, renderTree } from '../public/md.js'

describe('escapeHtml', () => {
  it('转义五个危险字符', () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })

  it('空值不崩溃', () => {
    assert.equal(escapeHtml(null), '')
    assert.equal(escapeHtml(undefined), '')
  })
})

describe('inline', () => {
  it('加粗与斜体', () => {
    assert.equal(inline('**重点**'), '<strong>重点</strong>')
    assert.equal(inline('*斜*'), '<em>斜</em>')
  })

  it('代码内的星号不被当作强调', () => {
    assert.equal(inline('`a**b**c`'), '<code>a**b**c</code>')
  })

  it('链接只允许 http(s)', () => {
    assert.match(inline('[名字](https://example.com/a)'), /<a href="https:\/\/example.com\/a"/)
    assert.doesNotMatch(inline('[坏](javascript:alert(1))'), /<a /)
  })

  it('HTML 注入被转义', () => {
    assert.equal(inline('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;')
  })

  it('多个代码片段各自还原', () => {
    assert.equal(inline('`a` 和 `b`'), '<code>a</code> 和 <code>b</code>')
  })
})

describe('renderMarkdown', () => {
  it('标题层级降一级（笔记从 ## 开始）', () => {
    assert.match(renderMarkdown('## 视频标题'), /<h3>视频标题<\/h3>/)
    assert.match(renderMarkdown('# 一级'), /<h2>一级<\/h2>/)
  })

  it('嵌套列表按缩进分层', () => {
    const html = renderMarkdown('- 一层\n  - 二层\n    - 三层')
    assert.equal((html.match(/<ul>/g) ?? []).length, 3)
    assert.equal((html.match(/<\/ul>/g) ?? []).length, 3)
  })

  it('引用块被包裹', () => {
    assert.match(renderMarkdown('> 一句话简介'), /<blockquote><p>一句话简介<\/p><\/blockquote>/)
  })

  it('围栏代码保留源码并标注语言', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    assert.match(html, /data-lang="js"/)
    assert.match(html, /const a = 1/)
  })

  it('mermaid 块标为思维导图源码', () => {
    const html = renderMarkdown('```mermaid\nmindmap\n  root((x))\n```')
    assert.match(html, /data-lang="思维导图源码"/)
  })

  it('分割线', () => {
    assert.match(renderMarkdown('---'), /<hr>/)
  })

  it('有序列表', () => {
    assert.match(renderMarkdown('1. 甲\n2. 乙'), /<ol><li>甲<\/li><li>乙<\/li><\/ol>/)
  })

  it('普通段落合并连续行', () => {
    assert.match(renderMarkdown('第一行\n第二行'), /<p>第一行 第二行<\/p>/)
  })

  it('空输入返回空串', () => {
    assert.equal(renderMarkdown(''), '')
    assert.equal(renderMarkdown(null), '')
  })

  it('容忍未闭合的围栏代码', () => {
    assert.match(renderMarkdown('```js\nconst a = 1'), /const a = 1/)
  })

  it('CRLF 输入正常处理', () => {
    assert.match(renderMarkdown('## 标题\r\n内容'), /<h3>标题<\/h3>/)
  })
})

describe('renderTree', () => {
  const nodes = [{ text: '根', children: [{ text: '子', children: [{ text: '孙' }] }] }]

  it('根节点可折叠', () => {
    const html = renderTree(nodes)
    assert.match(html, /<details open>/)
    assert.match(html, /<summary>根<\/summary>/)
  })

  it('collapse 时默认收起', () => {
    assert.doesNotMatch(renderTree(nodes, { collapse: true }), /<details open>/)
  })

  it('叶子用 span 不用 details', () => {
    assert.match(renderTree([{ text: '叶子', children: [] }]), /<span class="tree-leaf">叶子<\/span>/)
  })

  it('空数组返回空串', () => {
    assert.equal(renderTree([]), '')
    assert.equal(renderTree(null), '')
  })
})

describe('renderMindmap', () => {
  it('渲染根、分支与孙节点', () => {
    const html = renderMindmap([{ text: '根', children: [{ text: '支', children: [{ text: '孙' }] }] }])
    assert.match(html, /mind-node root">根/)
    assert.match(html, /mind-node">支/)
    assert.match(html, /<span>孙<\/span>/)
  })

  it('空输入给占位', () => {
    assert.match(renderMindmap([]), /暂无思维导图/)
    assert.match(renderMindmap(null), /暂无思维导图/)
  })

  it('分支无孙节点时不渲染空容器', () => {
    const html = renderMindmap([{ text: '根', children: [{ text: '支', children: [] }] }])
    assert.doesNotMatch(html, /mind-grand/)
  })
})

describe('plain', () => {
  it('去掉标记并压缩空白', () => {
    assert.equal(plain('## 标题\n\n**重点**  `code`'), '标题 重点 code')
  })

  it('丢弃围栏代码块', () => {
    assert.equal(plain('前面\n```js\nconst a=1\n```\n后面'), '前面 后面')
  })

  it('超长截断加省略号', () => {
    const out = plain('啊'.repeat(200), 20)
    assert.equal(out.length, 20)
    assert.ok(out.endsWith('…'))
  })
})
