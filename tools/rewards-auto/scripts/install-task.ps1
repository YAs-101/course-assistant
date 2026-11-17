# 安装 / 卸载 / 立即运行「每日自动赚取微软积分」计划任务
#
# 为什么需要这个脚本，而不是一条 schtasks 命令：
#   - schtasks /Create /SC ONLOGON 不带 /RU 会报 Access is denied（非管理员）；
#   - Register-ScheduledTask 同样 Access is denied；
#   - 唯一可行的是 /Create /XML，但 XML 里的 UserId 必须是完整 SID，
#     写短用户名 SA 会报 "No mapping between account names and security IDs"。
# 所以这里先取当前用户 SID，再用 node 生成 XML，最后交给 schtasks。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1
#   ... -RunNow        # 安装后立刻跑一次
#   ... -Uninstall     # 删除任务并拆掉 profile 联接

[CmdletBinding()]
param(
  [switch]$RunNow,
  [switch]$Uninstall,
  [string]$TaskName = 'MSRewards-AutoDaily'
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $here
$taskModule = Join-Path $root 'lib\task.mjs'
$vbsPath = Join-Path $root 'launch.vbs'

$stateDir = Join-Path $env:LOCALAPPDATA 'ms-rewards-auto'
$xmlPath = Join-Path $stateDir 'task.xml'
$linkPath = Join-Path $stateDir 'udlink'

function Invoke-Node {
  param([string[]]$NodeArgs)
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) { throw '找不到 node.exe，请安装 Node.js 22 以上版本。' }
  & $node.Source @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "node 退出码 $LASTEXITCODE" }
}

# ── 卸载 ──────────────────────────────────────────────────────
if ($Uninstall) {
  $query = & schtasks /Query /TN $TaskName 2>&1
  if ($LASTEXITCODE -eq 0) {
    & schtasks /Delete /TN $TaskName /F | Out-Null
    Write-Host "已删除计划任务：$TaskName"
  } else {
    Write-Host "计划任务不存在，跳过：$TaskName"
  }

  # 只允许 rmdir 拆联接。递归删除会穿透 junction 删掉真实 Edge profile。
  if (Test-Path $linkPath) {
    $item = Get-Item $linkPath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      & cmd /c rmdir $linkPath
      Write-Host "已拆除 profile 联接：$linkPath"
    } else {
      Write-Warning "$linkPath 不是联接（reparse point），为安全起见不删除。"
    }
  }
  exit 0
}

# ── 安装 ──────────────────────────────────────────────────────
if (-not (Test-Path $taskModule)) { throw "找不到 $taskModule" }
if (-not (Test-Path $vbsPath)) { throw "找不到 $vbsPath" }

# SID 必须来自当前登录用户：计划任务以 InteractiveToken 身份运行，
# 只有登录用户自己的 SID 才能匹配。
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $sid) { throw '取不到当前用户 SID。' }
Write-Host "当前用户 SID：$sid"

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
Invoke-Node @(
  $taskModule, '--write', $xmlPath,
  '--sid', $sid,
  '--vbs', $vbsPath,
  '--wscript', $wscript
)
Write-Host "已生成任务 XML：$xmlPath"

$created = & schtasks /Create /TN $TaskName /XML $xmlPath /F 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "schtasks /Create 失败（退出码 $LASTEXITCODE）：$created"
}
Write-Host $created

# 校验：Query /XML 里应当能看到登录触发器与 30 分钟重复。
# 注意：schtasks 的输出是多行数组，-match 对数组会返回"匹配的行"，
# 直接放进 if 永远为真。必须先拼成一个字符串再判断。
$check = (& schtasks /Query /TN $TaskName /XML 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0) { throw "任务已创建但查询失败：$check" }
if ($check -notmatch '<LogonTrigger>') { throw '校验失败：任务里没有登录触发器。' }
if ($check -notmatch '<Interval>PT30M</Interval>') { throw '校验失败：任务里没有 30 分钟重复间隔。' }
Write-Host '校验通过：登录触发器 + PT30M 重复 + 无管理员权限。'

if ($RunNow) {
  & schtasks /Run /TN $TaskName | Out-Host
  Write-Host '已触发一次运行，日志在 %LOCALAPPDATA%\ms-rewards-auto\logs\ 下。'
}
