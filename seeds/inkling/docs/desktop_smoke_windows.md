# 桌面壳 Windows 真实启动冒烟记录（2026-08-22）

> 前置：shell 契约测试 27/27 全绿（17 执行器契约 + 9 MCP 协议 + 1 lib）；
> 本记录补真实桌面启动验证——进程/窗口/内容/截图/退出码全链。
> 复跑：`powershell -ExecutionPolicy Bypass -File seeds/inkling/shell/smoke_windows.ps1`
> （需先 `cargo build --manifest-path seeds/inkling/shell/src-tauri/Cargo.toml
> --features custom-protocol` 与 `npm --prefix seeds/inkling/frontend run build`）。

## 环境

- 系统：Windows（x64）
- 壳：`inkling_shell`（Tauri 2，debug 构建 + `custom-protocol` 生产形态）
- 前端：`frontend/dist`（`npm run build`：tsc 零错 + vite 产物 245KB js）
- 窗口规格（tauri.conf.json）：1100x760（实际 1114x798 含边框）

## 修订记录：初版冒烟漏检与根因修复

初版冒烟（07:44）只断言「窗口出现 + 退出码 0」，实际窗口内是 WebView
错误页而非真实界面——漏检。用户手动打开反馈「连接失败」后排查根因：

1. **dev 形态误构建**：Tauri 的 dev 判定 = `!custom-protocol`（tauri
   build.rs 内嵌逻辑）。Cargo.toml 未声明 `custom-protocol` feature →
   任何 `cargo build` 都产出 dev 形态 exe，WebView 恒连 `devUrl`
   （localhost:5176），dev server 未运行即显示连接失败；
2. **frontendDist 路径错误**：`"../frontend/dist"` 相对 src-tauri 解析为
   `shell/frontend/dist`（不存在）——dev 模式从不检查该路径，问题
   被掩盖，开启 custom-protocol 后编译期即暴露。

修复：

- `Cargo.toml` 声明 `[features] custom-protocol = ["tauri/custom-protocol"]`，
  生产构建显式 `--features custom-protocol`；
- `tauri.conf.json` 的 `frontendDist` 更正为 `"../../frontend/dist"`；
- 冒烟脚本升级**内容级断言**：窗口出现后等 3 秒（WebView 渲染窗口）
  → 截图 → 深色像素占比断言（InKling 深色主题 > 0.5；白底错误页
  < 0.1）——「窗口出现」不再等于「界面加载」。

## 冒烟流程与结果（复验 16:34，修复后）

| 步骤 | 结果 |
|---|---|
| 进程启动（Start-Process，工作目录=exe 目录模拟双击） | pid=5012 |
| 主窗口出现（MainWindowHandle 轮询） | 0xD058C（<1s） |
| 内容渲染等待（3s） | OK |
| 窗口前台置顶 + 截图 | `shell/smoke_out/window.png`（1114x798） |
| 内容级断言：深色像素占比 | **0.941**（>0.5 通过；错误页为白底 <0.1） |
| 窗口归属校验（GetWindowThreadProcessId） | owner = 壳进程 |
| WM_CLOSE 关闭 | 进程退出 |
| 退出码 | 0（PASS） |

## 装配语义（真实进程内验证）

窗口出现 + 深色界面断言即证明真实装配成功（任一环节失败 = 启动拒绝，
fail-closed）：

- 工具声明解析：`fixtures/tools_os.json`（include_str 内嵌数据）；
- 执行器注册契约校验：声明 ↔ 执行器签名一致才放行（不一致 = 启动失败）；
- 托盘 + 系统通知 + 文件挂载授权状态初始化；
- WebView 加载 `frontend/dist` 生产形态产物（不依赖 dev server；
  验证时 5176 端口未监听，界面仍正常加载）。

设备感知 server（stdio JSON-RPC）的协议行为由契约测试覆盖（免真实桌面），
真实进程内执行器注册路径经本次冒烟验证。

## 产物

- `shell/smoke_windows.ps1`：可复跑冒烟脚本（窗口轮询/内容断言/截图/
  WM_CLOSE/退出码）；
- `shell/smoke_out/`：本次运行的 `smoke.log` + `window.png`（本地产物，不入库）。
