/**
 * 课程助手前端。
 *
 * 用原生 ES 模块 + SSE，不依赖任何打包工具 —— 这样整个 app 目录拷到别处、
 * 双击 vbs 就能跑。数据只有两个来源：
 *   1. `/api/events` 的 status 快照（含 config / engine / knowledge / logs）
 *   2. `/api/events` 的 log 增量（poll.log 新行，用来做实时滚动）
 * 其余操作都是 POST 出去后等下一次快照刷回来，避免前端自己维护一份会跑偏的状态。
 */
import { escapeHtml, inline, renderMarkdown, renderTree, renderMindmap, plain } from './md.js'

const $ = (id) => document.getElementById(id)
const state = {
  status: null,
  feed: [],
  filter: 'all',
  autoScroll: true,
  candidate: null,
  selection: null, // { subject, title }
  note: null,
  noteView: 'outline',
  busy: false,
  connection: 'connecting',
  dirty: false,
}

/* ────────────────────────── 小工具 ────────────────────────── */

function toast(text, kind = '') {
  const el = document.createElement('div')
  el.className = 'toast' + (kind ? ' ' + kind : '')
  el.textContent = text
  $('toasts').append(el)
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s'
    el.style.opacity = '0'
    el.style.transform = 'translateY(6px)'
    setTimeout(() => el.remove(), 320)
  }, kind === 'err' ? 6000 : 3400)
}

function hhmmss(ms) {
  if (!ms) return '--:--:--'
  const d = new Date(ms)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function ago(ms) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s + ' 秒前'
  const m = Math.round(s / 60)
  if (m < 60) return m + ' 分钟前'
  return Math.round(m / 60) + ' 小时前'
}

function dur(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(1) + 's'
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  })
  let data = null
  try { data = await response.json() } catch { data = null }
  if (!response.ok) throw new Error(data?.message || `HTTP ${response.status}`)
  return data
}

/* ────────────────────────── 顶栏 ────────────────────────── */

function renderBrand(status) {
  const sub = $('brand-sub')
  if (!sub) return
  const app = status?.app
  if (!app) {
    // The markup ships with a "正在连接…" placeholder; leaving it there after a
    // successful connect makes a healthy app look stuck.
    sub.textContent = state.connection === 'closed' ? '服务已断开' : '正在连接…'
    return
  }
  const bits = [`端口 ${app.port}`]
  const knowledge = status.knowledge ?? {}
  if (knowledge.subjects?.length) {
    const videos = knowledge.subjects.reduce((sum, s) => sum + (s.videos ?? 0), 0)
    bits.push(`${knowledge.subjects.length} 学科 · ${videos} 视频`)
  }
  if (app.uptimeMs) bits.push(`运行 ${dur(app.uptimeMs)}`)
  sub.textContent = bits.join(' · ')
}

function renderPower(status) {
  const button = $('power')
  const enabled = Boolean(status?.config?.enabled)
  const running = Boolean(status?.engine?.running)
  // Enabled-but-idle has two very different causes; labelling both "启动中" would
  // look like a stuck spinner when the real cause is a second poller.
  const handedOver = enabled && !running && status?.polling?.foreign?.foreign === true
  button.setAttribute('aria-checked', enabled ? 'true' : 'false')
  button.setAttribute('aria-busy', state.busy ? 'true' : 'false')
  const text = button.querySelector('.power-text')
  if (state.busy) text.textContent = '处理中…'
  else if (!enabled) text.textContent = '未启动'
  else if (running) text.textContent = '运行中'
  else if (handedOver) text.textContent = '已让出'
  else text.textContent = '启动中'
}

function renderInterval(status) {
  const input = $('interval')
  const config = status?.config
  if (!config) return
  if (document.activeElement !== input) input.value = config.pollIntervalMs
  input.min = config.minPollMs ?? 2000
  for (const button of document.querySelectorAll('.interval-presets button')) {
    button.classList.toggle('on', Number(button.dataset.ms) === Number(config.pollIntervalMs))
  }
}

