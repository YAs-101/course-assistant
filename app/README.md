# 课程助手（独立前端）

一个不依赖 DeepSeek Harness 就能双击使用的本地网页应用：它盯着你的前台窗口，发现你在看 B 站课程视频，就去抓弹幕/评论/字幕，让 DeepSeek 写一份知识总结，落到 Word 文档和学科手册里。

- 纯 Node（≥20）标准库，**零第三方依赖**，不需要 `npm install`
- 界面是本地网页（`http://127.0.0.1:7788`），无外网 CDN、无字体下载
- 课程插件已内置在 `vendor/`，没装过 DeepSeek Harness 的机器也能直接用
- 桌面快捷方式：运行一次 `scripts/make-shortcut.ps1`，之后双击桌面上的「课程助手」

## 快速开始

双击桌面上的 **课程助手**。它会：

1. 后台静默启动本地服务（窗口隐藏）
2. 打开浏览器到 `http://127.0.0.1:7788`
3. 右上角显示环境自检：课程插件 / Python / DeepSeek 是否就绪

也可以命令行启动：

```powershell
cd <你放它的目录>\app
node main.mjs --open      # 启动并打开浏览器
node main.mjs             # 只启动服务
node main.mjs --port 7790 # 指定端口（被占用时默认自动顺延）
```

再次双击快捷方式不会起第二个进程——已经在跑就只把页面打开。

## 界面怎么用

| 区域 | 作用 |
| --- | --- |
| 左上 **电源开关** | 课程总开关。开 = 开始轮询前台窗口；关 = 停轮询（进程还在，页面照常用） |
| 顶部 **轮询间隔** | 2000–120000 ms 可调，旁边有 3s/5s/10s/30s 快捷预设。改完立即生效 |
| **探测一次** | 不计时、不入库，立刻读一次当前前台窗口，用来验证「能不能认出来」（约 1.5 秒） |
| 左栏 **实时轮询** | 当前前台窗口、已识别的候选课程、按类型分色的轮询日志流（跟随/暂停滚动） |
| **总结当前** / **开始总结** | 立刻对当前候选做一次完整总结（即使开关是关的，用完自动停回去） |
| 右栏 **知识总结** | 学科树 → 点视频看知识点/思维导图/讨论焦点/Markdown 四种视图 |
| **文档** | 生成的 `.docx` 列表，可点下载 |
| 底栏 | 环境自检、投递状态；右下 **自检** 手动刷新 |
| 右上 **设置** | 稳定轮数、标题最短长度、模型、maxTokens、输出目录、插件路径、Python 路径 |

知识点前面有 `＋` 的可以点开，让 DeepSeek 就这一条展开讲（三段式：一句话解释 / 为什么重要 / 怎么用）。该功能需要在设置里打开 **深度讲解**。

## 它和 DeepSeek Harness 里的课程插件是什么关系

两者用的是**同一套课程插件代码**和**同一份知识地图目录**。所以：

- 应用会在启动时检查「这份知识地图最近有没有别人在写」。如果检测到 DSH 里的插件正在轮询，应用**不自动启动**，状态条会告诉你「已让出轮询权」，避免同一个视频被记录两遍。
- 想手动接管，点一下电源开关即可（会提示重复记录的风险）。
- 反过来，如果你在用这个应用轮询，建议到 DSH 那边关掉课程插件，或者让它指向别的输出目录。

一句话：**两个都用没问题，但同时开轮询会打架。** 想省心就只开一个。

## 输出文件在哪

默认是 `app/` 的**兄弟目录** `课程知识地图\`（可在设置里改）：

```
课程知识地图/
├── 课程总览.docx              所有学科的汇总大纲
├── <学科>/
│   └── 学习手册.docx          该学科累积的手册
├── 笔记/
│   └── 笔记-<标题>-<时间>.docx 单个视频的总结（真正投递到 DSH 会话的就是它）
└── .state/
    ├── state.json             已识别的学科与视频
    ├── manuals/<学科>.md      手册的 Markdown 源（界面读它）
    ├── poll.log               轮询日志（界面读它）
    ├── poll.ps1               读取前台窗口的 PowerShell 脚本
    ├── bridge.json            投递账本
    ├── bridge.heartbeat.json  投递心跳（判断 DSH 是否在跑）
    └── bridge.log             投递日志
