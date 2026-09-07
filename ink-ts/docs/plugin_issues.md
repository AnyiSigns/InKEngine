# ink-ts 插件化文档问题卡（plugin_issues.md）

> 评审问题 + 决策留痕。2026-09-07 首次评审（PLUGINS.md × component_data_endgame.md）
> 收敛的决策项均已裁决并**同步回填两份主文档**；本卡为可追溯记录，不回填实施进度。
> 主契约：`PLUGINS.md`；设计推演/计划：`docs/component_data_endgame.md`。

## 已裁决项（2026-09-07）

| # | 问题 | 决策 | 落点 |
|---|---|---|---|
| 1 | 宿主 spec 份数矛盾：设计 §五「四份」（含 IDE）vs 参考模拟「三份」 | **四份并列 spec**：tauri / cli / web / ide 各一份 `host.spec`（IDE 不再只是 surface 枚举值，拥有独立 spec 文件），`HostFaces.surface` 标识各自宿主身份 | component_data §三/§4.3/§五/参考模拟 §1/§5/终局语、PLUGINS HostFaces.surface |
| 2 | 插件物理布局冲突：PLUGINS `faces/{ui,logic,data}/`+`impl/` 嵌套 vs 设计 §4.1 平铺 ui.tsx/logic.ts | **以 PLUGINS.md 嵌套格式为准**：`spec.json` + `faces/{ui,logic,data}/`（face 目录内含实现 + 同目录 `*.test.ts(x)`）+ `impl/` + `locale/`；测试随 face/impl 同目录并列 | component_data §4.1/§4.3/参考模拟 §3、PLUGINS §1 分发格式 |
| 3 | host.spec 用 `faces.ports/transport/surface/approval`，与 CapabilityComponent `faces={ui,logic,data}` 不匹配 | **kind='host' 保持 CapabilityComponent 身份**，faces 类型用专用 `HostFaces`（ports/transport/surface/approval，surface 四值 tauri/web/cli/ide）；非独立顶层类型 | PLUGINS §1 `FaceUnion`/`HostFaces`、component_data §五/参考模拟 §2/§5 |
| 4 | verify 脚本清单冲突：主 §六第 5 项「文案/token 有源」 vs PLUGINS/参考模拟第 5 项「语义标签端到端」 | **5 项 verify 定版**：domains / io / mount / unload / semantics（语义标签端到端，CODING.md §11）；「文案/token 有源」挪进 checklist（§六 item 3） | component_data §六、PLUGINS §3 已一致 |
| 5 | `docs/subsystems/` 文档数不一致：§4.3 五份（含 exec.md）vs 参考模拟四份 | **五份**：engine / plugins / renderer / host / exec（参考模拟补 exec.md） | component_data §4.3 树 + 参考模拟 §1 树 |
| 6 | `seed_data/event_types.json` 未进任何散源收敛清单 | **属引擎/渲染协议侧事件类型真源，不进 `plugins/`**；web 命令面生成物（`web_command_surface.json`）属派生视图禁手改 | component_data §三 边界注 |
| 7 | 低优遗留：§1.2 伪码 `impl` 字段 vs 规范类型；两树详略/现状目标标注；plugin_issues.md 未落盘 | **低优按推荐一并修订**：§1.2 伪码对齐规范（去 impl、补 id/faces 说明）；§4.3 树标注「目标态」并补 manifest.json/hosts spec；本卡落盘 | component_data §1.2/§4.3、本文件 |

## 引擎层 AGENTS 用语

设计目标态引擎目录为 `kernel/`（机制契约化后归此，现状 `core/`），故目标态
AGENTS.md 依赖方向统一写 **`kernel→adapters 单向`**（现状落点仍 core，见 §九）；
PLUGINS.md §3 机制件契约化归 `engine/src/kernel/<mechanism>/` 与此一致。

## 阶段 1 实施时须现场核对

- §2.1 机制件清单以概念名列举（gate/audit/patch_chain…），当前 core 实际目录为
  `audit_log/`、`patch/`、approval 等；契约化样板落 `kernel/<mechanism>/` 时按真实代码目录对齐命名，勿照抄概念名建目录。
