# 生成「课程助手」桌面快捷方式
#
# 用法（在 app 目录下）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-shortcut.ps1
#   加 -Uninstall 删除快捷方式
#
# 为什么快捷方式指向 .vbs 而不是 node.exe：直接指向 node.exe 会打开一个控制台窗口，
# 关掉窗口等于杀掉服务；指向 wscript + .vbs 则隐藏窗口启动，只留浏览器页面。
# 图标借用 Edge 或 PowerShell 的系统图标，避免额外的 .ico 文件。

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$Desktop
)

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $appDir '启动课程助手.vbs'

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "找不到启动器：$launcher"
}

# 桌面路径从系统取，不要写死 C:\Users\xxx\Desktop（可能被 OneDrive 重定向）
if (-not $Desktop) {
  $shell = New-Object -ComObject WScript.Shell
  $Desktop = $shell.SpecialFolders.Item('Desktop')
  if (-not $Desktop) {
    $Desktop = [Environment]::GetFolderPath('Desktop')
  }
}
if (-not (Test-Path -LiteralPath $Desktop)) {
  throw "桌面目录不存在：$Desktop"
}

$linkPath = Join-Path $Desktop '课程助手.lnk'

if ($Uninstall) {
  if (Test-Path -LiteralPath $linkPath) {
    Remove-Item -LiteralPath $linkPath -Force
    Write-Host "已删除快捷方式：$linkPath"
  } else {
    Write-Host "没有找到快捷方式：$linkPath"
  }
  return
}

# wscript.exe 走 System32，用环境变量拼，兼容 32/64 位
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript)) {
  throw "找不到 wscript.exe：$wscript"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath = $wscript
# 参数里路径含空格时必须自带引号
$shortcut.Arguments = '"' + $launcher + '"'
$shortcut.WorkingDirectory = $appDir
$shortcut.Description = '课程助手 —— 实时轮询前台课程视频并生成知识总结'
$shortcut.WindowStyle = 7  # 最小化启动（wscript 本身会隐藏 node 窗口）

# 图标：优先 Edge（浏览器类应用观感一致），退到 PowerShell，再退到 shell32
$iconSources = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe",
  "$env:SystemRoot\System32\shell32.dll"
)
foreach ($source in $iconSources) {
  if (Test-Path -LiteralPath $source) {
    $shortcut.IconLocation = "$source,0"
    break
  }
}

$shortcut.Save()
Write-Host "已创建快捷方式：$linkPath"
Write-Host "  目标：$wscript `"$launcher`""
Write-Host "  工作目录：$appDir"
Write-Host ''
Write-Host '双击桌面上的「课程助手」即可启动（不需要先打开 DeepSeek Harness）。'
Write-Host '停止服务：在任务管理器里结束 node.exe。'
