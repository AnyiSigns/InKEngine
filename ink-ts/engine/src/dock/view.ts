/**
 * 渲染对接面：渲染器对接引擎的口径声明面（计划 §4.4：stream / data / bind /
 * actions 通道口径）。
 *
 * Dock.view 收录 data/bind/actions 口径真源 ui_schema（三层白名单校验/渲染器
 * seam）整模块 star re-export：与 dock/index.ts 中同模块语句全等，符号集合不
 * 因本面增减（面文件禁具名子集，防公共面快照 value↔type 翻转）。stream 面
 * 事件封套（EngineEvent/EngineTransport/CollectorTransport 协议组）与事件展示
 * 聚合器（DisplayStreamCollector/DisplayMessage）现为具名整语句（该模块还导出
 * 未公共符号，不做整模块 star），随「事件协议/事件展示聚合器」组保留在
 * dock/index.ts，本面不复制；渲染器保持零 engine import（消费事件封套 +
 * execution.run 回执投影 + ui_spec），本面只作类型口径导出，不改渲染器。
 */

export * from '../model/ui_schema/uiSchema.js';
