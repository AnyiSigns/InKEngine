# settings_connect（per-plugin AGENTS）

真 ui 面插件（设置面板）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置「连接」段：服务连接/传输通道展示与配置（serve 通道形态）。

## 数据从哪进 / 挂载

- 挂载 = 设置面板：不经布局树 $ref——spec data.settings_section 经生成器 settingsSections.generated.ts（住 hosts/web/src/app/settings/）settings 派生清单引用，设置浮层读清单渲染左导航、内容 DynamicComponent name=插件 id（settings_connect）；真源注册同 pluginFaces.generated.ts。
- 数据：@app/backend 共享数据面（连接态读）+ 设备 transport（serve 通道装配）；dev 夹具兜底。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。
