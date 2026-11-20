# 每日自动赚取微软积分

每天登录 Windows 后自动打开 Edge，用真实键入的方式搜索，把当日 Microsoft Rewards 搜索
积分刷满（当前上限 15 分，每次 +3），然后关闭浏览器。窗口在跑起来后会最小化，不打扰你。

代码在 `tools/rewards-auto/`，零第三方依赖，只用 Node 内置模块。

## 快速开始

```powershell
cd tools\rewards-auto

# 1. 先看看 Edge 现在的状态，只读不启动（不会动浏览器）
node run.mjs --preflight-only --verbose

# 2. 立即跑一次（当日已满会直接退出）
node run.mjs --verbose

# 3. 装成计划任务：每次登录 2 分钟后启动，之后每 30 分钟重试，最多 2 小时
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1

# 4. 装完立刻触发一次，确认端到端可用
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1 -RunNow
```

卸载：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall
```

## 它是怎么工作的

关键约束都是在这台机器上实测出来的，不是猜的：

1. **登录态必须用真实 profile。** 复制一份 `User Data` 不行 —— Edge 的 App-Bound 加密
   把 cookie 绑在原始 profile 身份上，复制出来的 `v20` cookie 解不开，页面直接显示未登录。
2. **junction 绕过调试端口限制。** Chromium 136+ 拒绝 `--remote-debugging-port` 加
   `--user-data-dir` 指向默认 profile 字面路径。把同一目录通过 NTFS junction
   （`%LOCALAPPDATA%\ms-rewards-auto\udlink`）挂进来，字面路径变了就放行，底层仍是
   真实已登录 profile。
3. **必须有可见窗口。** headless 下 UA 是 `HeadlessChrome`，Rewards 一分不给。
   所以用有头窗口启动，attach 之后 `Emulation.setFocusEmulationEnabled` +
   `Browser.setWindowBounds{minimized}` 最小化，实测最小化后仍然计分。
4. **必须真实键入。** `Page.navigate` 直接打开 `/search?q=` 也会请求
   `reportActivity`，但积分不涨。只有逐字符 `Input.dispatchKeyEvent` + Enter
   才被认作有效搜索，所以脚本走的是"聚焦搜索框 → 逐字键入 → 回车"。
5. **模拟键盘操作前必须先退出正在运行的 Edge。** 默认 profile 被占用时，第二个实例的
   调试端口永远打不开。

## 判定与兜底

- **已经满了**：读到 `PCSearch` 进度等于上限就不再搜索，几秒内退出（`already-full`）。
- **当天已经赚过就不再开浏览器**：成功刷满时会往
  `%LOCALAPPDATA%\ms-rewards-auto\state.json` 写一个当日标记。之后每 30 分钟的重试
  看到这个标记就直接退出，**不会启动 Edge**，也就不会出现"浏览器莫名弹出又关掉"。
  用 `--force` 可以无视标记强制跑一轮。
- **你自己在用 Edge**：只要有一个可见窗口，本轮就跳过（`skipped-edge-busy`），
  交给 30 分钟后的下一次重试；只有全在后台跑的 Edge 进程才会被结束掉。
- **连搜两次都不加分**：判定为后端不再给这个会话计分，停止并记 `no-progress`，
  不会无意义地刷下去。
- **状态读不到**：flyout 接口刚导航完可能还没填好计数器，会自动重试几次；
  仍然读不到才报错。

所有结局都写进 `%LOCALAPPDATA%\ms-rewards-auto\logs\run-<时间>.jsonl`，最后一行是
`summary`，带状态、余额变化、进度变化和搜索次数。

## 退出码

| 状态 | 退出码 | 含义 |
| --- | --- | --- |
| `ok` / `already-full` / `skipped-edge-busy` / `closed-with-extra-targets` | 0 | 本轮该做的做完了 |
| `not-signed-in` / `no-progress` / `failed` / `edge-left-running` | 1 | 没做成，日志里有原因 |

## 配置

可选，放在 `%LOCALAPPDATA%\ms-rewards-auto\config.json`，只需写要改的键：

```json
{
  "maxSearchesPerRun": 6,
  "port": 9333,
  "minimize": true
}
```

文件损坏或不是对象时会回落到默认值并在日志里记一条警告，不会让整次运行失败。

与"当日已满标记"相关的两个键：`useDailyState`（默认 `true`，设为 `false` 就每轮都真
去启动浏览器确认）和 `stateFile`（默认 `%LOCALAPPDATA%\ms-rewards-auto\state.json`）。
标记只在读到满额且本轮状态正常时才写，`failed`、`no-progress`、`not-signed-in`、
`skipped-edge-busy` 都不会写，所以坏掉的一天不会被静默跳过。

标记只在**当天 00:30 之后**才会被信任。刚过午夜时微软的计数器可能还没重置，这时如果
盲信昨天留下的 15/15，会把新的一天整天跳过，代价太大。
时间相关（登录后延迟、重试间隔、重试总时长）改 `scripts/install-task.ps1 -Delay/-Repeat/-Duration`
或直接改 `lib/task.mjs` 的默认值后重装任务。

## 需要知道的限制与风险

- **可能违反 Microsoft Rewards 使用条款。** 自动化搜索不是官方支持的行为，账号有被
  判定异常、积分清零的可能。脚本已经尽量贴近真人（有头窗口、真实键入、随机间隔、
  不重复查询），但**不承诺零风险**。
- **计分规则由微软控制。** 每天上限、每次多少分、`PCSearch` 计数器和 flyout 响应结构
  随时可能改。上限变了不用改代码（按 `pointProgressMax` 自适应），但如果连续两次搜不出
  分，`no-progress` 就是改版的信号。
- **用真实 profile，没有隔离。** 跑的时候 Edge 用的是你日常那个 profile，所以不额外
  加 `--headless`、也不改地区参数（改成国际版也仍会落回 `cn.bing.com`）。
- **需要保持登录。** 注销、换账号、清 cookie 之后要人工重新登录一次，否则会记
  `not-signed-in`。
- **需要 Node 22 以上在 PATH 里**（用了全局 `WebSocket`）。计划任务通过 `launch.vbs`
  隐藏窗口启动，找不到 node 会弹一个消息框提示。

## 安全红线

`udlink` 是指向真实 Edge profile 的 junction。**删它只能用 `cmd /c rmdir`**，
绝不能用 `Remove-Item -Recurse` 或 `fs.rmSync(..., {recursive:true})`——
递归删除会顺着 junction 把真实浏览器数据一起删掉。`install-task.ps1 -Uninstall` 和
`lib/edge.mjs` 的 `removeJunction` 都会先确认目标确实是 reparse point 再动手。

## 测试

```powershell
cd tools\rewards-auto
npm test
```

纯函数部分（响应解析、查询挑选、进程判定、配置合并、日志、任务 XML、当日标记）都有测试，
不需要启动浏览器，也不碰真实 profile。
