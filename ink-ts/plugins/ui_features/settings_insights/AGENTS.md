# settings_insights（per-plugin AGENTS）

真 ui 面插件（设置面板）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置「洞察」段：运行态洞察统计（事件流经 device 数据面归约呈现）。

## 数据从哪进 / 挂载

- 挂载 = 设置面板：不经布局树 $ref——spec data.settings_section 经生成器 settingsSections.generated.ts（住 hosts/web/src/app/settings/）settings 派生清单引用，设置浮层读清单渲染左导航、内容 DynamicComponent name=插件 id（settings_insights）；真源注册同 pluginFaces.generated.ts。
- 数据：@shared/session 运行时数据面（channelHub/eventIngest 流订阅）汇总洞察；只读统计，不触发回合。
- 接入（声明式）：faces.ui.access store:["backend"]（见 spec.json）——审计历史底账经壳注入的共享 BackendAdapter（audit.list）；实时事件流直订阅 serve 通道；壳外挂载/测试缺省回落自建实例（不白屏）。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。
