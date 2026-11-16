# dsh-course-bridge

把 `dsh-video-coursemap` 识别出的每一节 B 站课程，做成一份 Word 知识笔记，并投递到一个**新会话**的对话框里。

它是一条很薄的桥：

| 环节 | 谁负责 |
| --- | --- |
| 定时观察浏览器前台窗口、判断是否新视频 | `dsh-video-coursemap` |
| 学科分类（已有学科 → 追加章节；新学科 → 新建学习手册） | `dsh-video-coursemap` |
| 每轮收尾写长期记忆 | `dsh-memory-evolve` |
| 发现新增 (学科, 视频) → 反查 BV 号 → 抓简介/字幕/弹幕/评论 → 模型总结 | **本插件**（`lib/bili.js` + `lib/summarize.js`） |
| 切出视频小节 → 转 Word → 建新会话投递 | **本插件**（`lib/docx.js` + `lib/deliver.js`） |

三个插件互不改源码：coursemap 是 tgz 管理的第三方包，升级会覆盖；本插件只消费它落在磁盘上的产物。

## 数据来源

读取 `<outputDir>/.state/`：

- `state.json` —— coursemap 的权威账本：`{ subjects: { <学科>: { createdAt, videos: [标题...] } }, seen, lastTitle, lastRunAt }`。整条处理链跑完才落盘，所以一出现新视频就代表手册与 Word 都已就绪。
- `manuals/<学科>.md` —— 学科学习手册，视频小节之间用 `\n\n---\n\n` 分隔，每个视频小节以 `## <视频标题>` 开头。

账本写在 `<outputDir>/.state/bridge.json`：

```json
{
  "version": 1,
  "initialized": true,
  "delivered": { "<学科>\u0000<标题>": { "subject": "...", "title": "...", "sessionId": "...", "docxPath": "...", "at": 0, "degraded": true } },
  "pending":   { "<key>": { "attempts": 1, "lastError": "...", "nextTryAt": 0, "docxPath": "...", "sessionId": "..." } },
  "abandoned": { "<key>": { "at": 0, "reason": "..." } },
  "sessions":  { "<key>": "<sessionId>" }
}
```

## 为什么抓取要自己做

coursemap 自己也会抓一次 B 站内容，但它只用**完整标题**搜一页、只看 `results[0]`，随后要求标题相似度 >= 0.5。实测该策略几乎总是落空（bvid=none），于是它生成的「弹幕与评论讨论焦点」全是模型凭空编的。它又是 tgz 管理的第三方包，改源码会在升级时丢失。

所以 `lib/bili.js` 重做了一遍解析：

- `buildQueries(title)` 把一个标题展开成最多 8 条查询（原题 → 管道分段 → 最长 3 个分句 → 段×段、句×句组合）。
- `resolveBvid(title)` 对**每条**查询都搜一遍，取**全局最高分**再比阈值（默认 0.65）。绝不能「首个过阈值即停」：`职业音乐制作人Reaction听评畅聊` 单独搜时最高分是**另一个视频**的 0.533，只按顺序短路就会配错视频。
- 命中后用 `view` 取 aid/cid/简介/字幕，再并行抓弹幕 XML 与热评；任何单步失败只记进 `errors`，不放弃整份笔记。
- `pickDanmaku` 去掉「哈哈哈 / 666 / awsl」这类无信息量弹幕并按 `normTitle` 去重，然后**等距采样**而不是取前 N 条——B 站弹幕是按时间排的，截断会让笔记只剩开头几十秒。

`lib/summarize.js` 把真实素材喂给宿主 LLM（`ctx.llm.stream`，模型按 显式配置 → `agentDefaultModel.currentSelection()` → 第一个 provider 的顺序解析），要求它只写素材里有的东西；无论模型成功与否，笔记末尾都追加一节**原始素材（可核对）**——简介引用、弹幕节选、按赞排序的热评，读者可以逐条对照。模型不可用时自动降级为纯素材版，不会产出编造内容。

