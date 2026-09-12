/**
 * execution_runtime 公开面：执行运行时（作用域转场循环）、`__next` 路由数据面、
 * 路由规划、通道条件、归并/汇聚点合成、护栏、隔离试跑基座。
 *
 * 分层：routing/planning/guardrails/merge/temp_scope = 纯函数数据面（可独立
 * 单测）；execution_runtime + run_loop = 运行时编排（turn seam 注入）；trial_
 * runner = 演化采纳前验证闸的隔离试跑执行器（复用 ExecutionRuntime）。
 */

export * from '../route/routing_next.js';
export * from './amend_runtime.js';
export * from './board_runtime.js';
export * from '../route/route_planner.js';
export * from './guardrails.js';
export * from './channel_gate.js';
export * from './fan_in.js';
export * from '../route/fallback_routing.js';
export * from './temp_scope.js';
export * from './scope_turn.js';
export * from './execution_runtime.js';
export * from './run_loop.js';
export * from './run_transition.js';
export * from './run_checkpoint.js';
export * from './run_result.js';
export * from './engine_turn_runner.js';
export * from '../trial/trial_runner.js';
export type {
  ChildRunOutcome,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRuntimeDeps,
  LoadedScope,
  OrgArchiveSink,
  RunEvent,
  RunRecord,
  ScopeLoader,
  ScopeTurnContext,
  ScopeTurnResult,
  ScopeTurnRunner,
  WhiteboardSession,
} from './runtime_types.js';
