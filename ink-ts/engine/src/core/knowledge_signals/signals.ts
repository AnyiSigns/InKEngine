/**
 * 执行信号与五类分类路由（knowledge_signals.py 信号面移植）。
 *
 * ExecutionSignal = 分类路由的产物（轨迹中的一次可学习事件，来源留痕 +
 * 可信度分级贯穿全链）；SignalClassifier = 原始轨迹事件 → 五类信号的
 * 确定性规则路由——节点异常/工具失败/校验拒绝 → 踩坑，用户修正反例 →
 * 用户修正，成功路径可复用结论 → 洞见，缺能力提示 → 缺口；同因重复
 * （按根因键聚合 ≥ 阈值）升级为 repeated_root_cause（人工确认候选）。
 * 无信号形态的事件 = 轨迹噪音，不沉淀。
 *
 * 时间 seam：timestamp 缺省经 clock 注入面取 epoch 秒（未注入 = 0，
 * 确定性复现——纯逻辑不进 Date.now）。
 */

import type { Clock } from '../context/context_types.js';
import { GraphDefinitionError } from '../errors.js';
import { isRecord, type JsonRecord, typeName } from '../json.js';
import {
  REPEAT_THRESHOLD,
  SIGNAL_GAP,
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_REPEATED_ROOT_CAUSE,
  SIGNAL_USER_CORRECTION,
  SOURCE_MODEL,
  SOURCE_USER,
  _SIGNAL_KINDS,
  _SOURCES,
  _str_repr,
  _tuple_repr,
} from './_types.js';

// 分类路由的原始轨迹事件形态映射（Python 分类语义的确定性基线；事件
// 字段缺失走默认，形态与执行器事件/宿主回合记录对齐）
const _ERROR_TYPES = ['error', 'node_error', 'tool_error', 'validation_error'];
const _CORRECTION_TYPES = ['accept', 'edit', 'reject', 'user_correction'];
const _INSIGHT_TYPES = ['insight', 'review_pass', 'user_confirm'];
const _GAP_TYPES = ['gap', 'missing_capability', 'no_rule'];

const DEFAULT_NOW = (): number => 0;

/**
 * 一条执行信号（分类路由的产物：轨迹中的一次可学习事件）。
 *
 * frozen 语义由 readonly 表达；context 为关联上下文的拷贝（不透传
 * 引用，防调用方后续改写污染信号）。
 */
export class ExecutionSignal {
  readonly kind: string; // 信号类别（pitfall/user_correction/insight/gap/repeated_root_cause）
  readonly message: string; // 信号内容（轨迹摘要，蒸馏的输入素材）
  readonly source: string; // 来源（web/dialog/model/user——可信度分级与防注入审计）
  readonly context: JsonRecord; // 关联上下文（任务描述/节点/工具名等，蒸馏时透传）
  readonly count: number; // 同因出现次数（重复根因判定依据；初次为 1）
  readonly timestamp: number; // 信号时间戳（epoch 秒）
  readonly clock: Clock;

  constructor(options: {
    kind: string;
    message: string;
    source?: string;
    context?: JsonRecord | null;
    count?: number;
    timestamp?: number;
    clock?: Clock;
  }) {
    this.clock = options.clock ?? {};
    this.kind = options.kind;
    this.message = options.message;
    this.source = options.source ?? SOURCE_MODEL;
    this.context = options.context ? { ...options.context } : {};
    this.count = options.count ?? 1;
    this.timestamp = options.timestamp ?? (this.clock.now ?? DEFAULT_NOW)();
  }

  /** 序列化：省略默认值的紧凑形态（context 空/初次出现省略，往返无损）。 */
  to_dict(): JsonRecord {
    const data: JsonRecord = {
      kind: this.kind,
      message: this.message,
      source: this.source,
    };
    if (Object.keys(this.context).length > 0) data.context = this.context;
    if (this.count > 1) data.count = this.count;
    data.timestamp = this.timestamp;
    return data;
  }

  /** 反序列化（单点校验：类别/来源白名单、message 非空字符串、context 形态）。 */
  static from_dict(data: unknown, options: { clock?: Clock } = {}): ExecutionSignal {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`信号声明非法: 期望 dict，收到 ${typeName(data)}`);
    }
    const kind = data.kind;
    const message = data.message;
    if (typeof kind !== 'string' || !_SIGNAL_KINDS.includes(kind)) {
      throw new GraphDefinitionError(
        `未知信号类别: ${_str_repr(kind)}（仅 ${_tuple_repr(_SIGNAL_KINDS)}）`,
      );
    }
    if (typeof message !== 'string' || !message) {
      throw new GraphDefinitionError('信号缺 message（字符串）');
    }
    const source =
      data.source === undefined || data.source === null ? SOURCE_MODEL : String(data.source);
    if (!_SOURCES.includes(source)) {
      throw new GraphDefinitionError(
        `未知信号来源: ${_str_repr(data.source)}（仅 ${_tuple_repr(_SOURCES)}）`,
      );
    }
    const context = data.context;
    if (context !== undefined && context !== null && !isRecord(context)) {
      throw new GraphDefinitionError('信号 context 须为 dict');
    }
    const now = (): number => (options.clock?.now ?? DEFAULT_NOW)();
    return new ExecutionSignal({
      kind,
      message,
      source,
      context: context ? { ...(context as JsonRecord) } : null,
      count: data.count === undefined || data.count === null ? 1 : Number(data.count),
      timestamp:
        data.timestamp === undefined || data.timestamp === null
          ? now()
          : Number(data.timestamp),
      clock: options.clock,
    });
  }
}

