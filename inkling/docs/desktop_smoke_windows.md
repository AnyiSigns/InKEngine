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
  → 截图 → 内容像素占比断言——「窗口出现」不再等于「界面加载」。

## 修订记录 v2：DPI 错位截图误判与主题无关断言（18:00 复验）

排查中发现的三类截图方法学缺陷，已在冒烟脚本修复：

1. **DPI 坐标错位（根因）**：系统 DPI = 125% 时，非 DPI 感知进程的
   `GetWindowRect` 返回虚拟化（逻辑）坐标，而 `CopyFromScreen` 按
   物理像素抓屏 → 截图偏移错位，抓到的是窗口邻域的桌面/壁纸区域
   （暗左亮右 + 彩色花瓣亮块，极易误判为 WebView 错误页插图）。
   修复：冒烟脚本入口 `SetProcessDPIAware()`，坐标一律物理像素。
2. **窗口外元素污染背景基准**：标题栏/DWM 阴影/任务栏浮层与 WebView
   底色不同，四角采样被污染 → 空白窗口也「内容占比≈1」假阳性。
   修复：改抓**客户端区**（GetClientRect + ClientToScreen，即 WebView
   内容矩形），内容占比只在**上半区**统计（UI 内容集中在上半区；
   底部浮层与 UI 加载无关），背景基准取内容区内四角补丁中位数。
3. **深色像素占比不适用浅色主题**：主题黑白跟随系统，浅色形态下
   界面为白底 + hairline 边框 + 细字，「深色占比 > 0.5」断言失效。
   改为**内容占比**（阈值 12/通道 + 2px 密采样），亮/暗主题通用；
   错误页/空白为纯底色 + 极少量灰字（<2%），可区分。

## 冒烟流程与结果（复验 18:00，v2 断言）

| 步骤 | 结果 |
|---|---|
| 进程启动（Start-Process，工作目录=exe 目录模拟双击） | pid=10016 |
| 主窗口出现（MainWindowHandle 轮询） | 0x905AA（<1s） |
| 内容渲染等待（3s） | OK |
| 窗口前台置顶 + 截图（客户端区，物理坐标） | `shell/smoke_out/window.png`（1375x950） |
| 内容级断言：上半区内容像素占比（内容区补丁中位数基准，阈值 12） | **0.0326**（>0.02 通过） |
| 窗口归属校验（GetWindowThreadProcessId） | owner = 壳进程 |
| WM_CLOSE 关闭 | 进程退出 |
| 退出码 | 0（PASS） |

截图确认三栏布局完整渲染（文件树 / 消息流 / 会话列表，浅色主题形态）。

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
