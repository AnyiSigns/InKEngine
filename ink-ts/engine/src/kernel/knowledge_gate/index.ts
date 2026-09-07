/**
 * 知识验证闸门公开面（knowledge_gate.py __all__ 镜像）。
 *
 * 三层组合：L1 准入（schema 校验 + 指令注入安全扫描 + 最小功能测试）→
 * L2 效果评估（完整样例非谈判项，规则条目经规则引擎执行）→ L3 目标筛选
 * （不差于旧版且至少一维严格优于/多样性保留）；L3 之上可选人工审核层
 * （默认弹卡可关，宿主接入审核卡 UI 时注入真实实现）。导出集合严格对齐
 * Python __all__：结果形态（GateL1/L2/L3Result）、默认 L2 执行器
 * （GateL2FixtureExecutor）、执行器/审核者 seam（KnowledgeExecutor/
 * HumanReviewer）、组合入口（KnowledgeGate）、默认弹卡策略
 * （ReviewCardPolicy）与公开注入扫描入口（scan_text_injection）。
 */

export { GateL1Result } from './_results.js';
export { GateL2Result } from './_results.js';
export { GateL3Result } from './_results.js';
export { GateL2FixtureExecutor } from './_executor.js';
export type { KnowledgeExecutor } from './_executor.js';
export { ReviewCardPolicy } from './_review.js';
export type { HumanReviewer } from './_review.js';
export { KnowledgeGate } from './knowledge_gate.js';
export type { KnowledgeGateOptions } from './knowledge_gate.js';
export { scan_text_injection } from './_injection.js';
