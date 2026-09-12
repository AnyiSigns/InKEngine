/**
 * knowledge_gate 机制件契约声明（知识验证闸门三层组合）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——knowledge_gate 本体
 * 为零端口消费（effects 为空）：L1 准入（schema 校验 + 指令注入安全扫描 +
 * 最小功能测试）跑进程内 SchemaValidator/RuleEngine，L2 效果评估经注入的
 * KnowledgeExecutor 执行体（默认执行器同样是进程内规则引擎评估），L3 目标
 * 筛选与 L3 之上可选人工审核层均为注入回调解——不直接调 LLM 端口、不启
 * 外部进程、不经存储对象落库（判定只产出结果，落库由调用方决定）。
 *
 * depends 为空：knowledge_gate 不直接依赖任何其它机制件（schema/规则/样例
 * 均属 core 域）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../../dock/registry/contract_types.js';

/** 知识闸门机制契约：零机制间依赖，effects 为空（判定纯进程内）。 */
export const knowledge_gate_contract: MechanismContract = {
  id: 'knowledge_gate',
  contract: {
    effects: [],
  },
  depends: [],
};
