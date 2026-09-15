/**
 * evolve/ 单一管线门面（受控进化唯一栈：观察 → 提案 → 闸 → 应用 → 补丁链）。
 *
 * ▍受控通道单一化
 * 演化资产写盘与拓扑变更唯一经受控通道：本面 re-export 的
 * `proposal/`（含 `controlled_applier`、`evolution_writer` 落账）是本体。
 *
 * ▍活件白名单（S6 已入正家，终态无 legacy）
 * self_tools → proposal/self_edit_tools/、GuardedStorage → proposal/、
 * KnowledgeSkillStore（skill_crystal）→ skill/crystallization/、
 * MetaTuner（tuning）→ param_tuning/、evolution_writer → proposal/（原地）；
 * self_application（自指管线：SelfApplicationPipeline/审批分级/守卫集合）与
 * self_proposal（提案校验：ProposalValidator/SelfProposal/PATCH_KINDS）随 S6
 * 自 legacy/ 正家化迁入 proposal/（活线 self_tools 消费，§7.2 条件分支）。
 * 无宿主消费遗留件（entity_evolution/evolution/growth）已随 S6 删除。
 *
 * ▍管线数据流
 * settle(归因) → evolve/learn(蒸馏+知识闸) → KnowledgeSet →
 * evolve/proposal(提案) → 采纳闸 → apply → patch chain；
 * evolve/observe（组织档案/证据/评分）是择优与提案的信号源。
 *
 * ▍方向纪律
 * - loop/turn_settle 只发事件/留痕，不 import evolve/（依赖朝向，
 *   settle 侧由事件订阅或 boot 装配注入挂上）；
 * - learn 侧不写 persona：蒸馏是"轨迹 → 知识"的压缩，不是身份改写；
 * - 失败分流：事实→知识，做法→图/技能，判断口径→persona（极少）。
 */

export * from './proposal/index.js';
export * from './proposal/evolution_writer/evolution_writer.js';
export * from './proposal/evolution_writer/_types.js';

export * from './learn/knowledge_gate/index.js';
export * from './learn/memory/index.js';
export * from './learn/memory_extract/index.js';
export * from './learn/retrieval/index.js';
export * from './learn/signals/index.js';
export * from '../model/source_reliability/sourceGrading.js';

export * from './observe/inspection/index.js';
export * from './observe/usage_evidence/index.js';
export * from './observe/org_archive/org_archive.js';
export * from './observe/scoring/scoring.js';

export * from './param_tuning/index.js';
export * from './skill/crystallization/index.js';

export * from './proposal/self_application/index.js';
export * from './proposal/self_proposal/index.js';
export * from './proposal/self_edit_tools/index.js';