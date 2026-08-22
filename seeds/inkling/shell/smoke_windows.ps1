# InKling 桌面壳 Windows 真实启动冒烟脚本
#
# 用法（在 seeds/inkling/shell 目录下）:
#   powershell -ExecutionPolicy Bypass -File .\smoke_windows.ps1
#
# 前置: 前端产物已构建（frontend/dist 存在，npm --prefix ../frontend run build），
#       壳调试二进制已构建（生产形态，必须带 feature：
#       cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol；
#       缺 feature = dev 形态，WebView 恒连 devUrl → 无 dev server 即连接失败）。
#
# DPI 纪律（本脚本踩过的坑）：
#   系统 DPI ≠ 100% 时（如 125%），非 DPI 感知进程的 GetWindowRect 返回
#   虚拟化（逻辑）坐标，而 CopyFromScreen 按物理像素抓屏 → 截图偏移错位，
#   抓到的是窗口邻域的桌面（会误判为错误页/空白）。因此脚本入口先
#   SetProcessDPIAware()，让坐标全部走物理像素，截图 = 完整窗口。
#
# 断言策略（像素内容占比，亮/暗主题通用）：
#   以四角中位数采样为背景基准，统计差异显著像素占比。暗色主题下
#   hairline 边框 + 细等宽文字与背景差异约 12~28/通道（阈值取 12、
#   2px 密采样不漏 1px 边框线）；亮色主题下侧栏/卡片/弹层占比更高。
#   WebView 错误页/空白为纯底色 + 极少量灰字（<2%），可区分。
#
# 流程: 启动真实桌面进程 → 等待主窗口出现 → 前台置顶 → 截图 → 内容占比
#       断言 → WM_CLOSE 关闭 → 断言退出码 0 → smoke_out/（日志 + 截图）。
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
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
'@

# DPI 感知：坐标一律物理像素（防止截图错位抓到窗口邻域）
[InkSmoke.Native]::SetProcessDPIAware() | Out-Null

Add-Type -AssemblyName System.Drawing

# 内容占比：以「客户端区内部」四角背景补丁的中位数为背景基准，统计与
# 背景差异显著的像素占比。亮/暗主题通用：暗色主题下 hairline 边框 + 细
# 等宽文字与背景差异约 12~28/通道 → 阈值 12 + 2px 密采样（1px 边框线
# 不漏检）；亮色主题下侧栏/卡片/弹层占比更高。补丁避开支窗口边框/
# DWM 阴影/任务栏等窗口外元素（它们与 WebView 底色不同，四角采样被
# 污染 → 空白窗口也会误判为有内容）。错误页/空白为纯底色 + 极少量
# 灰字（<2%），可区分。
function Get-ContentRatio([string]$imagePath) {
    $bmp = New-Object System.Drawing.Bitmap($imagePath)
    $w = $bmp.Width
    $h = $bmp.Height
    # 窗口内容区内侧补丁（80px 内边距，避开边框/阴影/侧栏边缘）
    $inset = 80
    $insetRight = $w - $inset
    $insetBottom = $h - $inset
    $patches = @(
        , @($inset, $inset)
        , @($insetRight, $inset)
        , @($inset, $insetBottom)
        , @($insetRight, $insetBottom)
    )
    $vR = @(); $vG = @(); $vB = @()
    foreach ($p in $patches) {
        $pr = 0; $pg = 0; $pb = 0; $n = 0
        for ($py = $p[1]; $py -lt $p[1] + 12; $py += 3) {
            for ($px = $p[0]; $px -lt $p[0] + 12; $px += 3) {
                $c = $bmp.GetPixel($px, $py)
                $pr += $c.R; $pg += $c.G; $pb += $c.B; $n++
            }
        }
        $vR += $pr / $n; $vG += $pg / $n; $vB += $pb / $n
    }
    $rSorted = @($vR | Sort-Object); $gSorted = @($vG | Sort-Object); $bSorted = @($vB | Sort-Object)
    # 4 值中位数 = 中间两值的均值（抗单个补丁被内容/异色元素污染的异常）
    $bgR = ($rSorted[1] + $rSorted[2]) / 2
    $bgG = ($gSorted[1] + $gSorted[2]) / 2
    $bgB = ($bSorted[1] + $bSorted[2]) / 2
    $content = 0
    $total = 0
    # 只统计上半区（0~60% 高度），避开底部浮层（任务栏预览/重叠窗口会
    # 出现在客户端区底部，且与 UI 加载无关；UI 内容集中在上半区）
    $limitY = [int]($h * 0.6)
    for ($y = 0; $y -lt $limitY; $y += 2) {
        for ($x = 0; $x -lt $w; $x += 2) {
            $c = $bmp.GetPixel($x, $y)
            $total++
            if ([math]::Abs($c.R - $bgR) -gt 12 -or
                [math]::Abs($c.G - $bgG) -gt 12 -or
                [math]::Abs($c.B - $bgB) -gt 12) { $content++ }
        }
    }
    $bmp.Dispose()
    return [math]::Round($content / $total, 4)
}

if (-not (Test-Path $ExePath)) {
    Log "FAIL 壳二进制不存在: $ExePath（先 cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol）"
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

# 前台置顶后截图（DPI 感知下客户端区 = WebView 内容矩形，物理像素直取；
# 排除标题栏/DWM 阴影/任务栏等窗外元素——它们污染背景基准且不属于内容）
[InkSmoke.Native]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500
[InkSmoke.Native+RECT]$clientRect = New-Object InkSmoke.Native+RECT
if (-not [InkSmoke.Native]::GetClientRect($hwnd, [ref]$clientRect)) {
    Log "WARN GetClientRect 失败，跳过截图与内容断言"
} else {
    $clientPt = New-Object InkSmoke.Native+POINT
    $clientPt.X = 0; $clientPt.Y = 0
    [InkSmoke.Native]::ClientToScreen($hwnd, [ref]$clientPt) | Out-Null
    $w = $clientRect.Right - $clientRect.Left
    $h = $clientRect.Bottom - $clientRect.Top
    if ($w -gt 0 -and $h -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap($w, $h)
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($clientPt.X, $clientPt.Y, 0, 0, $bmp.Size)
        $shot = Join-Path $OutDir "window.png"
        $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose()
        $bmp.Dispose()
        Log "截图保存: $shot（${w}x$h @ $($clientPt.X),$($clientPt.Y)，客户端区）"

        # 内容级断言：以内容区内四角补丁中位数采样背景为准的内容像素占比——
        # InKling 三栏界面（文件树/会话面板/会话列表）在亮暗主题下文字/边框
        # 均显著异于背景（通常 >2%）；WebView 错误页（连接失败/空白）为纯底色
        # + 极少量灰字（<2%）。二者可区分，杜绝「窗口出现但界面没加载」漏检。
        $ratio = Get-ContentRatio $shot
        Log "内容占比=${ratio}（断言 > 0.02；错误页/空白 < 0.02）"
        if ($ratio -le 0.02) {
            Log "FAIL 窗口内容未加载（内容占比过低，疑似 WebView 错误页/空白）"
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
