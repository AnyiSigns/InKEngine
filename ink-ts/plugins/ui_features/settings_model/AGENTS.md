# settings_model（per-plugin AGENTS）

真 ui 面插件（设置面板）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置「模型」段：模型档案/角色挑选（agent/router 槽）/模型配置面。

## 数据从哪进 / 挂载

- 挂载 = 设置面板：不经布局树 $ref——spec data.settings_section 经生成器 settingsSections.generated.ts（住 hosts/web/src/app/settings/）settings 派生清单引用，设置浮层读清单渲染左导航、内容 DynamicComponent name=插件 id（settings_model）；真源注册同 pluginFaces.generated.ts。
- 数据：chrome 模型面（models/agentModelId）或 @app/backend 共享数据面（角色档写经 capability/model 命令）；serve 未接线 = dev 夹具兜底。
- 只读展示 + 档位选择出口，模型配置语义见 engine 角色槽（CODING §8）。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。