function renderPulse(status) {
  const pulse = $('pulse')
  const text = $('pulse-text')
  const meta = $('pulse-meta')
  pulse.classList.remove('live', 'warn', 'err')

  if (!status) {
    text.textContent = state.connection === 'closed' ? '与服务断开，正在重连…' : '正在连接服务…'
    pulse.classList.add(state.connection === 'closed' ? 'err' : 'warn')
    meta.textContent = ''
    return
  }

  const engine = status.engine ?? {}
  const polling = status.polling ?? {}
  // `polling.foreign` is a report object, not a boolean; testing it directly is
  // always truthy and would pin the banner to "somebody else is polling".
  const foreign = polling.foreign?.foreign === true
  const parts = []

  if (!status.config.enabled) {
    pulse.classList.add('warn')
    text.textContent = '轮询已关闭 —— 打开左上角开关开始盯着前台窗口'
  } else if (engine.lastError) {
    pulse.classList.add('err')
    text.textContent = '引擎异常：' + String(engine.lastError).slice(0, 120)
  } else if (foreign && !engine.running) {
    pulse.classList.add('warn')
    // `ago()` already ends in 前; appending another one read as "7 秒前前".
    text.textContent = `DeepSeek Harness 里的插件也在轮询（${ago(polling.foreign.ageMs)}刚写过），为避免重复记录已让出轮询权`
  } else if (!engine.running) {
    pulse.classList.add('warn')
    text.textContent = '开关已开，引擎未运行（点击「探测一次」或重启引擎）'
  } else {
    pulse.classList.add('live')
    const interval = status.config.pollIntervalMs
    text.textContent = `轮询中 · 每 ${interval >= 1000 ? (interval / 1000) + 's' : interval + 'ms'} 看一次前台窗口`
  }

  parts.push(`引擎 ${engine.running ? '运行' : '停止'}`)
  if (polling.ageMs !== null && polling.ageMs !== undefined) parts.push(`上次探测 ${ago(polling.ageMs)}`)
  parts.push(`间隔 ${status.config.pollIntervalMs}ms`)
  if (status.logs?.summary?.total) parts.push(`日志 ${status.logs.summary.total} 行`)
  meta.textContent = parts.join(' · ')
}

/* ────────────────────────── 左栏 ────────────────────────── */

function renderNow(status) {
  const summary = status?.logs?.summary ?? {}
  const fg = summary.lastForeground
  const candidateLog = summary.lastCandidate
  const polling = status?.polling ?? {}

  // 优先显示插件实际探测到的窗口；没有就用最近一条 fg 日志；再退到手动探测结果。
  const probe = polling.lastProbe
  let title = ''
  let proc = ''
  if (probe?.ok && Date.now() - probe.at < 60000) {
    title = probe.title
    proc = probe.proc
  } else if (fg) {
    title = fg.title || ''
    proc = fg.proc || ''
  }
  if (!title && probe?.title) {
    title = probe.title
    proc = probe.proc
  }

  $('now-title').textContent = title || '（没有读到前台窗口标题）'
  $('now-proc').textContent = '进程 ' + (proc || '—')

  const stateTag = $('now-state')
  const cadence = $('poll-cadence')
  if (!status?.config?.enabled) {
    stateTag.textContent = '轮询关闭'
    stateTag.className = 'tag warn'
  } else if (status?.engine?.running) {
    stateTag.textContent = '监听中'
    stateTag.className = 'tag ok'
  } else {
    stateTag.textContent = '未监听'
    stateTag.className = 'tag warn'
  }
  $('now-age').textContent = polling.ageMs !== null && polling.ageMs !== undefined ? '探测于 ' + ago(polling.ageMs) : '未探测'

  if (status?.engine?.lastRebuildMs) cadence.textContent = `重建 ${dur(status.engine.lastRebuildMs)}`
  else cadence.textContent = `每 ${status?.config?.pollIntervalMs ?? '—'}ms`

  // 候选：只有 browser 类日志才算真的识别到课程标题
  const candidate = candidateLog?.title ? candidateLog : null
  const box = $('candidate')
  if (candidate && candidate.at) {
    state.candidate = { title: candidate.title, proc: candidate.proc, at: candidate.at }
    box.hidden = false
    $('candidate-title').textContent = candidate.title
    const bits = [candidate.proc || '浏览器', hhmmss(candidate.at)]
    if (status?.knowledge?.lastTitle === candidate.title) bits.push('已总结')
    $('candidate-meta').textContent = bits.join(' · ')
  } else {
    state.candidate = null
    box.hidden = true
  }
}

function logRow(entry, fresh) {
  const kindLabel = {
    fg: '前台',
    browser: '候选',
    classify: '分类',
    bili: '素材',
    error: '错误',
    startup: '启动',
    done: '完成',
    other: '信息',
  }[entry.kind] || '信息'
  const time = entry.at ? new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'
  // 正文去掉冗余前缀，只留值，读起来清爽一些
  let body = entry.text
  body = body.replace(/^(fg|browser|classify|bili|error|startup|done)\s*/, '')
  return `<li class="row kind-${escapeHtml(entry.kind)}${fresh ? ' fresh' : ''}" data-kind="${escapeHtml(entry.kind)}">
    <span class="t">${escapeHtml(time)}</span>
    <span class="m"><span class="k">${escapeHtml(kindLabel)}</span> ${inline(body)}</span>
  </li>`
}

