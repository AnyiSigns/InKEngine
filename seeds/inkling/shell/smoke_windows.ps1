# InKling 桌面壳 Windows 真实启动冒烟脚本

# 用法（在 seeds/inkling/shell 目录下）:
#   powershell -ExecutionPolicy Bypass -File .\smoke_windows.ps1
#
# 前置: 前端产物已构建（frontend/dist 存在，npm --prefix ../frontend run build），
#       壳调试二进制已构建（cargo build --manifest-path src-tauri/Cargo.toml）。
#
# 流程: 启动真实桌面进程 → 等待主窗口出现 → 前台置顶截图 → WM_CLOSE 关闭 →
#       断言退出码 0 → 冒烟记录写 smoke_out/（日志 + 截图）。
param(
    [string]$ExePath = (Join-Path $PSScriptRoot "src-tauri\target\debug\inkling_shell.exe"),
    [string]$OutDir = ".\smoke_out",
    [int]$WaitSeconds = 60
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null | Out-Null
$logPath = Join-Path $OutDir "smoke.log"
function Log([string]$msg) {
    $line = "$(Get-Date -Format 'HH:mm:ss.fff') $msg"
    $line | Tee-Object -FilePath $logPath -Append
}

Add-Type -Namespace InkSmoke -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

Add-Type -AssemblyName System.Drawing

function Get-DarkRatio([string]$imagePath) {
    $bmp = New-Object System.Drawing.Bitmap($imagePath)
    $dark = 0
    $total = 0
    for ($y = 0; $y -lt $bmp.Height; $y += 4) {
        for ($x = 0; $x -lt $bmp.Width; $x += 4) {
            $c = $bmp.GetPixel($x, $y)
            $total++
            if ($c.R -lt 60 -and $c.G -lt 60 -and $c.B -lt 60) { $dark++ }
        }
    }
    $bmp.Dispose()
    return [math]::Round($dark / $total, 3)
}

if (-not (Test-Path $ExePath)) {
    Log "FAIL 壳二进制不存在: $ExePath（先 cargo build --manifest-path src-tauri/Cargo.toml）"
    exit 1
}
if (-not (Test-Path (Join-Path $PSScriptRoot "..\frontend\dist\index.html"))) {
    Log "FAIL 前端产物缺失（先 npm --prefix ../frontend run build）"
    exit 1
}

$proc = Start-Process -FilePath $ExePath -PassThru
Log "启动 pid=$($proc.Id) exe=$ExePath"

# 等待主窗口出现（Tauri 壳装配：声明解析 → 执行器注册 → 托盘 → 窗口显示）
$hwnd = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    $proc.Refresh()
    if ($proc.HasExited) { break }
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $hwnd = $proc.MainWindowHandle
        break
    }
    Start-Sleep -Milliseconds 500
}

if ($hwnd -eq [IntPtr]::Zero) {
    Log "FAIL 主窗口未出现（exited=$($proc.HasExited) code=$(if ($proc.HasExited) { $proc.ExitCode } else { 'running' })）"
    if (-not $proc.HasExited) { $proc.Kill() }
    exit 1
}
Log "主窗口句柄=0x$($hwnd.ToString('X'))"

# 内容加载窗口：WebView 需要时间渲染前端产物，过早截图只能拍到空白
# 或错误页（连接失败），无法证明界面真实加载
Start-Sleep -Seconds 3

# 前台置顶后截图（窗口矩形 → CopyFromScreen）
[InkSmoke.Native+RECT]$rect = New-Object InkSmoke.Native+RECT
if (-not [InkSmoke.Native]::GetWindowRect($hwnd, [ref]$rect)) {
    Log "WARN GetWindowRect 失败，跳过截图与内容断言"
} else {
    [InkSmoke.Native]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 500
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -gt 0 -and $h -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
        $shot = Join-Path $OutDir "window.png"
        $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose()
        $bmp.Dispose()
        Log "截图保存: $shot（${w}x$h @ $($rect.Left),$($rect.Top)）"

        # 内容级断言：InKling 前端为深色主题——真实界面深色像素占比应
        # 显著（>50%）；WebView 错误页（连接失败/空白）为白底（深色
        # 占比 <10%）。二者可区分，杜绝「窗口出现但界面没加载」漏检。
        $ratio = Get-DarkRatio $shot
        Log "深色占比=${ratio}（断言 > 0.5；白底错误页 < 0.1）"
        if ($ratio -le 0.5) {
            Log "FAIL 窗口内容未加载（深色占比过低，疑似 WebView 错误页/空白）"
            if (-not $proc.HasExited) { $proc.Kill() }
            exit 1
        }
    }
}

# 窗口归属校验（防误关其他进程窗口）
$ownerPid = 0
[InkSmoke.Native]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) | Out-Null
if ($ownerPid -ne $proc.Id) {
    Log "FAIL 窗口不属于本进程（owner=$ownerPid, proc=$($proc.Id)），不做关闭"
    if (-not $proc.HasExited) { $proc.Kill() }
    exit 1
}

# WM_CLOSE 关闭主窗口 → 壳退出（默认行为：最后窗口关闭即退出）
[InkSmoke.Native]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Log "已发送 WM_CLOSE，等待退出"
$proc.WaitForExit()
Log "退出码=$($proc.ExitCode)"
if ($proc.ExitCode -ne 0) {
    Log "FAIL 退出码非 0"
    exit 1
}
Log "PASS 桌面壳真实启动冒烟通过"
exit 0