```

> 界面的学科树以**磁盘上实际存在的手册**为准。如果 `state.json` 少了某个学科（两个轮询者互相覆盖时会这样），手册还在的话仍会列出来，并标上「仅手册」。

## 投递到 DSH 会话（可选）

生成本地 Word 文档不需要 DSH。但「把笔记投递到一个新的 DSH 会话」这一步只能由 DSH 里的 `dsh-course-bridge` 插件完成——它需要宿主提供的会话与文件上传服务，没有对外 HTTP 接口。

所以底栏的「投递」状态读的是 bridge 的心跳文件：

- **心跳新鲜** → DSH 在跑，投递链路正常
- **心跳过期** → DSH 没跑（或插件关了），此时只生成本地文档，不投递

## 环境变量与路径约定

| 用途 | 查找顺序 |
| --- | --- |
| 课程插件 `lib/index.js` | 设置里的路径 → `app/vendor/dsh-video-coursemap/lib/index.js`（内置） → `~/.dsh/profiles/*/node_modules/dsh-video-coursemap/lib/index.js`（desktop 优先） |
| Python（转 docx） | 设置里的路径 → `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe` → `python` → `python3` |
| DeepSeek 密钥 | 设置里的文件 → `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` |

密钥不会写进 `config.json`，也不会出现在页面上；如果找不到，状态栏会提示「未找到 DeepSeek 密钥」，总结功能降级为「只抓素材不写总结」。

想手动指定密钥，可以建一个只含一行的文件并在设置里指向它：

```
DEEPSEEK_API_KEY: sk-你的密钥
```

## 已知问题

- **只在 Windows 上测过并可用**：读前台窗口标题依赖 `powershell.exe` + Win32 `GetForegroundWindow`，其他平台需要自己替换 `lib/engine.mjs` 的 `probeForeground`。
- `poll.ps1` 单次调用约 **1.5–1.7 秒**（PowerShell 启动 + Add-Type 编译）。这是轮询间隔下限设为 2000ms 的原因，设更短只会让两次探测排队。
- 标题里含 emoji 时，早期转 docx 会因 GBK 编码报错。应用启动第一件事就设 `PYTHONIOENCODING=utf-8`，已修好；如果你绕过本应用直接调 `md2docx.py`，需要自己保证这个变量。
- `课程知识地图/.state/poll.log` 不会随每次轮询增长：同一个「进程+标题」只记一次，去重后才写。所以「日志没变」不代表「没在轮询」，要确认请用「探测一次」。
- 后台播放（浏览器窗口不在前台）识别不到，这是 Windows 前台窗口检测的固有限制。

## 开发者

```powershell
node --test "test/*.test.js"   # 跑全部测试
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1            # 创建桌面快捷方式
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1 -Uninstall # 删除
```

代码结构：

| 文件 | 职责 |
| --- | --- |
| `main.mjs` | 入口：设编码、抢锁、选端口、打印自检、优雅退出 |
| `server.mjs` | `node:http` 服务与全部 API、SSE 推送、静态文件、路径沙箱 |
| `lib/config.mjs` | 配置读写与逐项校验（中文报错）、可热改 / 需重建引擎的键划分 |
| `lib/engine.mjs` | 伪造宿主上下文、加载课程插件、启停重建、前台探测、外部轮询检测 |
| `lib/llm.mjs` | DeepSeek 流式客户端（读凭据、SSE 解析、模型探测） |
| `lib/store.mjs` | 读知识地图：state.json、手册切分、笔记列表、bridge 账本 |
| `lib/logs.mjs` | `poll.log` 解析与按类型归类 |
| `lib/deepsplit.mjs` | 笔记结构化、思维导图解析、知识点展开提示词 |
| `lib/paths.mjs` | 目录定位、插件自动发现（含内置 `vendor/`）、路径越界校验 |
| `lib/python.mjs` | Python 解释器探测 |
| `public/*` | 前端：`app.js` 交互、`md.js` Markdown 渲染、`app.css` 深色主题 |
| `vendor/dsh-video-coursemap/` | 内置的上游课程插件副本（MIT，见仓库根的 `THIRD-PARTY-NOTICES.md`） |

前端不用框架，纯 DOM；Markdown 与 mermaid mindmap 都是手写解析成 HTML/CSS，不引任何外部资源。

## 许可

MIT。内置的 `vendor/dsh-video-coursemap` 归上游作者所有，同样是 MIT，版权声明见仓库根的 `THIRD-PARTY-NOTICES.md`。
