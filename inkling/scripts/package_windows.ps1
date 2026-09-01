# InKling Windows 发行打包脚本（嵌入式 Python runtime + 模型随包 + NSIS）
#
# 用法（仓库根目录执行）:
#   powershell -ExecutionPolicy Bypass -File .\inkling\scripts\package_windows.ps1
#
# 产物:
#   inkling/shell/src-tauri/resources/   随包资源（python runtime / granite-97m /
#                                        ink_engine 引擎包 / inkling 种子根 / exec 二进制）
#   inkling/shell/src-tauri/target/release/inkling_shell.exe
#   inkling/shell/src-tauri/target/release/bundle/nsis/*.exe   （NSIS 安装包）
#
# 前置:
#   - 仓库根 .venv 存在（PYO3_PYTHON 编译期解释器；与内嵌 runtime 同版本）
#   - ink_engine 引擎包纯标准库（零运行时依赖），随包整体拷贝
#   - 本机有网络（python.org 下载 embed runtime；首次运行）
#
# 平台: 本脚本只产 Windows 安装包；macOS dmg 由 CI/发布机按同款
# resources 结构 + tauri build --bundles dmg 产出（Linux 不入首发）。

param(
    [string]$PythonVersion = "3.14.0",
    [switch]$SkipRuntimeDownload,
    [switch]$SkipNsis,
    [string]$Proxy = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # 仓库根
$res = Join-Path $root "inkling\shell\src-tauri\resources"

# 代理透传（tauri-cli 的下载客户端不走浏览器系统代理；本机 Clash 类
# 场景须显式给 HTTPS_PROXY/HTTP_PROXY，否则 GitHub 工具链下载超时）
if ($Proxy) {
    $env:HTTPS_PROXY = $Proxy
    $env:HTTP_PROXY = $Proxy
    $env:ALL_PROXY = $Proxy
    Log "代理已启用: $Proxy"
}

function Log([string]$msg) {
    Write-Host "[package] $msg"
}

New-Item -ItemType Directory -Force -Path $res | Out-Null

# ── 1. 嵌入式 Python runtime（python.org embed 发行包）──────────────
$rtDir = Join-Path $res "python"
$rtDll = Join-Path $rtDir "python3*.dll"
if (-not (Get-ChildItem $rtDll -ErrorAction SilentlyContinue)) {
    if ($SkipRuntimeDownload) {
        Log "SKIP 运行时下载被跳过且未就位: $rtDir"
    } else {
        $zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
        if (-not (Test-Path $zip)) {
            $url = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
            Log "下载嵌入式 Python runtime: $url"
            Invoke-WebRequest -Uri $url -OutFile $zip
        }
        Log "解包 runtime -> $rtDir"
        New-Item -ItemType Directory -Force -Path $rtDir | Out-Null
        Expand-Archive -Path $zip -DestinationPath $rtDir -Force
        # 出厂 ._pth：标准库 zip（确切文件名，非通配）+ DLL 同目录
        # （引擎路径由壳装配期注入）；._pth 固定 sys.path，独立于
        # PYTHONHOME/PYTHONPATH 环境（发行形态的确定性路径解析）
        $pth = Get-ChildItem (Join-Path $rtDir "python3*._pth") | Select-Object -First 1
        if ($pth) {
            $zipFull = $pth.BaseName  # python314（版本段与 zip 同基名）
            Set-Content -Path $pth.FullName -Value "$zipFull.zip`n.`n" -Encoding Ascii
            Log "重写 ._pth: $zipFull.zip"
        }
    }
} else {
    Log "OK 运行时已就位（跳过下载）"
}

# ── 1.5 出厂第三方依赖（site-packages 随包安装）──────────────────────
$sitePkg = Join-Path $rtDir "Lib\site-packages"
$venvPy = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path (Join-Path $sitePkg "mcp\__init__.py"))) {
    Log "安装出厂运行时依赖（pip install --target site-packages）"
    New-Item -ItemType Directory -Force -Path $sitePkg | Out-Null
    & $venvPy -m pip install --target $sitePkg --only-binary=:all: `
        -r (Join-Path $PSScriptRoot "requirements-runtime.txt")
    if ($LASTEXITCODE -ne 0) { throw "出厂依赖安装失败" }
} else {
    Log "OK 出厂依赖已就位"
}

# ── 2. 引擎包（源 ink_engine/ 现场拷贝 + 内容哈希校验，漂移即失败）──
# 发行真源 = 仓库源 ink_engine/（resources 不再长期驻留陈旧副本）：
# 每次打包强制从源重新拷贝（删除旧副本后全量重建），并以源文件清单
# 的 SHA256 校验副本——任一源文件缺失/内容漂移 = 打包失败（双真源
# 纪律：副本只是发布期快照，快照与源不一致绝不允许进发行包）。
$engineDir = Join-Path $res "ink_engine"
$engineSrc = Join-Path $root "ink_engine"
Log "拷贝引擎包（源 -> $engineDir；哈希校验）"
if (Test-Path $engineDir) {
    Remove-Item -LiteralPath $engineDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
robocopy $engineSrc $engineDir /E /XD __pycache__ .venv target /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "引擎包拷贝失败（robocopy 退出码 $LASTEXITCODE）" }
$srcFiles = Get-ChildItem -LiteralPath $engineSrc -Recurse -File |
    Where-Object { $_.FullName -notmatch "__pycache__" -and $_.FullName -notmatch "\\\.venv\\" -and $_.FullName -notmatch "\\target\\" }
$mismatches = 0
foreach ($file in $srcFiles) {
    $rel = $file.FullName.Substring($engineSrc.Length).TrimStart("\")
    $dst = Join-Path $engineDir $rel
    if (-not (Test-Path -LiteralPath $dst)) {
        Log "  漂移: 副本缺文件 $rel"
        $mismatches++
        continue
    }
    $srcHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    $dstHash = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) {
        Log "  漂移: 文件内容不一致 $rel"
        $mismatches++
    }
}
if ($mismatches -gt 0) { throw "引擎包副本与源不一致（$mismatches 处漂移）——发行包禁止携带漂移副本" }
Log "OK 引擎包校验通过（$($srcFiles.Count) 个文件哈希一致）"

# ── 3. 种子根（seed_data + manifest）───────────────────────────────
$seedDir = Join-Path $res "inkling"
if (-not (Test-Path (Join-Path $seedDir "seed_data\tools.json"))) {
    Log "拷贝种子根 -> $seedDir"
    New-Item -ItemType Directory -Force -Path $seedDir | Out-Null
    Copy-Item (Join-Path $root "inkling\seed_data") $seedDir -Recurse -Force
    Copy-Item (Join-Path $root "inkling\manifest.json") $seedDir -Force
} else {
    Log "OK 种子根已就位"
}

# ── 4. 向量模型（granite-97m，98MB ONNX + tokenizer）───────────────
$modelDir = Join-Path $res "granite-97m"
if (-not (Test-Path (Join-Path $modelDir "model_quint8_avx2.onnx"))) {
    Log "拷贝向量模型 -> $modelDir"
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    Copy-Item (Join-Path $root "inkling\models\granite-97m\*") $modelDir -Recurse -Force
} else {
    Log "OK 向量模型已就位"
}
# 模型许可随模型分发（Apache-2.0，取自仓库规范副本；models/ 目录不入库）
Copy-Item (Join-Path $root "inkling\licenses\Apache-2.0.txt") (Join-Path $modelDir "LICENSE") -Force

# ── 5. exec 执行件（release 构建 + 随包拷贝）────────────────────────
$execBin = Join-Path $res "exec\inkling_exec.exe"
if (-not (Test-Path $execBin)) {
    Log "构建 exec 执行件（release）"
    Push-Location (Join-Path $root "inkling\exec")
    cargo build --release | Out-Null
    Pop-Location
    New-Item -ItemType Directory -Force -Path (Join-Path $res "exec") | Out-Null
    Copy-Item (Join-Path $root "inkling\exec\target\release\inkling_exec.exe") $execBin -Force
} else {
    Log "OK exec 执行件已就位"
}

# ── 5.5 第三方组件声明与许可证（发行合规：随包分发）──────────────────
$noticeDest = Join-Path $res "THIRD_PARTY_NOTICES.md"
if (-not (Test-Path $noticeDest)) {
    Log "拷贝第三方组件声明与许可证 -> $res"
    Copy-Item (Join-Path $root "inkling\THIRD_PARTY_NOTICES.md") $noticeDest -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $res "licenses") | Out-Null
    Copy-Item (Join-Path $root "inkling\licenses\*") (Join-Path $res "licenses") -Recurse -Force
} else {
    Log "OK 第三方组件声明与许可证已就位"
}

# ── 6. 前端产物 ─────────────────────────────────────────────────────
$dist = Join-Path $root "inkling\frontend\dist\index.html"
if (-not (Test-Path $dist)) {
    Log "构建前端产物（npm run build）"
    Push-Location (Join-Path $root "inkling\frontend")
    npm run build | Out-Null
    Pop-Location
} else {
    Log "OK 前端产物已就位"
}

# ── 7. 壳 release 构建（生产形态：内嵌资产 + 随包资源）──────────────
Log "构建壳 release（--features custom-protocol）"
Push-Location (Join-Path $root "inkling\shell\src-tauri")
cargo build --release --features custom-protocol
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "壳 release 构建失败" }
Pop-Location

# ── 7.5 解释器 DLL 装载位：可执行文件同目录副本 ──────────────────────
# 壳二进制在进程装载期即解析 python3xx.dll 导入表（早于任何代码），
# 故运行时 DLL 必须与 exe 并列（NSIS 安装形态经 hooks.nsh 的
# POSTINSTALL 复制；本步覆盖未走安装器形态的裸产物目录）。
$exeDir = Join-Path $root "inkling\shell\src-tauri\target\release"
Copy-Item (Join-Path $res "python\python314.dll") (Join-Path $exeDir "python314.dll") -Force
Log "OK 解释器 DLL 已复制到 exe 同目录"

# ── 8. NSIS 安装包（tauri-cli；缺失时给出指引）──────────────────────
if ($SkipNsis) {
    Log "SKIP NSIS（-SkipNsis）；resources + release 产物已就绪"
} else {
    $npx = Get-Command npx -ErrorAction SilentlyContinue
    if ($npx) {
        Log "打包 NSIS 安装包（npx @tauri-apps/cli build）"
        Push-Location (Join-Path $root "inkling\shell\src-tauri")
        npx --yes @tauri-apps/cli@2 build
        Pop-Location
        if ($LASTEXITCODE -ne 0) { throw "NSIS 打包失败" }
    } else {
        Log "SKIP NSIS（无 npx；手工执行: cd inkling/shell/src-tauri && npx @tauri-apps/cli@2 build）"
    }
}

Log "打包完成"
Log "  资源:   $res"
Log "  壳:     $(Join-Path $root 'inkling\shell\src-tauri\target\release\inkling_shell.exe')"
if (Test-Path (Join-Path $root "inkling\shell\src-tauri\target\release\bundle")) {
    Get-ChildItem (Join-Path $root "inkling\shell\src-tauri\target\release\bundle") -Recurse -Filter *.exe |
        ForEach-Object { Log "  安装包: $($_.FullName)" }
}
