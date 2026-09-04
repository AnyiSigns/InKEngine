/**
 * 工具调配器数据形态（镜像 Python tool_orchestrator.py 数据面）：候选 +
 * 打分/匹配策略接口 + 调用轨迹。
 *
 * 工具集 = 带元数据的候选池——任务相关度 = relevance、调用频率/可信度 =
 * weight、预算 = 工具集上限；确定性选取（零 LLM 调用），宿主可注入自定义
 * 打分/匹配策略——换策略不改装配，与 ContextMixer 的替换语义一致。
 *
 * 副作用纪律：core 零 IO——时间源（Clock）与随机源（UuidFn）均为注入 seam，
 * 缺省取确定值（now=0、固定 uuid 串），保证同输入必得同输出（可缓存、可断言）。
 */

import { isRecord } from '../json.js';
import type { ToolSpec } from '../llm/tools.js';

/** 默认本轮工具集预算（数量上限，与 spawn 清单上限同档成本护栏语义）。 */
export const DEFAULT_MAX_TOOLS = 14;

/** 相关度默认值（与上下文源同口径：未声明取中值，防全默认均分预算）。 */
export const DEFAULT_RELEVANCE = 0.5;

/** 工具入选门槛：score = weight × relevance 低于该值即丢弃（近似噪音）。 */
export const DEFAULT_MIN_SCORE = 0.15;

/** 时间注入面：纯函数可复现（core 不落 IO，避免隐式 Date.now 依赖）。 */
export interface Clock {
  /** 取当前 epoch 秒；未注入时按 0。 */
  now?: () => number;
}

/** 缺省时间源（确定值 now=0）。 */
const DEFAULT_NOW = (): number => 0;

/** 轨迹 id 的随机数源 seam（core 零随机依赖，宿主注入真实随机源）。 */
export type UuidFn = () => string;

/** 缺省 uuid 固定串（确定性：缺省注入下轨迹 id 可复现、可断言）。 */
export const DEFAULT_UUID_HEX = '00000000-0000-4000-8000-000000000000';

/** 工具调配候选构造选项（Python 关键字参映射）。 */
export interface ToolCandidateOptions {
  spec: ToolSpec;
  relevance?: number;
  weight?: number;
  priority?: number;
}

/** 工具调配候选：工具 + 任务相关度 + 调用频率/可信度权重。
 *
 * 字段语义：
 * - spec：工具描述（数据形态，可序列化）；
 * - relevance：任务相关度（0-1，与当前子任务的匹配度）；
 * - weight：调用频率/可信度权重（数值大优先入选；经验闭环中高可信
 *   高频工具权重高）；
 * - priority：同分排序键（数值大在前）。
 * frozen 语义由 readonly + 构造期校验表达（负权重/越界相关度 → RangeError，
 * 配置错误声明期暴露）。
 */
export class ToolCandidate {
  readonly spec: ToolSpec;
  readonly relevance: number;
  readonly weight: number;
  readonly priority: number;

  constructor(options: ToolCandidateOptions) {
    const { spec, relevance = DEFAULT_RELEVANCE, weight = 1.0, priority = 5 } = options;
    if (weight < 0) {
      throw new RangeError(`工具权重不能为负: ${weight}`);
    }
    if (!(relevance >= 0 && relevance <= 1)) {
      throw new RangeError(`工具相关度必须在 [0, 1] 内: ${relevance}`);
    }
    this.spec = spec;
    this.relevance = relevance;
    this.weight = weight;
    this.priority = priority;
  }

  /** 调配分 = 权重 × 相关度（单一排序键，可解释、可断言）。 */
  score(): number {
    return this.weight * this.relevance;
  }
}

/** 工具打分策略接口：候选列表 → 入选工具（按序，数量 ≤ 预算）。
 *
 * 实现约定：确定性（同输入必得同输出）；返回的工具不得超出候选池；
 * 入选数量不得超过预算（硬上界）。默认实现见 WeightedToolScorer。
 */
export interface ToolScoring {
  select(candidates: readonly ToolCandidate[], max_tools: number): ToolSpec[];
}

/** LLM 匹配策略位（轻量注入，不引入重机制）。
 *
 * 宿主可注入自定义语义匹配逻辑（如 LLM 对候选工具的相关度打分），
 * 在基线加成之后、最终排序之前介入——换策略不改装配。默认 null =
 * 不做额外匹配（纯基线加成 + 权重排序）。
 */