function renderFeed(full = true) {
  const feed = $('feed')
  const list = state.filter === 'all'
    ? state.feed
    : state.feed.filter((entry) => entry.kind === state.filter)
  const slice = list.slice(-260)
  if (!slice.length) {
    feed.innerHTML = `<li class="row kind-other"><span class="t"></span><span class="m dim">${state.status?.config?.enabled ? '还没有日志 —— 打开一个 B 站视频窗口试试' : '轮询未开启，先打开左上角开关'}</span></li>`
    return
  }
  feed.innerHTML = slice.map((entry) => logRow(entry, false)).join('')
  if (full && state.autoScroll) feed.scrollTop = feed.scrollHeight
}

function appendFeed(entries) {
  if (!entries?.length) return
  for (const entry of entries) state.feed.push(entry)
  if (state.feed.length > 800) state.feed.splice(0, state.feed.length - 800)
  const relevant = state.filter === 'all' ? entries : entries.filter((e) => e.kind === state.filter)
  if (!relevant.length) return
  const feed = $('feed')
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 40
  // 第一次有真实数据时把占位行清掉
  if (feed.querySelector('.row .m.dim')) feed.innerHTML = ''
  feed.insertAdjacentHTML('beforeend', relevant.map((entry) => logRow(entry, true)).join(''))
  while (feed.children.length > 300) feed.removeChild(feed.firstElementChild)
  if (state.autoScroll && atBottom) feed.scrollTop = feed.scrollHeight
}

function renderScanStatus(status) {
  const box = $('scan-status')
  const scan = status?.scan
  if (scan?.running) {
    box.hidden = false
    box.className = 'scan-status busy'
    box.textContent = '正在总结中…（抓取素材 + AI 生成 + 转 Word，通常 10–60 秒）'
    return
  }
  // `scan` is always an object ({running,last}); it is never null, so testing
  // `!scan` kept the box visible with `ok` undefined -- which reads as a failure
  // that never happened. Only a real `last` result is worth showing.
  const last = scan?.last
  if (!last) {
    box.hidden = true
    return
  }
  box.hidden = false
  const ok = last.ok === true
  box.className = 'scan-status' + (ok ? '' : ' err')
  const bits = []
  if (last.title) bits.push('「' + last.title.slice(0, 40) + '」')
  bits.push(ok ? '总结完成' : '总结失败')
  if (last.ms) bits.push(dur(last.ms))
  if (!ok && last.message) bits.push(last.message)
  box.textContent = bits.join(' · ')
}

/* ────────────────────────── 右栏 ────────────────────────── */

function renderSubjects(status, tree) {
  const box = $('subjects')
  const subjects = status?.knowledge?.subjects ?? []
  if (!subjects.length) {
    box.innerHTML = `<div class="empty dim" style="padding:14px 10px;font-size:12.5px">还没有学科。轮询识别到课程后这里会出现。</div>`
    return
  }
  const openSet = new Set([...box.querySelectorAll('.subj.open')].map((el) => el.dataset.subject))
  if (state.selection) openSet.add(state.selection.subject)
  else if (openSet.size === 0) openSet.add(subjects[0].name)

  const sectionsFor = (name) => {
    const found = tree?.subjects?.find((s) => s.name === name)
    return new Set(found?.sectionTitles ?? [])
  }

  box.innerHTML = subjects
    .map((subject) => {
      const open = openSet.has(subject.name)
      const titles = sectionsFor(subject.name)
      const videos = subject.videoTitles ?? []
      const rows = videos.length
        ? videos
            .map((title) => {
              const active = state.selection && state.selection.subject === subject.name && state.selection.title === title ? ' active' : ''
              const hasNote = titles.has(title) ? '<span class="has-note">●</span>' : '<span class="has-note" style="color:var(--fg-faint)">○</span>'
              return `<button class="video-btn${active}" data-subject="${escapeHtml(subject.name)}" data-title="${escapeHtml(title)}" title="${escapeHtml(title)}">${hasNote}${escapeHtml(shortTitle(title, 34))}</button>`
            })
            .join('')
        : '<div class="dim" style="padding:4px 8px;font-size:12px">没有视频</div>'
      return `<div class="subj${open ? ' open' : ''}" data-subject="${escapeHtml(subject.name)}">
        <button class="subj-btn"><span class="caret">▶</span><span class="subj-name">${escapeHtml(subject.name)}</span>${subject.orphan ? '<span class="subj-orphan" title="state.json 里已经没有这个学科，但磁盘上还留着它的学习手册">仅手册</span>' : ''}<span class="subj-count">${videos.length}</span></button>
        <div class="videos">${rows}</div>
      </div>`
    })
    .join('')

  const stats = $('know-stats')
  const totalVideos = subjects.reduce((sum, s) => sum + (s.videos ?? 0), 0)
  const notes = status?.knowledge?.noteCount ?? 0
  stats.textContent = `${subjects.length} 学科 · ${totalVideos} 视频 · ${notes} 文档`
}

