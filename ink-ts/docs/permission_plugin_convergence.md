# 权限档位与插件管理收敛设计（定稿 2026-09-09）

定位：把「弹卡（审批）档位」「工具/插件管理」「MCP」收敛为单一产品语义。
范围：ink-ts（web 壳 chrome + plugins 源 + engine 审批面）为主，文档先行、
数据面 kind 迁移单独批次。改 gated 语义文档须同步跑 gate。

## 决策清单（用户定案）

### A. 对话输入框三档统一治理所有弹卡
- 输入框提供 `auto / review / deny` 三档（review = 默认）。
- `review`：需确认调用一律弹卡（现状）。
- `auto`：需确认调用免弹直过；缺准入（出厂 deny / 破坏类）**自动授予**（自动转正，
  补丁链/受控通道落位，全量审计 + 可回退）。
- `deny`：需确认调用免问直拒。
- **机制校验不是档位**：沙箱边界/越界/L2 vetting/域外操作在任何档都执行、不被跳过。
- 生效粒度：会话级可切（默认档记宿主设置，会话内临时切换只对本会话生效）——定稿默认此项。
- 推翻「工具 tab 档位切换是设计」：逐工具档位/权限矩阵/自动审批清单 UI 全部退役。

### B. 设置段收敛为唯一「插件」tab
- 卸载设置段 `tools_panel`（工具）与 `mcp_market`（MCP 市场）；新建 `plugins` 段。
- 保留的管理动作：启停、常驻必带 baseline、凭据/排障兜底、恢复全部默认（逃生）。
- MCP 市场浏览/「添加市场条目」功能删除；市场条目降级为可直接启用的工具型插件或
  「指定安装（url/command）」入口产物。
- 插件管理主路径在对话：agent 经受控管理工具接入/停用插件（review 弹卡 / auto 自动），
  UI 插件 tab = 同一注册表的人类视图，不产生第二套插件体系。

### C. 插件模型：唯一实体，MCP 不是插件类型
- 用户/agent 可见层面只有「插件」一个实体：可装/启停/回退，带版本与依赖；
  提供物 = 工具 / 命令 / UI。
- `kind`（8 值）仅在引擎内部作装载路由（声明式 / exec / mcp_process），UI 不呈现
  kind 分组、不设 kind 专属开关。
- MCP 服务端 = **工具型插件**：内部经 MCP 协议装载（stdio/http；npx/uvx/pip 安装后
  自动拉起），启用 → 其工具自动进工具列表（source 徽标），停用 → 工具消失/进程回收。
  **无「MCP 插件类型」、无「MCP 总开关」。**
- `plugins/endpoints/mcp`（内置 `ink_ts_mcp` 二进制，承载 exec/shell profile）= 装配
  基础设施，与外部 MCP 接入无关，装配只读展示。
- agent 侧插件管理与 UI 插件 tab 共享同一受控注册表：接入/启停经 propose 类工具 +
  审批分级（外部服务端默认 review/L2）+ GuardedStorage/补丁链落位 + 审计 + 回退。
- protected 禁停集（机制必需命令/入口：回合发送、审批裁决、审计/恢复、search/request、
  布局容器、设置浮层、agent_input）不可停；恢复默认一键永远可用。

## 概念词表（锁死，防第二份真相）

| 词 | 定义 |
|---|---|
| 插件 | 唯一可装/启停/回退实体；提供物 = 工具/命令/UI |
| 工具型插件 | 提供工具集；装载实现可为声明式、exec 端点、或 MCP（对用户不可见） |
| MCP 服务端 | 工具型插件的内部装载来源（连接配置），不是插件类型 |
| 内置 MCP 端点 | `ink_ts_mcp` 原生二进制（exec/shell profile），装配基础设施 |
| 弹卡档位 | 输入框 auto/review/deny，治理「需确认调用」的裁定姿态 |

## 落地状态栏（随批次回填）

