/**
 * 调用面：宿主调用引擎的执行口径类型集中声明口（计划 §4.3：run/resume/abort/
 * 提案/检视的宿主消费面）。
 *
 * Dock.calls 收录执行运行时（ExecutionRuntime/ExecutionRequest/ExecutionResult/
 * RunEvent/RunRecord 等运行请求/回执/事件/记录）、单轮运行结果（RunOptions/
 * RunResult）、审批姿态（approve_before_execute/approve_batch/决策形态）、
 * 恢复决议（ResumeResolution 挂起卡决议）与中断协调（InterruptCoordinator）
 * 五组整模块 star re-export：与 dock/index.ts 中同模块语句全等，符号集合不因
 * 本面增减（面文件禁具名子集，防公共面快照 value↔type 翻转）。Runtime 类与
 * RuntimeConfigInit 属装配入口具名语句、Engine/run_subgraph 属执行器具名语句，
 * 随「运行时装配/执行器入口」组保留在 dock/index.ts，本面不复制。
 */

export * from '../core/execution_runtime/index.js';
export * from '../core/run_result/run_result.js';
export * from '../kernel/approval/approval.js';
export * from '../kernel/recovery/index.js';
export * from '../kernel/interrupt/interrupt.js';