function shortTitle(title, max) {
  const text = String(title ?? '')
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

function renderNote() {
  const note = state.note
  const body = $('note-body')
  const empty = $('note-empty')
  if (!note) {
    body.hidden = true
    empty.hidden = false
    return
  }
  empty.hidden = true
  body.hidden = false
  $('note-title').textContent = note.title
  const meta = []
  if (note.subject) meta.push(note.subject)
  if (note.view?.knowledgeFlat?.length) meta.push(`${note.view.knowledgeFlat.filter((p) => p.level === 0).length} 个知识点`)
  if (note.mtime) meta.push('更新于 ' + hhmmss(note.mtime))
  $('note-meta').textContent = meta.join(' · ')

  for (const tab of document.querySelectorAll('#note-tabs .tab')) {
    tab.classList.toggle('active', tab.dataset.view === state.noteView)
  }

  const content = $('note-content')
  const view = note.view ?? {}
  if (state.noteView === 'outline') {
    if (view.knowledge?.length) {
      content.innerHTML = renderTree(view.knowledge) + renderDigTargets()
      bindDigButtons()
    } else if (note.markdown) {
      content.innerHTML = renderMarkdown(note.markdown)
    } else {
      content.innerHTML = '<div class="empty">这条笔记还没有结构化的知识点。</div>'
    }
  } else if (state.noteView === 'mind') {
    content.innerHTML = view.mindmap?.nodes?.length
      ? renderMindmap(view.mindmap.nodes)
      : '<div class="empty">这条笔记没有思维导图（可能生成时模型省略了）。</div>'
  } else if (state.noteView === 'talk') {
    content.innerHTML = view.discussion
      ? renderMarkdown(view.discussion)
      : '<div class="empty">没有抓取到弹幕与评论。</div>'
  } else {
    content.innerHTML = note.markdown
      ? `<pre class="code" data-lang="markdown"><code>${escapeHtml(note.markdown)}</code></pre>`
      : '<div class="empty">没有原始 Markdown。</div>'
  }
}

/** 在知识点列表里给每个顶层点挂一个「深挖」按钮的锚点。 */
function renderDigTargets() {
  return ''
}

function bindDigButtons() {
  // 知识点是 <li>，直接按顺序绑定：每个最外层 summary/leaf 一个按钮
  const content = $('note-content')
  const enabled = Boolean(state.status?.config?.enableDeepSplit)
  const points = state.note?.view?.knowledgeFlat?.filter((p) => p.level === 0) ?? []
  const targets = content.querySelectorAll('.tree.depth-0 > li')
  targets.forEach((li, index) => {
    const point = points[index]
    if (!point) return
    const label = li.querySelector(':scope > details > summary, :scope > .tree-leaf, :scope > .tree-label')
    if (!label) return
    const wrap = document.createElement('div')
    wrap.className = 'point-row'
    label.parentNode.insertBefore(wrap, label)
    wrap.append(label)
    const button = document.createElement('button')
    button.className = 'dig'
    button.textContent = enabled ? '深挖' : '深挖*'
    button.title = enabled ? '让 AI 把这一个知识点讲透' : '需要在设置里打开「知识深挖」'
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      digPoint(point.text, button)
    })
    wrap.append(button)
  })
}

async function digPoint(point, button) {
  if (!state.status?.config?.enableDeepSplit) {
    toast('先在设置里打开「知识深挖」', 'warn')
    return
  }
  const host = button.closest('.point-row')?.parentElement
  if (!host) return
  let out = host.querySelector(':scope > .dig-out')
  if (!out) {
    out = document.createElement('div')
    out.className = 'dig-out'
    const row = button.closest('.point-row')
    row.insertAdjacentElement('afterend', out)
  }
  out.innerHTML = '<span class="spin">正在请 AI 讲透这个点…</span>'
  button.disabled = true
  try {
    const result = await api('/api/expand', {
      method: 'POST',
      body: JSON.stringify({
        subject: state.selection?.subject ?? '',
        title: state.selection?.title ?? '',
        point,
        section: state.note?.markdown ?? '',
      }),
    })
    out.innerHTML = renderMarkdown(result.markdown || '')
  } catch (error) {
    out.innerHTML = `<span style="color:var(--danger)">深挖失败：${escapeHtml(error.message)}</span>`
  } finally {
    button.disabled = false
  }
}