| 改动点 | 现状（引用） | 目标 | 状态 |
|---|---|---|---|
| 输入框三档 UI + 会话档数据 | agent_input/faces/ui/InputBar.tsx（现有模型/推理档位） | 新增 auto/review/deny 选择，随发送携带并持久 | 已实现（B2） |
| engine 审批姿态注入 | DefaultInterruptPolicy / approval adapter | 支持 pose auto/review/deny + 自动转正 + deny 免问直拒 | 已实现（B3） |
| 退役权限矩阵/自动审批 UI | tools_panel/faces/ui/ToolsPanel.tsx（TIER_OPTIONS allow/review 等） | 删除 | 已实现（B4）：tools_panel/mcp_market 面板插件删除，web @app/backend setTierOverrides/setAutoApprove + renderer securityTierOverridesSet 移除（capability 桥命令面留 B5/B6） |
| 设置段合并 | settingsSections.generated.ts（mcp_market order10 / tools_panel order20） | 单「插件」段（生成物，真源改 spec） | 已实现（B4）：plugins 段 order10 承接，12 设置段 |
| MCP 市场命令面 | hosts bridge mcp.market/mount/unmount、backend getMcpMarket | 退役/改造为 plugin 启停 | 已实现（B5）：市场命令面退役，bridge 改为 mcp.status/enable/disable（plugins/commands 目录同步改名）；mcp.enable = 会话内装载（connect+import_tools+声明式注册+索引刷新），mcp.disable = 注销+索引摘除+断连回收；host 台账 `mcp_plugins_enabled`（capability.json）持久化 + boot 自动拉起（fail-closed 只记状态） |
| MCP 服务端 → 工具型插件 | plugins/mcp/market.*（kind='mcp'，premounted=false，mount_policy 挂载链） | 概念/UI 先收敛；数据面 kind 迁移单独批次 | 部分实现（B5）：启用即装载为工具型插件语义落地（注册表可见 + request_tool 请求即绑，不进常驻注入集）；plugins/mcp/<id>/spec.json = 连接配置真源（候选目录扫描）。kind 仍为 'mcp'、market.json 派生视图保留，数据面 kind 迁移单独批次 |
| agent 侧插件管理工具集 | self_tools/propose 工具面 | 扩展：检索插件/指定安装/启停/回退 | 已实现（B6）：plugin_command 端点族（host 声明式接线，session_command 模式）——plugin.catalog（只读目录快照：mcp 候选/组件/常驻集）、plugin.mcp.enable/disable/install/remove、plugin.components.set、plugin.baseline.set；经统一流水线 pose 三档决后由宿主执行体真写 |
| protected 禁停集 + 恢复默认 | — | 生效 | 已实现（B6）：engine UI_COMPONENTS_PROTECTED（agent_input/review_card/settings_floater/message_list）set_ui_components_disabled 整批拒绝 + 装载过滤；ui_components.get 带 protected 回显。恢复设置默认 = recovery.settings_reset（confirm 'settings-default'）——常驻必带回出厂（reset_baseline_names）、组件停用清空、MCP 全停+清台账（含 mcp_plugins_extra）、capability.reset 回缺省 |
| MCP 指定安装（url/command 入口） | plugins/mcp/market.*（候选） | 指定安装入口产物不删空（防 MCP 死能力） | 已实现（B6）：McpPluginService.install/remove + host 台账 mcp_plugins_extra（capability.json），与内置候选同构装载（connect→import→注册→索引），不写 plugins 源/生成物 |
| 本文档所属语义文档同步 | PLUGINS.md / component_data_endgame.md | 词表收敛 | 待做（收尾） |

## 批次计划（顺序执行，避免生成物冲突）

- **B1** 本定稿 + 决策记忆 + 词表概念落文档（PLUGINS.md / component_data_endgame.md 标迁移点）。验证：无代码改动。✅✅
- **B2** 输入框三档 UI + 会话档数据（hosts/web chrome + agent_input + capability 会话级 pose）。验证：`vitest run --root plugins`、`vitest run --root hosts/web`、tsc。✅
- **B3** engine 审批姿态：host policy → approval adapter 支持 pose（auto 直过/自动转正；deny 免问直拒；机制校验不受影响）+ 单测。验证：`vitest run --root engine` + 架构门禁。✅
- **B4** 插件 tab 合并：新建 plugins/ui_features/plugins 面板 → 卸载 tools_panel/mcp_market（verify_unload --plan 先查阻断）→ 重跑 sync_plugin_manifest.mjs；删除权限矩阵/自动审批 UI。验证：root 门禁 + hosts/web 测试。✅（2026-09-09：plugins 面板 = manifest 派生目录 pluginsCatalog + 常驻必带/界面组件启停/服务挂载动作 + max_tool_rounds；148 插件/24 真 ui 面/12 设置段；权限矩阵/自动审批/市场浏览 UI 退役）
- **B5** MCP 市场命令面退役 + MCP 工具型插件装载（启用即注册、自动拉起、schema 刷新、生命周期）。验证：hosts/lib 测试 + live 冒烟。✅（2026-09-09：命令面 mcp.market/mount/unmount → mcp.status/enable/disable；hosts/lib McpPluginService（mcp/plugin.ts）会话内装载 + capability 台账持久化 + boot restore 自动拉起 + 工具索引 remove seam（engine ToolVectorIndex.remove/Runtime.remove_tool_index）；renderer/web/cli 适配迁移；hosts/lib 全量门禁/verify/各包测试全绿，live 冒烟并入收尾）
- **B6** agent 侧插件管理工具 + protected 禁停集 + 恢复默认逃生。验证：engine + hosts 全量 + 产品出厂自检路径。✅（2026-09-09：plugin_command 工具族 7 工具（plugins/tools/plugin.* 真源 + hosts/lib/src/plugin_command.ts 接线 + createHost 注册）；engine UI_COMPONENTS_PROTECTED 禁停集 + ui_protected_components + reset_baseline_names；McpPluginService.install/remove + mcp_plugins_extra 额外连接台账（桥 mcp.install/mcp.remove）；recovery.settings_reset + capability.store.reset + audit 面板「恢复设置默认」块（确认词 fail-closed）；158 插件 = tool 45 + mcp 5 + command 71 + ui_feature 34 + endpoint 3；engine 2363 + hosts/web/plugins/cli 全绿 + gate/verify 全 PASS）
- **收尾** 总核：文档回填落地状态栏、记忆定稿、live 冒烟（`.dev-data/kilo-cli` 真链路）。

## 风险与边界
- B4/B5 都动 plugins 源 + 生成物，必须串行、每批跑生成器与 verify。
- auto 自动转正 = 用户全权委托：只靠机制校验 + 审计 + 可回退兜底，需在 UI/文案明示。
- 「指定安装」入口不能删空，否则 MCP 死能力。
