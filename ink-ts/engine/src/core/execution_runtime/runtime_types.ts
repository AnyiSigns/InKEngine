/**
 * 执行运行时共享数据形态（执行/子执行/护栏/结果的事件与载荷契约）。
 *
 * 执行模型（§二/§三）三原语里的「执行 Execution」在本运行时承载为 run：上下文 +
 * 任务 + 产物（载荷）+ 作用域 + 轨迹（scope×channel 序列），可派生子执行
 * （delegate/fan_out 的子 run 各自独立 run_id / 轨迹 / 成本）。本模块只定共享
 * 类型面，不含执行逻辑（执行循环见 execution_runtime.ts）。
 *
 * 产物即契约：run 内载荷按作用域声明消费/产出传递，旧产物不残留——本层保持
 * payload 为纯 JSON dict，跨转场由归并语义投影。
 */

import type { ChannelCommit } from '../channels/channel_spec.js';
import type { EntitySpec } from '../entities/entities.js';
import type { ScopePriorPattern } from '../scopes/scope_priors.js';
import type { ExecutionTrail, TrailCost, TrailHop, TrailOutcome } from '../org_archive/execution_trail.js';
import type { ChannelDirectory } from '../channels/channel_directory.js';
import type { GuardrailConfig } from './guardrails.js';
import type { TransitionApprovalSeam } from './channel_gate.js';
import type { WhiteboardAuditEntry, WhiteboardBlock, WhiteboardGrants } from '../whiteboard/index.js';
import type { AuthorizedBlock } from '../context/block_source.js';

/** 作用域装载结果（目录作用域资产 = 实体记录；临时作用域 = 运行时构造的同形
 *  实体记录——作用域身份主体字段全在 EntitySpec 上）。 */
export type LoadedScope = EntitySpec;

/** 目录作用域装载 seam（实体目录命中 + 非下架；未注册 = null 拒绝装载）。 */
export type ScopeLoader = (scope_id: string) => LoadedScope | null;

/** 单轮作用域加工的上下文（turn runner 输入）。 */
export interface ScopeTurnContext {
  run_id: string;
  step: number;
  scope: LoadedScope;
  /** boot 基线系统提示词（作用域 persona 经 compose 叠加在其后）。 */
  boot_system_prompt: string;
  /** 任务/上下文文本（载荷投影为文本喂入模型调用的 input 面）。 */
  input: string;
  /** 当前载荷（作用域声明消费的字段；只读投影面）。 */
  payload: Record<string, unknown>;
  thread_id: string;
  /** 该作用域被授权的白板块（按 grants view 得出；空 = 无授权）。 */
  whiteboard_blocks?: readonly AuthorizedBlock[];
}

/** 单轮作用域加工的产物（turn runner 输出；ok=false = 本轮加工失败需降级）。 */
export interface ScopeTurnResult {
  ok: boolean;
  /** 模型回复文本（含可能的 `__next` 声明，供路由解析）。 */
  reply: string;
  /** 产物载荷（turn runner 直接给出的结构化字段；回复文本之外的契约输出面）。 */
  payload?: Record<string, unknown>;
  summary?: string;
  reason?: string;
  cost?: TrailCost | null;
}

/** 子执行完成回传父执行的结果（归并/择优/摘要的输入单元）。 */
export interface ChildRunOutcome {
  run_id: string;
  parent_run_id: string | null;
  /** 子执行入口作用域 id。 */
  entry_scope: string;
  outcome: TrailOutcome;
  /** 子执行最终载荷（归并契约消费面；degraded/failure 可为空）。 */
  payload: Record<string, unknown>;
  summary: string | null;
  cost: TrailCost;
  error: string | null;
  /** 择优落选标记（best 归并落选者保留但隔离；缺省 = 采纳）。 */
  adopted?: boolean;
}

/** run 级结果（执行树节点：轨迹 + 终态 + 成本 + 子执行清单）。 */
export interface RunRecord {
  run_id: string;
  parent_run_id: string | null;
  entry_scope: string;
  outcome: TrailOutcome;
  hops: TrailHop[];
  cost: TrailCost;
  degraded_summaries: string[];
  children: ChildRunOutcome[];
  error: string | null;
}

/** 事件带条目（run_id / parent_run_id / scope / action 组织为执行树）。 */
export interface RunEvent {
  run_id: string;
  parent_run_id: string | null;
  scope: string;
  action: string;
  detail: Record<string, unknown> | null;
}

