# workspace_auth（per-plugin AGENTS）

真 ui 面插件（设置面板）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置「工作区」授权段：工作区/挂载点授权与撤销（原生目录选择），声明接入共享 AppBackend（自建单例随声明式接入收口）。

## 数据从哪进 / 挂载

- 挂载 = 设置面板：不经布局树 $ref——spec data.settings_section 经生成器 settingsSections.generated.ts（住 hosts/web/src/app/settings/）settings 派生清单引用，设置浮层读清单渲染左导航、内容 DynamicComponent name=插件 id（workspace_auth）；真源注册同 pluginFaces.generated.ts。
- 数据：@app/backend（workspace.state/set/revoke、mount 清单、openDirectoryDialog）；无宿主 = 本地状态降级记录。
- 接入（声明式）：faces.ui.access store:["appBackend"]（见 spec.json）——壳 settings_floater 经 sliceUiAccess 按声明切片注入共享 AppBackend 为顶层 props；壳外挂载/测试缺省回落自建实例（不白屏）。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。