async function openNote(subject, title) {
  state.selection = { subject, title }
  renderSubjects(state.status, state.tree)
  $('note-empty').hidden = false
  $('note-body').hidden = true
  try {
    const query = `?subject=${encodeURIComponent(subject)}&title=${encodeURIComponent(title)}`
    const note = await api('/api/note' + query)
    state.note = note
    state.noteView = 'outline'
    renderNote()
  } catch (error) {
    state.note = null
    $('note-empty').hover = null
    $('note-empty').innerHTML = `<p class="big">这条视频还没有笔记段落</p><p class="dim">${escapeHtml(error.message)}<br>可能正在生成，稍后刷新试试。</p>`
    $('note-body').hidden = true
  }
}

function renderFiles(status) {
  const list = $('files-list')
  const knowledge = status?.knowledge
  if (!knowledge) {
    list.innerHTML = ''
    return
  }
  const items = []
  for (const handbook of knowledge.handbooks ?? []) {
    const icon = handbook.kind === 'overview' ? '🗂' : '📘'
    items.push(`<div class="file-row"><span class="icon">${icon}</span><span class="name" title="${escapeHtml(handbook.rel)}">${escapeHtml(handbook.name)}</span><span class="meta">${escapeHtml(handbook.sizeText)}</span><a href="/api/file?rel=${encodeURIComponent(handbook.rel)}">下载</a></div>`)
  }
  for (const note of knowledge.notes ?? []) {
    items.push(`<div class="file-row"><span class="icon">📄</span><span class="name" title="${escapeHtml(note.rel)}">${escapeHtml(note.name)}</span><span class="meta">${escapeHtml(note.sizeText)}</span><a href="/api/file?rel=${encodeURIComponent(note.rel)}">下载</a></div>`)
  }
  list.innerHTML = items.length ? items.join('') : '<div class="dim" style="padding:6px 8px;font-size:12px">还没有生成的文档。</div>'
  $('files-count').textContent = `${(knowledge.handbooks?.length ?? 0)} 手册 · ${knowledge.noteCount ?? 0} 笔记`
}

function renderFooter(status) {
  const env = status?.env
  const bits = []
  if (env?.coursemap?.ok) bits.push('插件就绪')
  else bits.push('插件缺失')
  if (env?.python?.path) bits.push('Python 就绪')
  else bits.push('Python 缺失')
  if (env?.credentials?.ok) bits.push('DeepSeek 就绪')
  else bits.push('DeepSeek 未配置')
  $('foot-env').textContent = bits.join(' · ')

  const bridge = status?.bridge
  const tag = $('bridge-state')
  if (!bridge) {
    tag.textContent = '投递 —'
    tag.className = 'tag'
  } else if (bridge.alive) {
    tag.textContent = `投递监听中 · ${bridge.delivered} 已投递`
    tag.className = 'tag ok'
    tag.title = `DeepSeek Harness 里的 course-bridge 正在运行（心跳 ${ago(bridge.ageMs)}）`
  } else {
    tag.textContent = `投递未运行 · ${bridge.delivered} 已投递`
    tag.className = 'tag warn'
    tag.title = 'DeepSeek Harness 没在跑（或 bridge 插件没启用）。笔记文档仍会生成，只是不会自动投递到 DSH 会话。'
  }
}

/* ────────────────────────── 主渲染 ────────────────────────── */

function applyTree(status) {
  // 学科与视频列表来自 status；段落标题需要手册内容，单独拉一次更省。
  const subjects = status?.knowledge?.subjects ?? []
  const need = subjects
    .filter((s) => s.manualMdOk)
    .map((s) => s.name)
  if (!need.length) return
  const current = state.tree ?? { subjects: [] }
  const have = new Set((current.subjects ?? []).map((s) => s.name))
  const missing = need.filter((name) => !have.has(name))
  const stale = need.some((name) => {
    const found = (current.subjects ?? []).find((s) => s.name === name)
    const subject = subjects.find((s) => s.name === name)
    return !found || (subject?.updatedAt ?? 0) > (found.updatedAt ?? 0)
  })
  if (!missing.length && !stale) return
  api('/api/tree').then((tree) => {
    state.tree = tree
    renderSubjects(state.status, tree)
  }).catch(() => {})
}

