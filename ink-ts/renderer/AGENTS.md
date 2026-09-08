# renderer 渲染器契约（AGENTS.md）

renderer = **显示设备库**（@ink-ts/renderer，阶段 2 起纯库）：React/TS 只渲染
数据（ui_spec 数据树 + 事件流）与触发补丁，不定义契约、不写业务。详细定位/
目录/别名见 `docs/subsystems/renderer.md`（跨层权威）与 CODING §1。

## 本包放什么

- `src/renderer/`：渲染机制（UIRenderer/bootRenderer/componentRegistry/
  channelWhitelist/themeTokens/bind/event·stateChannel/validation/
  mediaRegistry/messageRendererRegistry/designTokens/themeMode…）；
- `src/shared/`：显示通用资产（backendAdapter 契约与 transport、session 运行时
  数据面、ui 原语、markdown/charts/media/labels/upload/logger…）；
- `src/components/`：内置组件/浮层（floaters、ui_spec_editor、index 出厂注册）；
- `src/i18n/`、`src/locales/`：useT 与文案（产品壳当前共用；目标态 locale 随
  插件走）。
- 测试：`test/` 镜像 src（src/test 分离；门禁 src-test 拒绝 src 内 .test）。

## 不放在这里（已迁 hosts/web 产品壳）

- App/main/activate/state/shell/productView/views/AppBackend——产品 chrome 与
  「宿主数据/动作 → 显示设备」装配（阶段 2 迁出，勿迁回）；
- 插件注册生成物 pluginFaces/settingsSections.generated.ts（住
  hosts/web/src/app/，装配期写入设备注册表）；
- index.html/index.css 外壳与 vite dev/build（产品壳 hosts/web 承载）。

## 依赖纪律（硬约束）

- 单向：hosts/web → renderer；设备代码禁出现 `@app`/`../hosts/` 等指向产品壳
  或引擎/插件包的 import；不 import `@ink-ts/engine`。
- 别名 `@` = renderer/src（设备资产），`@app` = hosts/web/src/app（壳资产）——
  新增资产归属改变时同步 hosts/web 与 plugins 的 tsconfig/vitest 别名。
- 白名单注册制：组件渲染/绑定通道/主题 token 均白名单放行；未放行拒绝渲染
  或占位（fail-closed），禁绕过。
- 样式走语义 token/designTokens，禁硬编码颜色。

## 验证命令

- `tsc -p renderer/tsconfig.json`、`vitest run --root renderer`
- 跨壳对码（白名单 × 插件 faces × 旧侧 identity）在 `hosts/web/test` 跑
  （root `npm test` 全链收口）
