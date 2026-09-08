# renderer 层（docs/subsystems/renderer.md）

**层权威**：改 renderer 先读本文件 + `renderer/AGENTS.md`；包物理形态/别名见
CODING §1；hosts/web 侧关系见 hosts/AGENTS.md 与 host.md。

## 定位

`renderer/` = **显示设备库**（npm 包 `@ink-ts/renderer`，阶段 2 起纯库）：
React/TS 只渲染数据（ui_spec 数据树 + 事件流）并触发补丁，**不写业务、不定义
契约**。显示设备不自知具体产品与插件——组件按注册名渲染，注册表内容由宿主
壳装配期注入。

```
renderer/
├─ AGENTS.md            # 就近权威（渲染器契约）
├─ src/
│   ├─ renderer/        # 渲染机制：UIRenderer/bootRenderer/componentRegistry/
│   │                   #   channelWhitelist/themeTokens/eventChannel/stateChannel/
│   │                   #   bindSource/validation/uiSpecTypes/mediaRegistry/
│   │                   #   messageRendererRegistry/designTokens/themeMode/...
│   ├─ shared/          # 显示通用资产：backendAdapter 契约与 transport、
│   │                   #   session 运行时（channelHub/sessionStore/eventIngest/
│   │                   #   eventTypes/taskState...）、ui 原语（Button/Card/Field/
│   │                   #   cn/devMode/uiStateStore）、markdown/charts/media/
│   │                   #   labels/upload 等（hosts/web 与插件 faces 共用）
│   ├─ components/      # 内置组件/浮层（floaters、ui_spec_editor、index 出厂注册）
│   ├─ i18n/ locales/   # useT + 文案包（产品壳当前共用；目标态 locale 随插件走）
├─ test/                # 设备 vitest（与 src 路径镜像）
└─ vite.config.ts       # vitest 运行配置（无 dev/build：产品壳在 hosts/web）
```

## 分层语义与别名

- renderer 是**纯库**：无 index.html/main/vite dev、无进程（服务承载方 =
  cli serve）；被 `hosts/web` 与插件 faces（经 alias `@`）import。
- 别名双根（本包、hosts/web、plugins 三侧 vitest/tsconfig 同构声明）：
  `@` = renderer/src（设备资产），`@app` = hosts/web/src/app（产品壳资产）。
  设备代码禁出现 `@app` 或任何指向 hosts/ 的 import（壳→设备单向）。
- 渲染协议：spec 组件节点经 bind 通道（`state.*`/`events.*`）取数/订阅，
  通道白名单 = channelWhitelist；未注册组件渲染占位拒绝（不执行）；损坏
  ui_spec 回落基线布局不崩溃。
- 主题 token 白名单 = themeTokens（同源 ui_spec.theme）；样式经语义 token
  类/designTokens，禁硬编码颜色（hardcodedColors 测试守门）。

## 边界（renderer 不做什么）

- 不承载产品 chrome：App/activate/state/shell/productView/views/AppBackend 属
  `hosts/web` 产品壳（阶段 2 迁出）；壳负责「会话数据/机制动作 → 装配进
  UIRenderer 的 product chrome」。
- 不注册具体插件面：pluginFaces/settingsSections 生成物在 hosts/web 壳，
  装配期 registerPluginFaces 写入设备 componentRegistry。
- 不 import engine 包、不读 plugins/manifest（跨层数据一律经壳或运行时通道）。
- 不持有会话业务状态：channelHub/sessionStore 为**设备运行时数据面**（注入给
  UIRenderer），归属仍在本包，但业务聚合逻辑（如切会话恢复）在壳侧。

## 验证

- `tsc -p renderer/tsconfig.json`（typecheck 无 emit）与
  `vitest run --root renderer`（jsdom + RTL，src/test 分离）。
- renderer 的跨壳对码测试（白名单 ↔ 插件 faces ↔ 旧侧 identity manifest）随
  产品壳测试在 `hosts/web/test`（whitelistGate.test.ts），root `npm test` 全链跑。
- 代码行数/UTF-8/词汇纪律由 gate 扫描（CODING §7）。