function render(status) {
  state.status = status
  renderBrand(status)
  renderPower(status)
  renderInterval(status)
  renderPulse(status)
  renderNow(status)
  renderScanStatus(status)
  renderSubjects(status, state.tree)
  renderFiles(status)
  renderFooter(status)
  renderSettings(status)
  if (!state.note && status?.knowledge?.subjects?.length && !state.selection) {
    // 首次进来直接选第一个学科的第一个视频，避免右边空着
    const subject = status.knowledge.subjects.find((s) => (s.videoTitles ?? []).length)
    if (subject) openNote(subject.name, subject.videoTitles[0])
  }
  applyTree(status)
}

function renderSettings(status) {
  if (!status) return
  const config = status.config
  const set = (id, value) => {
    const el = $(id)
    if (!el || document.activeElement === el) return
    if (el.type === 'checkbox') el.checked = Boolean(value)
    else el.value = value ?? ''
  }
  set('set-stable', config.stablePolls)
  set('set-minlen', config.titleMinLen)
  set('set-fetch', config.fetchContent)
  set('set-model', config.model ?? 'deepseek-flash')
  set('set-maxtokens', config.maxTokens)
  set('set-deepsplit', config.enableDeepSplit)
  set('set-outdir', config.outputDir)
  set('set-coursemap', config.coursemapModule ?? '')
  set('set-python', config.pythonPath ?? '')

  const env = status.env ?? {}
  const rows = []
  const row = (label, value, ok) => {
    const cls = ok === undefined ? '' : ok ? 'ok' : 'err'
    rows.push(`<div class="env-row"><span class="lbl">${label}</span><span class="val ${cls}" title="${escapeHtml(value ?? '')}">${escapeHtml(value ?? '—')}</span></div>`)
  }
  if (env.coursemap?.ok) row('课程插件', env.coursemap.path, true)
  else row('课程插件', '未找到（可在下方手动指定）', false)
  row('Python', env.python?.path ? `${env.python.path}（${env.python.version || env.python.source}）` : '未找到', Boolean(env.python?.path))
  row('DeepSeek', env.credentials?.ok ? env.credentials.file : (env.credentials?.reason || '未配置'), Boolean(env.credentials?.ok))
  if (env.api) row('API 自检', env.api.ok ? `正常 · 模型 ${(env.api.models || []).join(', ')}` : env.api.reason || '失败', env.api.ok)
  if (env.llm?.lastError) row('最近 LLM 错误', env.llm.lastError, false)
  $('env-list').innerHTML = rows.join('')
}

/* ────────────────────────── SSE ────────────────────────── */

function connect() {
  const source = new EventSource('/api/events')
  source.addEventListener('open', () => {
    state.connection = 'open'
  })
  source.addEventListener('status', (event) => {
    try { render(JSON.parse(event.data)) } catch (error) { console.error('status 解析失败', error) }
  })
  source.addEventListener('log', (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.reset) {
        state.feed = data.entries ?? []
        renderFeed(false)
      } else {
        appendFeed(data.entries ?? [])
      }
    } catch (error) { console.error('log 解析失败', error) }
  })
  source.addEventListener('notice', (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data?.text) toast(data.text, /失败|错误|异常/.test(data.text) ? 'err' : '')
    } catch { /* ignore */ }
  })
  source.addEventListener('error', () => {
    state.connection = 'closed'
    if (!state.status) renderPulse(null)
    // EventSource 自己会重连；这里只更新 UI 文案。
  })
}

/* ────────────────────────── 交互绑定 ────────────────────────── */

let intervalTimer = null

