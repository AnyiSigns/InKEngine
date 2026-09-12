/**
 * 插件能力注册面：插件可贡献的注册类型集中声明口（计划 §4.2；PLUGINS.md §1 五面）。
 *
 * Dock.caps = 五面 tools / node_types / event_types / patch_kinds / ui_faces 的
 * 注册口径。本面按纪律只做整模块 star re-export（防对现经 star 导出的符号做具名
 * 子集致公共面快照 value↔type 翻转），收录 tools（声明式工具端点/定义/执行体
 * 注册、工具编排打分选择）与 event_types（事件类型注册表 + 演化事件规格，含内
 * 联整组导出者）四组：与 dock/index.ts 中同模块语句全等，符号集合不因本面增减。
 * 五面其余真源的现状口径：node_types 注册面（引擎内置节点 register_engine_node_types
 * 等）与 patch_kinds 词表（PATCH_KINDS/PatchKind 等，core/contracts/generated 组）、
 * ui_faces 数据面均以具名语句形式在 dock/index.ts「核心机制公开面」整组透传，
 * 不复制进本面；计划 §4.2 点名的 NodeTypeRegistry / HarnessRegistry /
 * RetrieverRegistry 三符号在现公共面无真源（不在 937 快照内），本轮不引入，
 * 推迟至其真正出口的波次。
 */

export * from '../core/declarative_tools/index.js';
export * from '../core/tool_orchestrator/tool_orchestrator.js';
export * from '../core/event_types/registry.js';
export * from '../core/event_types/eventTypeSpec.js';
