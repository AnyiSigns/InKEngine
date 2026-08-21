# 桌面壳 Windows 真实启动冒烟记录（2026-08-22）

> 前置：shell 契约测试 27/27 全绿（17 执行器契约 + 9 MCP 协议 + 1 lib）；
> 本记录补真实桌面启动验证——进程/窗口/截图/退出码全链。
> 复跑：`powershell -ExecutionPolicy Bypass -File seeds/inkling/shell/smoke_windows.ps1`
> （需先 `cargo build --manifest-path seeds/inkling/shell/src-tauri/Cargo.toml`
> 与 `npm --prefix seeds/inkling/frontend run build`）。

## 环境

- 系统：Windows（x64）
- 壳：`inkling_shell`（Tauri 2，debug 构建，8m14s 首次编译）
- 前端：`frontend/dist`（`npm run build`：tsc 零错 + vite 产物 245KB js）
- 窗口规格（tauri.conf.json）：1100x760（实际 1114x798 含边框）

## 冒烟流程与结果

| 步骤 | 结果 |
|---|---|
| 进程启动（Start-Process） | pid=12644 |
| 主窗口出现（MainWindowHandle 轮询） | 0x20068A（<1s） |
| 窗口前台置顶 + 截图 | `shell/smoke_out/window.png`（1114x798） |
| 窗口归属校验（GetWindowThreadProcessId） | owner = 壳进程 |
| WM_CLOSE 关闭 | 进程退出 |
| 退出码 | 0（PASS） |

## 装配语义（真实进程内验证）

窗口出现即证明真实装配成功（任一环节失败 = 启动拒绝，fail-closed）：

- 工具声明解析：`fixtures/tools_os.json`（include_str 内嵌数据）；
- 执行器注册契约校验：声明 ↔ 执行器签名一致才放行（不一致 = 启动失败）；
- 托盘 + 系统通知 + 文件挂载授权状态初始化；
- WebView 加载 `frontend/dist`（生产形态产物，非 dev server）。

设备感知 server（stdio JSON-RPC）的协议行为由契约测试覆盖（免真实桌面），
真实进程内执行器注册路径经本次冒烟验证。

## 产物

- `shell/smoke_windows.ps1`：可复跑冒烟脚本（窗口轮询/截图/WM_CLOSE/退出码断言）；
- `shell/smoke_out/`：本次运行的 `smoke.log` + `window.png`（本地产物，不入库）。