function bind() {
  // 开关
  $('power').addEventListener('click', async () => {
    if (state.busy) return
    const status = state.status
    const enabled = Boolean(status?.config?.enabled)
    const running = Boolean(status?.engine?.running)
    // "已让出" means the box is ticked but this instance deliberately stayed idle
    // because DSH's copy owns polling. Treating that click as "turn the switch off"
    // would make the user click twice before any polling happens, so an enabled
    // switch always means "start polling now".
    const action = enabled && running ? 'stop' : 'start'
    state.busy = true
    renderPower(state)
    try {
      const result = await api('/api/engine', {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      const failed = result.ok === false || result.result?.ok === false
      const warn = result.warning || result.result?.warning
      let text = action === 'stop' ? '轮询已关闭' : '轮询已启动'
      if (failed) text = (action === 'stop' ? '关闭失败：' : '启动失败：') + (result.message || result.result?.error || '')
      else if (warn) text = '已启动，但' + warn
      toast(text, failed ? 'err' : warn ? 'warn' : '')
    } catch (error) {
      toast('切换失败：' + error.message, 'err')
    } finally {
      state.busy = false
      renderPower(state.status)
    }
  })

  // 轮询间隔
  const commitInterval = async (value) => {
    const ms = Number(value)
    if (!Number.isFinite(ms)) return
    try {
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify({ pollIntervalMs: ms }) })
      const rebuild = result.rebuild
      toast(`间隔已改为 ${ms}ms${rebuild ? `（引擎重建 ${dur(rebuild.ms)}）` : ''}`, rebuild?.ok === false ? 'err' : '')
    } catch (error) {
      toast('修改间隔失败：' + error.message, 'err')
    }
  }
  $('interval').addEventListener('input', (event) => {
    const value = Number(event.target.value)
    if (!Number.isFinite(value)) return
    clearTimeout(intervalTimer)
    intervalTimer = setTimeout(() => commitInterval(value), 650)
  })
  for (const button of document.querySelectorAll('.interval-presets button')) {
    button.addEventListener('click', () => {
      $('interval').value = button.dataset.ms
      commitInterval(button.dataset.ms)
    })
  }

  // 探测
  $('probe').addEventListener('click', async () => {
    const button = $('probe')
    button.disabled = true
    button.textContent = '探测中…'
    try {
      const result = await api('/api/probe', { method: 'POST', body: '{}' })
      const probe = result.probe
      if (probe.ok) toast(`探测 ${dur(probe.ms)}：${probe.proc} · ${shortTitle(probe.title, 26)}`)
      else toast('探测失败：' + probe.error, 'err')
    } catch (error) {
      toast('探测失败：' + error.message, 'err')
    } finally {
      button.disabled = false
      button.textContent = '探测一次'
    }
  })

  // 总结当前前台
  $('scan-current').addEventListener('click', async () => {
    const probe = state.status?.polling?.lastProbe
    const title = probe?.ok ? probe.title : state.status?.logs?.summary?.lastForeground?.title
    if (!title) {
      toast('还没读到前台标题，先点「探测一次」', 'warn')
      return
    }
    scan(title)
  })

  // 总结候选
  $('scan-candidate').addEventListener('click', () => {
    if (state.candidate?.title) scan(state.candidate.title)
  })

  // 手动标题
  const manualGo = () => {
    const title = $('manual-title').value.trim()
    if (!title) {
      toast('先填一个标题', 'warn')
      return
    }
    scan(title)
  }
  $('manual-go').addEventListener('click', manualGo)
  $('manual-title').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') manualGo()
  })

  // 日志筛选
  for (const chip of document.querySelectorAll('#log-filter .chip')) {
    chip.addEventListener('click', () => {
      for (const other of document.querySelectorAll('#log-filter .chip')) other.classList.remove('active')
      chip.classList.add('active')
      state.filter = chip.dataset.kind
      renderFeed()
    })
  }
  $('auto-scroll').addEventListener('change', (event) => {
    state.autoScroll = event.target.checked
    if (state.autoScroll) $('feed').scrollTop = $('feed').scrollHeight
  })

  // 学科/视频
  $('subjects').addEventListener('click', (event) => {
    const subj = event.target.closest('.subj-btn')
    if (subj) {
      const parent = subj.closest('.subj')
      parent.classList.toggle('open')
      return
    }
    const video = event.target.closest('.video-btn')
    if (video) openNote(video.dataset.subject, video.dataset.title)
  })

  // 笔记页签
  for (const tab of document.querySelectorAll('#note-tabs .tab')) {
    tab.addEventListener('click', () => {
      state.noteView = tab.dataset.view
      renderNote()
    })
  }

  $('reload-know').addEventListener('click', async () => {
    try {
      state.tree = await api('/api/tree')
      renderSubjects(state.status, state.tree)
      if (state.selection) await openNote(state.selection.subject, state.selection.title)
      toast('已刷新知识地图')
    } catch (error) {
      toast('刷新失败：' + error.message, 'err')
    }
  })

  $('note-md-btn').addEventListener('click', () => {
    const subject = state.selection?.subject
    if (!subject) return
    const rel = `${subject}/学习手册.docx`
    window.open('/api/file?rel=' + encodeURIComponent(rel), '_blank')
  })
  $('note-raw-btn').addEventListener('click', () => {
    state.noteView = state.noteView === 'raw' ? 'outline' : 'raw'
    renderNote()
  })

  // 设置抽屉
  const drawer = $('drawer')
  const openDrawer = () => {
    drawer.hidden = false
    renderSettings(state.status)
  }
  const closeDrawer = () => { drawer.hidden = true }
  $('settings-btn').addEventListener('click', openDrawer)
  for (const closer of drawer.querySelectorAll('[data-close]')) closer.addEventListener('click', closeDrawer)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) closeDrawer()
  })

  $('save').addEventListener('click', async () => {
    const patch = {
      stablePolls: Number($('set-stable').value),
      titleMinLen: Number($('set-minlen').value),
      fetchContent: $('set-fetch').checked,
      model: $('set-model').value,
      maxTokens: Number($('set-maxtokens').value),
      enableDeepSplit: $('set-deepsplit').checked,
      outputDir: $('set-outdir').value.trim(),
      coursemapModule: $('set-coursemap').value.trim() || null,
      pythonPath: $('set-python').value.trim() || null,
    }
    try {
      const result = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) })
      const bits = []
      if (result.changed?.length) bits.push('重建：' + result.changed.join('、'))
      if (result.rebuild) bits.push(`引擎 ${result.rebuild.ok ? '就绪' : '失败'}（${dur(result.rebuild.ms)}）`)
      $('save-hint').textContent = bits.join(' · ') || '已保存'
      toast('设置已保存' + (result.rebuild?.ok === false ? '，但引擎重建失败' : ''), result.rebuild?.ok === false ? 'err' : '')
    } catch (error) {
      toast('保存失败：' + error.message, 'err')
    }
  })

  $('api-probe').addEventListener('click', async (event) => {
    const button = event.target
    button.disabled = true
    button.textContent = '测试中…'
    try {
      const result = await api('/api/llm/probe', { method: 'POST', body: '{}' })
      $('env-note').hidden = false
      $('env-note').textContent = result.ok
        ? `DeepSeek 连接正常，可用模型：${(result.probe.models || []).join(', ') || '(未返回)'}`
        : `DeepSeek 连接失败：${result.probe.reason || '未知原因'}`
      toast(result.ok ? 'DeepSeek 连接正常' : 'DeepSeek 连接失败', result.ok ? '' : 'err')
    } catch (error) {
      toast('测试失败：' + error.message, 'err')
    } finally {
      button.disabled = false
      button.textContent = '测试 DeepSeek 连接'
    }
  })

  $('engine-restart').addEventListener('click', async (event) => {
    const button = event.target
    button.disabled = true
    button.textContent = '重启中…'
    try {
      const result = await api('/api/engine', { method: 'POST', body: JSON.stringify({ action: 'restart' }) })
      toast(result.result?.ok ? `引擎已重启（${dur(result.result.ms)}）` : '引擎重启失败：' + (result.result?.error || ''), result.result?.ok ? '' : 'err')
    } catch (error) {
      toast('重启失败：' + error.message, 'err')
    } finally {
      button.disabled = false
      button.textContent = '重启引擎'
    }
  })

  $('selfcheck').addEventListener('click', async () => {
    try {
      const status = await api('/api/status')
      const env = status.env ?? {}
      const lines = [
        `插件：${env.coursemap?.ok ? '就绪' : '缺失'}`,
        `Python：${env.python?.path ? env.python.version || '就绪' : '缺失'}`,
        `DeepSeek：${env.credentials?.ok ? '就绪' : '未配置'}`,
        `引擎：${status.engine?.running ? '运行' : '停止'}`,
        `日志：${status.logs?.summary?.total ?? 0} 行`,
      ]
      toast(lines.join(' · '), env.coursemap?.ok && env.python?.path ? '' : 'warn')
    } catch (error) {
      toast('自检失败：' + error.message, 'err')
    }
  })
}

async function scan(title) {
  if (state.busy) return
  state.busy = true
  $('manual-go').disabled = true
  $('scan-candidate').disabled = true
  $('scan-status').hidden = false
  $('scan-status').className = 'scan-status busy'
  $('scan-status').textContent = `正在总结「${shortTitle(title, 30)}」…`
  try {
    const result = await api('/api/scan', { method: 'POST', body: JSON.stringify({ title }) })
    toast(result.ok ? '总结完成' : '总结失败：' + (result.result?.message || result.message || ''), result.ok ? '' : 'err')
    if (result.ok) {
      // 生成完立刻拉一次手册，让右边马上能看到新笔记
      state.tree = await api('/api/tree').catch(() => state.tree)
      renderSubjects(state.status, state.tree)
      $('manual-title').value = ''
    }
  } catch (error) {
    toast('总结失败：' + error.message, 'err')
  } finally {
    state.busy = false
    $('manual-go').disabled = false
    $('scan-candidate').disabled = false
  }
}

/* ────────────────────────── 启动 ────────────────────────── */

renderFeed()
bind()
connect()
// 首屏先主动拉一次，避免 SSE 首包到达前的空窗
api('/api/status').then((status) => render(status)).catch(() => renderPulse(null))
