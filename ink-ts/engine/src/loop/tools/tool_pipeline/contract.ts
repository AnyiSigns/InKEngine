/**
 * tool_pipeline 机制件契约声明：工具执行流水线（权限门禁 → 沙箱守卫 →
 * 单调守卫 → 分发执行 → 审计 → 结果观察）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——tool_pipeline 的
 * 主体是机制环节的编排语义：权限判定（gate）与沙箱守卫（sandboxes）以
 * 鸭子类型 seam 注入并按 validate/resolve 做纯判定回写；分发执行把调用交
 * 给注入的 Executor（宿主工具实现），审计默认经 ctx.emit 发 tool_audit 事件，
 * 轨迹回调为可观测性信号——真实执行体（进程 spawn 信封）由宿主在 executor
 * 接线侧完成，本机制 src 不引用 SpawnSeam/ProcessSandbox/FileSandbox 等
 * 执行信封面，也不直接读写 Storage 记录或消费模型与回合端口（review 委托
 * 挂卡经 approval 机制的 approve_before_execute，interrupt 重入属节点 ctx
 * 契约面）。0-IO：不自持 IO，只按各环节 seam 语义收口。故 effects 为空。
 *
 * depends：tool_pipeline 组合 approval（approve_before_execute 审批决议与
 * 挂卡）与 permissions（ALLOW/DENY/REVIEW 门禁判定常量）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../dock/registry/contract_types.js';

/** tool_pipeline 机制契约：依赖 approval/permissions，零副作用端口（编排语义）。 */
export const tool_pipeline_contract: MechanismContract = {
  id: 'tool_pipeline',
  contract: {
    effects: [],
  },
  depends: ['approval', 'permissions'],
};