/** 会话收尾结果（汇聚点合成唯一的最终产物 + 执行树）。 */
export interface ExecutionResult {
  /** 根 run 记录（轨迹/成本/终态）。 */
  root: RunRecord;
  /** 汇聚点合成产物（唯一面向用户；后台产物不直接外泄）。 */
  final_product: Record<string, unknown>;
  /** 汇总摘要（子执行降级/失败的用户可见面）。 */
  degraded_summaries: string[];
  /** 执行树全部 run 记录（根 + 全部后代；组织档案 ingest 面）。 */
  runs: RunRecord[];
  /** 全部轨迹（run 各自一条；archive 直接 ingest 用）。 */
  trails: ExecutionTrail[];
  /** 事件带。 */
  events: RunEvent[];
  blocked: boolean;
  block_reason: string | null;
}

/** 白板会话（grants + 当前 blocks；运行时持有并 mutate）。 */
export interface WhiteboardSession {
  grants: WhiteboardGrants;
  blocks: WhiteboardBlock[];
  /** 授权变更仲裁者（缺省 main；运行中变更仅该作用域声明生效，§7.2）。 */
  arbiter?: string;
}

/** 执行入口（一次 ExecutionRuntime.run 的输入）。 */
export interface ExecutionRequest {
  /** 会话/根 run 任务文本。 */
  task: string;
  /** 会话目标分类标签（先验匹配的 trigger；可 null）。 */
  trigger?: string | null;
  /** 入口目录作用域 id（缺省 = main 主持人）。 */
  entry_scope?: string;
  /** 入口临时作用域定义（与 entry_scope 二选一；入口无稳定身份时）。 */
  entry_temp_scope?: Record<string, unknown> | null;
  /** 初始载荷字段（随入口作用域第一轮加工注入）。 */
  seed_payload?: Record<string, unknown>;
  /** 根 run_id（缺省运行时派生；提供 = 宿主控制命名）。 */
  run_id?: string;
  /** 可选白板会话（grants + 初始 blocks；缺省 = 无白板，零漂移）。 */
  whiteboard?: WhiteboardSession | null;
  /** 白板装配用的作用域模型 context_window（缺省 = null，resolve_compression_min_chars 回落 200k 兜底）。 */
  whiteboard_context_window?: number | null;
}

/** 执行运行时装配依赖（全部注入式；host 装配真实实现，测试注入 fake）。 */
export interface ExecutionRuntimeDeps {
  /** 目录作用域装载（实体目录；临时作用域不经过此面）。 */
  load_scope: ScopeLoader;
  /** 通道目录。 */
  channels: ChannelDirectory;
  /** 单轮作用域加工执行器（默认实现 = engine_turn_runner 引擎装载形态）。 */
  turn: ScopeTurnRunner;
  /** 通道审批 seam（缺省 = 全拒 fail-closed）。 */
  approval?: TransitionApprovalSeam;
  /** 先验路线集（缺省 = default_scope_priors 出厂素材）。 */
  priors?: readonly ScopePriorPattern[];
  /** 护栏配置（缺省 = 出厂默认档）。 */
  guardrails?: GuardrailConfig;
  /** boot 基线系统提示词（装配注入只读；缺省 ''）。 */
  boot_system_prompt?: string;
  /** 事件带 sink（缺省 = 收集到 ExecutionResult.events）。 */
  on_event?: (event: RunEvent) => void;
  /** 组织档案落库面（可空；非空 = 每次 run 收尾 ingest 轨迹——试跑传空容器防
   *  证据入主档案）。 */
  archive?: OrgArchiveSink | null;
  /** 运行成本估价器（每轮加工成本增量；缺省按 turn cost.cost）。 */
  estimate_cost?: (turn: ScopeTurnResult) => number;
  /** 时钟（事件时间戳；缺省 = 确定性 0）。 */
  now_ms?: () => number;
  /** 白板审计转发（scope×block×read|write；缺省 = 发为 RunEvent action='whiteboard_audit'）。 */
  on_whiteboard_audit?: (entries: WhiteboardAuditEntry[]) => void;
}

/** 组织档案 ingest seam（OrgArchive 的内存写面；试跑隔离 = 独立空档案）。 */
export interface OrgArchiveSink {
  ingest(trail: ExecutionTrail): void;
}

/** 单轮作用域加工执行器 seam。 */
export interface ScopeTurnRunner {
  run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult>;
}
