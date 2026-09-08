# plugins 层（docs/subsystems/plugins.md）

**层权威**：改插件先读本文件 + `plugins/AGENTS.md`（就近，目录约定与 spec
契约）；跨层契约见 `PLUGINS.md`（§1 分发格式/三档/机制闭集红线）。

## 定位

插件源 = **能力数据单元（CapabilityComponent）统一真源**（声明驱动装载的
唯一手改处）。plugins/ 只产「数据声明 + 随声明的独占实现面（faces/impl）」，
不产运行时服务；一切装载/消费（host 命令面、mcp 市场、工具聚合、web 产品壳
真 ui 面、exec 端点声明）都从 plugins 真源派生。

## 目录形态

```
plugins/
├─ AGENTS.md                 # 就近权威（手改纪律 + spec 契约 + per-plugin 政策）
├─ <kind>/<id>/              # kind ∈ tool|command|ui_feature|endpoint|mcp|...
│   ├─ spec.json             # 机器可读声明（行为唯一事实源）
│   ├─ AGENTS.md             # 真面/样板插件：是什么能力、能碰什么端口、数据从哪进
│   ├─ faces/{ui,logic,data}/# 真面独占实现 + 同目录 *.test.ts(x)
│   ├─ impl/                 # 执行体/配置（随 kind 需要）
│   └─ locale/               # 文案跟插件走（目标态）
├─ manifest.json             # 派生视图（生成物禁手改；verify:plugin-manifest）
└─ ui.generated.json         # 产品主壳布局派生视图（生成物禁手改）
```

派生视图共 7 份（scripts/sync_plugin_manifest.mjs 统一生成 + `--check` 逐字
比对，禁手改）：

| 派生物 | 路径 | 消费方 |
|---|---|---|
| manifest.json | plugins/ | hosts/web 壳夹具、host mcp.market、tools_os 夹具、self_check data 门禁 |
| ui.generated.json | plugins/ | hosts/web 产品壳布局（UISpec 同构） |
| commands.generated.ts | hosts/lib/src/bridge/ | host 命令面域元组 |
| ui_canonical.generated.ts | hosts/lib/src/bridge/ | host 配方界面白名单 |
| native.generated.ts | hosts/lib/src/exec/ | binary.ts 端点按声明定位 |
| pluginFaces.generated.ts | hosts/web/src/app/ | hosts/web 壳装配注册真 ui 面进显示设备 |
| settingsSections.generated.ts | hosts/web/src/app/settings/ | 设置浮层导航清单 |

## 分层语义（本层如何被消费）

- **hosts/lib（装配库）**：装配期读 plugins 派生视图/源，face loader 按声明
  装载 logic face（target=host，如 doc_parse）。
- **hosts/cli（进程）**：serve 把 ui.generated 布局与命令面供给呈现面。
- **hosts/web（产品壳）**：装配期 `registerPluginFaces()`（生成物）静态 import
  各真 ui 面 entry 注册进显示设备 componentRegistry；设置浮层读 settings 清单。
- **renderer（显示设备）**：不感知 plugins 具体包，只按注册名渲染
  componentRegistry 已注册组件（宿主壳负责注册）。
- 插件 faces 的 import 别名：`@` = renderer/src（显示设备资产/数据面）、
  `@app` = hosts/web/src/app（产品壳资产：productView/AppBackend/views 等）——
  两别名由 hosts/web 与 plugins 的 vite/vitest 配置各自声明，新增资产归属须
  同步两侧（含各包 tsconfig paths）。

## per-plugin AGENTS 政策

- **data-only 插件**（tools/commands/mcp 多数：无独占实现面）：**不设**
  per-plugin AGENTS——`spec.json` 是行为唯一事实源，防止行为文案第二份漂移。
- **真面/样板插件**（faces/ 带独占实现，或对外有边界契约需文字说明）：
  **必配** `AGENTS.md`，随 spec.json 同目录；内容只写「意图/边界/数据从哪进/
  能碰什么端口」，不重复 spec.json 的声明字段。
- 现行覆盖（2026-09-08 全量补建）：`tools/doc_parse`（host logic face 样板）、
  `ui_features/` 全部 25 个真 ui 面插件（canonical 布局叶子 12 + 设置面板 13，
  含 file_tree / settings_general 样板与 settings_floater 浮层壳；ledger_view
  已随 records/ledger 移除，故叶子由 13→12）；data-only
  commands/tools/mcp 与无真面 ui 容器免写（spec.json 即权威）。
- 真面许可：capability=external_tool、`REAL_FACE_BUILTINS` 白名单（doc_parse）
  与 ui_feature 组件节点 isUiComponent（canonical 叶子/设置面板/浮层）——
  增删白名单须同步 verify_unload.ts 与 plugins/AGENTS.md。

## 验证

- 改任一 spec → 重跑 `node plugins/scripts/sync_plugin_manifest.mjs`（或
  `--check`）；删除插件须先跑
  `tsx plugins/scripts/verify_unload.ts --plan <id>` 看阻断方（fail-closed）。
- `vitest run --config plugins/vitest.config.ts`（faces/ui 走 jsdom + RTL、
  faces/logic 走 node）；gate json-valid 扫 `plugins/**`。