/**
 * 信号分类器：原始轨迹事件 → 五类信号（确定性规则分类路由）。
 *
 * 分类语义（可扩展的确定性基线；语义分类为可选扩展）：
 * - 节点异常/工具失败/校验拒绝 → pitfall（踩坑）；
 * - 用户修正（accept/edit/reject 反例）→ user_correction；
 * - 成功路径的可复用结论（评审通过/用户确认）→ insight；
 * - 缺能力提示（能力不存在/工具缺失/规则未覆盖）→ gap；
 * - 同因重复（按 message 规范化聚合 ≥ REPEAT_THRESHOLD）→
 *   repeated_root_cause（升级信号，供人工确认后修规范）。
 */
export class SignalClassifier {
  readonly repeat_threshold: number;
  // 根因聚合表（root_cause_key → 计数）：同回合内同因事件聚合的槽位
  readonly _root_causes = new Map<string, number>();

  constructor(repeat_threshold: number = REPEAT_THRESHOLD) {
    this.repeat_threshold = repeat_threshold;
  }

  /** 分类单条轨迹事件（非信号形态返回 null——轨迹噪音不沉淀）。
   *
   * Args:
   *   event: 轨迹事件（type/message/source/context 字段；形态与执行器
   *     事件/宿主回合记录对齐，字段缺失走默认）。
   *
   * Returns:
   *   分类出的信号（null = 无需沉淀的噪音事件）。
   */
  classify(event: Record<string, unknown>): ExecutionSignal | null {
    const etype = event.type ? String(event.type) : '';
    const payload = isRecord(event.payload) ? event.payload : {};
    const rawMessage = event.message ? event.message : payload.message ?? '';
    const message = typeof rawMessage === 'string' ? rawMessage : String(rawMessage || '');
    const source = event.source ? String(event.source) : SOURCE_MODEL;
    const rawContext = isRecord(event.context) ? event.context : payload;
    const context = { ...rawContext };
    if (_ERROR_TYPES.includes(etype)) {
      return new ExecutionSignal({
        kind: SIGNAL_PITFALL,
        message: message || `执行异常: ${etype}`,
        source,
        context,
      });
    }
    if (_CORRECTION_TYPES.includes(etype)) {
      return new ExecutionSignal({
        kind: SIGNAL_USER_CORRECTION,
        message: message || `用户修正: ${etype}`,
        source: SOURCE_USER,
        context,
      });
    }
    if (_INSIGHT_TYPES.includes(etype)) {
      return new ExecutionSignal({
        kind: SIGNAL_INSIGHT,
        message: message || `可复用经验: ${etype}`,
        source,
        context,
      });
    }
    if (_GAP_TYPES.includes(etype)) {
      return new ExecutionSignal({
        kind: SIGNAL_GAP,
        message: message || '能力缺失（新建候选）',
        source,
        context,
      });
    }
    // 非信号形态：不沉淀（轨迹噪音过滤）
    return null;
  }

  /** 同因聚合：重复根因升级（同一 root key ≥ 阈值 → 升级信号）。
   *
   * root key = (kind, message 规范化)；重复根因不直接产出知识——升级为
   * 人工确认候选（repeated_root_cause），由使用方转人工。同因多次出现
   * 只产一条升级候选（按 root key 聚合，count 取最大）——逐次各产一条
   * 会让下游拿到重复升级信号、膨胀信号流。
   */
  aggregate(signals: readonly ExecutionSignal[]): ExecutionSignal[] {
    const counts = new Map<string, number>();
    for (const signal of signals) {
      const key = signal.kind + '\u0000' + signal.message.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const upgraded: ExecutionSignal[] = [];
    const seenKeys = new Set<string>();
    for (const signal of signals) {
      const key = signal.kind + '\u0000' + signal.message.trim().toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const count = counts.get(key) ?? 0;
      if (count >= this.repeat_threshold) {
        upgraded.push(
          new ExecutionSignal({
            kind: SIGNAL_REPEATED_ROOT_CAUSE,
            message: signal.message,
            source: signal.source,
            context: { ...signal.context, repeat_count: count },
            count,
          }),
        );
      } else {
        upgraded.push(signal);
      }
    }
    return upgraded;
  }
}