param(
  [string]$AppPath,
  [ValidateRange(1024, 65535)][int]$Port = 9222
)
$ErrorActionPreference = 'Stop'
$endpoint = "http://127.0.0.1:$Port"
try {
  $targets = Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 3
  if (@($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^tapnow://app(?:/|$)' }).Count -gt 0) {
    Write-Host "Tapnow 调试连接已就绪：$endpoint"
    exit 0
  }
  throw "端口 $Port 已由其他调试服务占用。请改用另一个端口。"
} catch {
  if ($_.Exception.Message -match '已由其他调试服务占用') { throw }
}
$listener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -gt 0) { throw "端口 $Port 已被占用，且未发现 Tapnow 调试页面。请检查端口或选择其他端口。" }
$running = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^tapnow(?:app)?\.exe$' })
if ($running.Count -gt 0) {
  throw 'Tapnow 正在运行但调试接口不可用。请先在应用中确认已保存并正常退出，再重新运行本脚本。本脚本不会强制结束或重启应用。'
}
if (-not $AppPath) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\TapNow\TapNow.exe",
    "$env:LOCALAPPDATA\Programs\tapnow\tapnow.exe",
    "$env:LOCALAPPDATA\TapNow\TapNow.exe",
    "$env:ProgramFiles\TapNow\TapNow.exe"
  )
  $AppPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $AppPath -or -not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
  throw '未找到 Tapnow.exe。请使用 -AppPath 指定快捷方式中的程序完整路径。'
}
$resolvedApp = (Resolve-Path -LiteralPath $AppPath).Path
if ([IO.Path]::GetExtension($resolvedApp) -ne '.exe') { throw 'AppPath 必须指向 Tapnow 可执行文件。' }
$arguments = @('--remote-debugging-address=127.0.0.1', "--remote-debugging-port=$Port", '--enable-desktop-devtools')
Start-Process -FilePath $resolvedApp -ArgumentList $arguments -WindowStyle Hidden | Out-Null
$deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $targets = Invoke-RestMethod -Uri "$endpoint/json/list" -TimeoutSec 2
    if (@($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^tapnow://app(?:/|$)' }).Count -gt 0) {
      Write-Host "Tapnow 调试连接已就绪：$endpoint。请在应用中打开目标画布。"
      exit 0
    }
  } catch { }
  Start-Sleep -Milliseconds 500
}
throw "Tapnow 已启动，但尚未发现主窗口调试页面。请检查版本、启动参数与端口：$endpoint/json/list"
