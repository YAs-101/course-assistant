/**
 * Tests for the note-structure layer.
 *
 * `buildNoteView` is what turns one `## <视频标题>` section of the handbook into
 * the four tabs of the UI, so the cases that matter are the messy ones: a note
 * with no mindmap, a mindmap only present in the subject overview, bullets mixed
 * with plain paragraphs, and depth beyond what the tree renderer expects.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildNoteView,
  countPoints,
  expandPrompt,
  EXPAND_SYSTEM,
  parseBullets,
  parseMindmap,
  splitBlocks,
  summarizeNote,
} from '../lib/deepsplit.mjs'

const NOTE = [
  '> 用音乐制作人的视角拆解星铁主题曲的编配。',
  '',
  '### 核心知识点',
  '- 主题动机贯穿全曲',
  '  - 前奏由三音动机建立',
  '  - 副歌做八度扩展',
  '- 配器以弦乐铺底',
  '',
  '### 弹幕与评论讨论焦点',
  '大家主要在聊副歌的转调。',
  '',
  '### 思维导图',
  '```mermaid',
  'mindmap',
  '  root((星铁主题曲))',
  '    动机',
  '      三音动机',
  '    配器',
  '      弦乐',
  '```',
].join('\n')

describe('splitBlocks', () => {
  it('取出引言与分节', () => {
    const { intro, blocks } = splitBlocks(NOTE)
    assert.match(intro, /音乐制作人/)
    assert.equal(blocks.length, 3)
    assert.equal(blocks[0].title, '核心知识点')
  })

  it('没有三级标题时整段都是引言', () => {
    const { intro, blocks } = splitBlocks('只有一段话')
    assert.equal(intro, '只有一段话')
    assert.deepEqual(blocks, [])
  })

  it('空文本不崩溃', () => {
    const { intro, blocks } = splitBlocks('')
    assert.equal(intro, '')
    assert.deepEqual(blocks, [])
  })
})

describe('parseBullets', () => {
  it('记录层级与文本', () => {
    const bullets = parseBullets('- 一层\n  - 二层\n    - 三层')
    assert.deepEqual(bullets.map((b) => b.level), [0, 1, 2])
    assert.equal(bullets[1].text, '二层')
  })

  it('忽略非列表行', () => {
    assert.deepEqual(parseBullets('普通段落'), [])
  })

  it('制表符按四空格计', () => {
    assert.equal(parseBullets('- a\n\t- b')[1].level, 1)
  })
})

describe('parseMindmap', () => {
  it('解析 mermaid mindmap 的层级', () => {
    const parsed = parseMindmap('```mermaid\nmindmap\n  root((课程))\n    分支一\n      孙一\n```')
    assert.equal(parsed.root.text, '课程')
    assert.equal(parsed.root.children[0].text, '分支一')
    assert.equal(parsed.root.children[0].children[0].text, '孙一')
  })

  it('支持 [] 形状标签', () => {
    const parsed = parseMindmap('```mermaid\nmindmap\n  root((根))\n    子[带标签]\n```')
    assert.equal(parsed.root.children[0].text, '带标签')
  })

  it('没有 mindmap 时返回 null', () => {
    assert.equal(parseMindmap(''), null)
    assert.equal(parseMindmap('普通文本'), null)
  })

  it('裸 mindmap 文本（无围栏）也能解析', () => {
    const parsed = parseMindmap('mindmap\n  root((根))\n    子')
    assert.equal(parsed.root.text, '根')
  })

  it('多根时返回 roots 数组', () => {
    const parsed = parseMindmap('```mermaid\nmindmap\n  a\n  b\n```')
    assert.equal(parsed.nodes.length, 2)
    assert.equal(parsed.root.text, 'a')
  })
})

describe('buildNoteView', () => {
  it('拆出四个视图', () => {
    const view = buildNoteView(NOTE)
    assert.match(view.intro, /音乐制作人/)
    assert.equal(view.knowledge.length, 2)
    assert.match(view.discussion, /转调/)
    assert.equal(view.mindmap.root.text, '星铁主题曲')
  })

  it('知识点保留两级结构', () => {
    const view = buildNoteView(NOTE)
    assert.equal(view.knowledge[0].text, '主题动机贯穿全曲')
    assert.equal(view.knowledge[0].children.length, 2)
    assert.ok(view.knowledgeFlat.length >= 4)
  })

  it('笔记内无思维导图时回落到学科总览', () => {
    const overview = '```mermaid\nmindmap\n  root((总览根))\n    概况\n```'
    const view = buildNoteView('### 核心知识点\n- 一条', overview)
    assert.equal(view.mindmap.root.text, '总览根')
  })

  it('两者都没有时 mindmap 为 null', () => {
    assert.equal(buildNoteView('### 核心知识点\n- 一条').mindmap, null)
  })

  it('兼容「评论区讨论焦点」标题', () => {
    const view = buildNoteView('### 评论区讨论焦点\n大家聊得很开')
    assert.match(view.discussion, /聊得很开/)
  })

  it('兼容「要点」标题', () => {
    const view = buildNoteView('### 要点\n- 甲\n- 乙')
    assert.equal(view.knowledge.length, 2)
  })

  it('空笔记不崩溃', () => {
    const view = buildNoteView('')
    assert.deepEqual(view.knowledge, [])
    assert.equal(view.discussion, '')
    assert.equal(view.mindmap, null)
  })
})

describe('summarizeNote', () => {
  it('优先取引用行', () => {
    assert.equal(summarizeNote('> 一句话简介\n\n正文'), '一句话简介')
  })

  it('没有引用时取第一条正文并去掉列表符号', () => {
    assert.equal(summarizeNote('### 核心知识点\n- 主题动机贯穿全曲'), '主题动机贯穿全曲')
    assert.equal(summarizeNote('1. 带序号的正文'), '带序号的正文')
  })

  it('超长截断', () => {
    assert.ok(summarizeNote('> ' + '啊'.repeat(200), 30).endsWith('…'))
  })

  it('空输入返回空串', () => {
    assert.equal(summarizeNote(''), '')
  })
})

describe('countPoints', () => {
  it('只数顶层知识点', () => {
    assert.equal(countPoints(NOTE), 2)
  })

  it('没有知识点时返回 0', () => {
    assert.equal(countPoints('### 其他\n- a'), 0)
    assert.equal(countPoints(''), 0)
  })
})

describe('expandPrompt / EXPAND_SYSTEM', () => {
  it('包含三段结构要求', () => {
    assert.match(EXPAND_SYSTEM, /一句话解释/)
    assert.match(EXPAND_SYSTEM, /为什么重要/)
    assert.match(EXPAND_SYSTEM, /怎么用/)
  })

  it('拼出上下文字段', () => {
    const prompt = expandPrompt({ title: '星铁主题曲', point: '三音动机', subject: '音乐鉴赏', section: '上下文内容' })
    assert.match(prompt, /学科：音乐鉴赏/)
    assert.match(prompt, /视频标题：星铁主题曲/)
    assert.match(prompt, /三音动机/)
    assert.match(prompt, /上下文内容/)
  })

  it('缺少可选字段时不出现空行', () => {
    const prompt = expandPrompt({ point: '只有知识点' })
    assert.doesNotMatch(prompt, /学科：/)
    assert.doesNotMatch(prompt, /视频标题：/)
  })

  it('过长的上下文被截断', () => {
    const prompt = expandPrompt({ point: 'p', section: '啊'.repeat(5000) })
    assert.ok(prompt.length < 3000)
  })
})
