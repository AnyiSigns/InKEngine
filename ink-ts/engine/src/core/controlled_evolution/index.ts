/**
 * controlled_evolution 模块公共面（受控演化单一通道：提案形态 → 应用计划 →
 * 采纳前验证闸 → 受控应用 + 两条升格来源适配器：择优（pruning_adapter）与
 * 结晶（crystallize））。
 *
 * 纯数据面 + 注入执行（对齐 core/collab 的模块内导出模式）：engine/src/index.ts
 * 收口由主控统一接线，本 barrel 是该模块对外符号的唯一聚合点。
 */

export * from './evolution_proposal.js';
export * from './apply_plan.js';
export * from './adoption_gate.js';
export * from './controlled_applier.js';
export * from './pruning_adapter.js';
export * from './crystallize.js';