## 一次投递做了什么

1. 按标题反查 BV 号，抓简介 / 字幕 / 弹幕 / 评论，交给模型总结（`fetchContent: false` 可整体关闭）。
2. 从 `manuals/<学科>.md` 按标题切出这一节（exact → 去标点小写 → 包含，三级匹配；短标题不允许吞长标题）。
3. `scripts/md2docx.py` 把 Markdown 转成 `.docx`，写到 `<outputDir>/笔记/笔记-<标题>-<yyyymmdd-HHMM>.docx`，中间的 `.md` 成功后删掉。
4. `sessionController.create({ cwd })` 新开一个普通会话，并立刻把它的权限预设改成本插件配置的 `sessionPermissionPreset`（默认 `danger-full-access`）——宿主默认的 `workspace-write` 在本机会因为拿不到目录 ACL 而让新会话读不动附件；这里用的三个会话事件与 `dsh-subagent` 委派子会话时的写法一致。
5. `fileUploads.uploadStream()` 把 docx 变成该会话的附件，拿到 `receiptId`。
6. `sessionController.prompt()` 投递一条带附件的用户消息（`requestId` 复用，重试幂等）。
7. `sessionController.rename()` 把会话改成可读标题，`sessions.flush()` 落盘。

任何一步失败都不会丢掉已经转好的 docx：`pending` 里记下 `docxPath` / `sessionId`，按指数退避重试，成功后复用，不重复转换、不重复建会话。

## 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: dsh-course-bridge
      name: './plugins/dsh-course-bridge/index.js'
      config:
        outputDir: '<课程插件的输出目录，如 D:\课程知识地图>'
        deliverCwd: '<投递新会话时的工作目录>'
        watchIntervalMs: 3000
        agentPreset: null
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后只保留工具，不轮询 |
| `outputDir` | `~/课程知识地图` | 必须与 coursemap 的 `outputDir` 一致 |
| `deliverCwd` | = `outputDir` | 新会话的工作目录 |
| `watchIntervalMs` | `3000` | 观察 state.json 的间隔 |
| `maxDeliveriesPerScan` | `3` | 单轮最多投递几个（自动扫描；手动工具不受限） |
| `maxAttempts` | `5` | 超过即转 `abandoned` |
| `retryBaseMs` / `retryMaxMs` | `60000` / `900000` | 指数退避的上下限 |
| `agentPreset` | `null` | **默认不传**；宿主没有稳定公开的 preset id，写错会让 create 失败 |
| `initialBackfill` | `false` | 首次启动时已存在的历史视频是否补投 |
| `pythonPath` | 自动探测 | 先找 `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`，再找 PATH |
| `notesDirName` | `笔记` | docx 输出子目录 |
| `sessionTitlePrefix` | `课程笔记` | 新会话标题前缀 |
| `sessionPermissionPreset` | `danger-full-access` | 投递会话的权限预设，**只在新建会话时写入一次**；写空串则沿用部署默认 |
| `fetchContent` | `true` | 关掉则完全不联网，笔记只用手册里由标题推断的内容 |
| `summarize` | `true` | 关掉则跳过 LLM，直接输出「原始素材（可核对）」 |
| `includeManualSection` | `true` | 是否把「课程知识地图初稿（未经素材核对）」附在最后 |
| `matchThreshold` | `0.65` | BV 号反查的标题相似度下限，必须在 (0, 1] |
| `maxQueries` | `8` | 展开出的搜索查询上限（每条间隔 700ms） |
| `provider` / `model` | `null` | 总结用哪个模型；留空则用会话默认模型 |
| `maxTokens` | `3000` | 总结的输出上限 |

未知键会直接抛错，避免拼错后静默失效。

## 工具

