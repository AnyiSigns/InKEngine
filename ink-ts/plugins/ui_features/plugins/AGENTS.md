# plugins（per-plugin AGENTS）

真 ui 面插件（设置面板）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置「插件」段（B4 收敛后的唯一插件管理面）：manifest 派生目录（壳侧 pluginsCatalog 座位）+ 现接线的管理动作——工具常驻必带（capability.baseline）、界面组件启停（ui_components）、服务启停（mcp.status/enable/disable，B5：MCP 服务端 = 工具型插件，启用即会话内装载 + 台账持久化 + 重启自动拉起，注册表可见 + request_tool 请求即绑）；其余插件实体只读（命令/端点装配面，agent 对话受控接入随 B6）。

## 数据从哪进 / 挂载

- 挂载 = 设置面板：不经布局树 $ref——spec data.settings_section 经生成器 settingsSections.generated.ts 派生清单引用，设置浮层读清单渲染左导航、内容 DynamicComponent name=插件 id（plugins）；真源注册同 pluginFaces.generated.ts。
- 数据：`@app/backend`（tools.full + capability.baseline / ui_components / mcp.status）+ `@app/pluginsCatalog`（derivePluginsCatalog：manifest 派生目录）。访问经 spec faces.ui.access store:["appBackend","pluginsCatalog"] 切片注入；壳外挂载/测试缺省回落自建 + derivePluginsCatalog()（不白屏）。
- 旧 tools_panel / mcp_market 面板于 B4 卸载；权限矩阵/自动审批 UI 退役。max_tool_rounds 迁入本面板（工具参数）。服务启停 = 既有命令面薄接线（不复制装载机制）。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。