export interface ToolMatchStrategy {
  apply(candidates: readonly ToolCandidate[]): ToolCandidate[];
}

/** 工具轨迹存储最小契约：put_record + list_records（duck-typed；
 *  不绑定宿主 Storage 全量接口，core 只用 records 通道两原语）。 */
export interface TraceRecordsStore {
  put_record(collection: string, key: string, data: Record<string, unknown>): Promise<void>;
  list_records(collection: string): Promise<Record<string, unknown>[]>;
}

/** 工具轨迹存储构造选项（Python 关键字参映射）。 */
export interface ToolTraceStoreOptions {
  /** 轨迹集合名（缺省 tool_traces）。 */
  collection?: string;
  /** 轨迹 id 的随机数源（缺省固定串 DEFAULT_UUID_HEX，宿主注入真实随机源）。 */
  uuid?: UuidFn;
}

/** 工具调用轨迹构造选项（Python 关键字参映射；created_at 可经 clock 注入）。 */
export interface ToolTraceOptions {
  tool: string;
  ok?: boolean;
  decision?: string;
  args?: Record<string, unknown>;
  error?: string | null;
  duration_ms?: number;
  thread_id?: string;
  created_at?: number;
  id?: string | null;
  /** 注入的时间源；created_at 缺省时取 now（缺省确定值 0）。 */
  clock?: Clock;
}

/** 单次工具调用轨迹（经验闭环的原始信号）。
 *
 * 字段语义：
 * - tool：工具名；
 * - ok：是否成功执行（False = 拒绝/出错，踩坑信号）；
 * - decision：工具流水线决议（allow/deny/error/accept/terminate）；
 * - args：参数摘要（落库前经宿主裁剪/脱敏——引擎不解释内容，但存储层
 *   统一剥离敏感键；含不可 JSON 序列化值时由调用方负责）；
 * - error：失败原因（ok=False 时）；
 * - duration_ms：调用耗时（毫秒）；
 * - thread_id：归属会话/线程；
 * - created_at：记录时间戳（epoch 秒，经 Clock seam 注入，缺省 0）；
 * - id：轨迹唯一 id（存储分配，新建时为 null）。
 */
export class ToolTrace {
  readonly tool: string;
  readonly ok: boolean;
  readonly decision: string;
  readonly args: Record<string, unknown>;
  readonly error: string | null;
  readonly duration_ms: number;
  readonly thread_id: string;
  readonly created_at: number;
  readonly id: string | null;

  constructor(options: ToolTraceOptions) {
    this.tool = options.tool;
    this.ok = options.ok ?? true;
    this.decision = options.decision ?? 'allow';
    this.args = options.args ?? {};
    this.error = options.error ?? null;
    this.duration_ms = options.duration_ms ?? 0.0;
    this.thread_id = options.thread_id ?? '-';
    this.created_at = options.created_at ?? (options.clock?.now ?? DEFAULT_NOW)();
    this.id = options.id ?? null;
  }

  /** 序列化为数据形态（JSON 进 JSON 出，落库契约）。 */
  to_dict(): Record<string, unknown> {
    return {
      tool: this.tool,
      ok: this.ok,
      decision: this.decision,
      args: this.args,
      error: this.error,
      duration_ms: this.duration_ms,
      thread_id: this.thread_id,
      created_at: this.created_at,
      id: this.id,
    };
  }

  /** 从数据形态还原（缺省兜底镜像 Python or 语义；未知键忽略兼容增量演进）。
   *  created_at 缺省取确定值 0（Python 端 time.time() 兜底在 TS 侧由
   *  Clock seam 承担，缺省即 now=0）。 */
  static from_dict(data: Record<string, unknown>): ToolTrace {
    return new ToolTrace({
      tool: data['tool'] as string,
      ok: Boolean(data['ok'] ?? true),
      decision: (data['decision'] as string | undefined) || 'allow',
      args: isRecord(data['args']) ? data['args'] : {},
      error: (data['error'] as string | null | undefined) ?? null,
      duration_ms: Number(data['duration_ms'] ?? 0.0),
      thread_id: (data['thread_id'] as string | undefined) || '-',
      created_at: Number(data['created_at'] ?? 0.0),
      id: (data['id'] as string | null | undefined) ?? null,
    });
  }
}