- `course_note_status` —— 观察目录、笔记目录、已投递 / 待重试 / 已放弃数量、每个视频对应的会话。排查「为什么没生成笔记」先看它。
- `course_note_deliver` —— 手动补投。`title` 留空处理全部待投递；`subject` 缩小范围；`force: true` 无视退避立即重试。

## 失败与静默

| 情况 | 行为 |
| --- | --- |
| 不是新视频 / 前台不是浏览器 / 是 B 站首页搜索页 | 全程静默，不写任何东西 |
| `state.json` 正在写（半截 JSON） | 本轮跳过，下一轮再读 |
| 手册里找不到该视频小节 | 降级：投整份手册，账本标 `degraded: true` |
| 找不到 Python / 转换失败 | 记 `pending` 退避重试，`maxAttempts` 次后 `abandoned` |
| 宿主缺 `sessionController` / `fileUploads` | 保留 docx、记 `pending`，**不**标记 delivered，下次补投 |
| 宿主没有 `permissionPresets` / 预设名写错 | 记一条日志，会话沿用部署默认，**不影响投递** |
| 会话已建但 prompt 失败 | 复用 `sessionId`，用同一个 `requestId` 只重试投递 |
| 改标题 / flush 失败 | 只记日志，不影响笔记 |
| 反查不到 BV 号（相似度不足） | 仍生成笔记，但只含手册里由标题推断的内容，封面标注「未经素材核对」 |
| 弹幕 / 评论 / 字幕部分失败 | 记进 `errors`，笔记照发，封面与正文标注「部分素材抓取失败」 |
| 模型不可用 / 报错 / 返回空 | 降级为纯素材版（`source: fallback`），不编造 |
| Python 控制台是 GBK 且标题带 emoji | `PYTHONIOENCODING=utf-8` 传给子进程；即使脚本回显路径失败，只要产物是合法 docx 仍算成功 |

## 测试

```powershell
node --test "test/*.test.js"
```

97 个用例，全部离线（B 站请求一律注入假 `fetchImpl`，LLM 用假 `stream`）。覆盖文件名清洗、手册切段与三级匹配、账本读写与退避选择、多 query 反查只在**全局**最高分处命中（构造了诱饵视频，保证不是首个过阈值即停）、弹幕去噪与等距采样、模型三级回落与降级、真实 md2docx 转换（断言 docx 文件头 `504b0304`、中间 `.md` 被清理、**带 emoji 的标题也能转换**），以及整条投递链的顺序与各个失败分支。

`tools/e2e-dryrun.mjs` 是端到端干跑：复制真实 `.state`，追加一个视频小节，用假 ctx 跑完整条链，断言 Word 内容与「第二次扫描完全静默」。

## 两个踩过的坑

**`inject` 必须放进 default export。** `cordis-plugin-loader` 的 `unwrapExports` 是 `exports = exports.default ?? exports`，所以 `export default { apply }` 会把模块级的 `export const inject = ['tools']` 丢掉。而没声明 inject 就访问 `ctx.tools` 会抛 `cannot get property "tools" without inject`；这个异常发生在 `ctx.effect` 里，会把该 fiber 已收集的 disposables（含后建的 `setInterval`）一并回收——症状是「日志打了『已启动』，但永远不扫描」。现在写成 `export default { apply, inject }`，并且工具注册用 `registerTool()` 包起来，单个工具失败不再拖死轮询。

**改 profile 的 `cordis.patch.yml` 只能用 Node 的 utf8 读写。** 用 PowerShell 的 `Get-Content -Raw` + `Set-Content` 会把中文写成 `\uFFFD`（ASCII/GBK 往返），YAML 结构也会被压平，宿主随后读不出配置。

## 依赖

只 import `node:` 内建模块 —— profile 作用域解析不到 `@deepseek-ai/dsh-*`，所以所有宿主服务都在调用时用 `ctx.get()` 惰性获取。除 Node >= 20 与带 `python-docx` 的 Python 外没有别的依赖。
