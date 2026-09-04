// gate: 超限(360 行) - 自学习管线单一闭环（事件→信号→蒸馏→闸门→落位），拆文件即破状态流
/**
 * 自学习管线（孵化闭环）：回合事件 → 信号 → 蒸馏 → 三层闸门 → 知识集落位。
 *
 * 引擎自承载的「生长」机制（出厂默认开启，无用户可操作项）：把会话回合
 * 执行轨迹中可学习的部分沉淀为知识，全部过程在引擎内部跑通，宿主无需
 * 介入——知识落位过三层闸门（L1 形式合法+注入扫描 / L2 效果评估 /
 * L3 目标筛选），自动放行不弹人工卡（自我进化是后台机制，不是审批面）。
 *
 * 链路（复用既有机制件，本模块只做接线与缓冲）：
 * - **观察侧**：实现 EngineTransport，按序观察回合事件流——error/失败工具
 *   调用 → 踩坑信号，评审决议 accept/edit/reject → 用户修正信号，
 *   insight/review_pass/user_confirm → 洞见信号（分类路由见
 *   knowledge_signals.SignalClassifier）；
 * - **缓冲侧**：信号进入孵化缓冲（跨回合累积，同因聚合升级重复根因）；
 * - **触发侧**：实现 SettleHook，回合收尾按需蒸馏——复杂度（结点步数）或
 *   用户干预超阈值才蒸馏（双阈值保守防「蒸馏垃圾进垃圾出」）；确定性基线
 *   零 LLM，链缺失回落确定性蒸馏；
 * - **落位侧**：蒸馏产物过 KnowledgeGate 三层闸门后写入知识集（insight
 *   教训条目无执行语义，L2 跳过规则执行——闸门注在写入边界）；
 * - **事件侧**：发射 signal_detected / distill_outcome / gate_verdict 事件
 *   （注入 emit 回调转发引擎事件流；未注入 = 静默，不影响沉淀链路）；
 * - **诊断侧**：snapshot() 只读暴露孵化中信号数/知识集规模/闸门通过率。
 *
 * 故障隔离：观察/触发全程吞异常（观测不影响执行、沉淀失败不阻断 run 结果
 * 交付——与 settle 钩子语义一致）。
 *
 * TS seam 差异：时间（time.time）与条目 id（uuid.uuid4().hex[:12]）改为注入
 * 的 now/uuid_gen——缺省确定值（now=0、uuid_gen=固定 12 位十六进制），core
 * 零时钟零随机可复现；Python logging.warning 留痕属可观测性副作用，core
 * 不落（对应行为以吞异常表达）。事件发射/指标时序逻辑抽至 _emit.ts /
 * _metrics.ts 模块级函数（所需状态即发射回调与指标存储）。
 */

import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import type { EngineEvent } from '../events/events.js';
import type { SettleContext } from '../settle/types.js';
import { KnowledgeGate } from '../knowledge_gate/knowledge_gate.js';
import {
  KIND_INSIGHT,
  KnowledgeEntry,
  KnowledgeSet,
  LEVEL_WORK,
  SOURCE_MODEL,
} from '../knowledge_set/index.js';
import { default_credibility } from '../source_grading/sourceGrading.js';
import {
  DistillConfig,
  ExecutionSignal,
  SIGNAL_INSIGHT,
  SIGNAL_PITFALL,
  SIGNAL_USER_CORRECTION,
  SOURCE_RANK,
  SignalClassifier,
  TieredDistiller,
} from '../knowledge_signals/index.js';
import {
  _EMPTY_FIXTURES,
  _INSIGHT_SCHEMA,
  _MAX_INCUBATING,
} from './_constants.js';
import { GrowthConfig } from './config.js';
import type { GrowthEmit } from './_emit.js';
import {
  emit_distill_outcome,
  emit_gate_verdict,
  emit_signal_detected,
} from './_emit.js';
import type { MetricStore } from './_metrics.js';
import { append_metric_snapshot, read_metric_series } from './_metrics.js';
import { pitfall_message, source_from_event } from './_helpers.js';

/** GrowthPipeline 构造选项（python __init__ 关键字参数 + 确定性 seam）。 */
export interface GrowthPipelineOptions {
  config?: GrowthConfig | null;
  distiller?: TieredDistiller | null;
  gate?: KnowledgeGate | null;
  emit?: GrowthEmit | null;
  metric_store?: MetricStore | null;
  /** 时间源（等价 Python time.time）；缺省确定值 0，测试可注入序列。 */
  now?: () => number;
  /** id 片段源（等价 uuid.uuid4().hex[:12]）；缺省固定 12 位十六进制。 */
  uuid_gen?: () => string;
}

/** 缺省时间源（镜像知识集/审计的 now 缺省）：确定值 0。 */
const DEFAULT_NOW = (): number => 0;
/** 缺省 id 片段源：固定 12 位十六进制（确定性复现）。 */
const DEFAULT_UUID_GEN = (): string => '000000000000';

/**
 * 自学习闭环：回合事件 → 信号缓冲 → 按需蒸馏 → 三层闸门 → 知识集。
 *
 * 同一实例同时实现 EngineTransport（观察事件流）与 SettleHook（回合收尾
 * 触发），由 Runtime 装配注入：观察侧注册进 RunOptions.transports，触发侧
 * 注册进 RunOptions.settle 钩子链。
 */
export class GrowthPipeline {
  readonly config: GrowthConfig;
  readonly knowledge_set: KnowledgeSet;
  readonly distiller: TieredDistiller;
  // 自动放行人工层：自我进化是后台机制，落位只过三层闸门
  readonly gate: KnowledgeGate;
  readonly _classifier = new SignalClassifier();
  // 成长指标时序存储（无 = 不持久化指标——只读诊断仍可用）
  readonly _metric_store: MetricStore | null;
  readonly _now: () => number;
  readonly _uuid_gen: () => string;
  // 孵化事件发射回调（注入 = 转发引擎事件流；None = 静默）
  _emit: GrowthEmit | null;
  // 孵化缓冲（跨回合累积；蒸馏触发后清空）
  _buffer: ExecutionSignal[] = [];
  // 待发射的信号检测队列（观察侧只入队，回合收尾 settle 锁外批量发射）
  _pending_signal_events: ExecutionSignal[] = [];
  // 本缓冲期的用户干预数（回合收尾蒸馏触发判据之一）
  _interventions = 0;
  // 诊断计数（只读快照的数据面）
  collected_total = 0; // 累计收集信号数
  gate_checked = 0; // 闸门评估次数
  gate_passed = 0; // 闸门通过次数
  landed = 0; // 落位知识集条数
  last_flush_note = '自学习管线就绪（默认开启，回合收尾按需蒸馏）';
  _last_landed_at: number | null = null;

  constructor(knowledge_set: KnowledgeSet, options: GrowthPipelineOptions = {}) {
    this.config = options.config ?? new GrowthConfig();
    this.knowledge_set = knowledge_set;
    this.distiller =
      options.distiller ??
      new TieredDistiller({ config: new DistillConfig(), chain: null });
    // 自动放行人工层：自我进化是后台机制，落位只过三层闸门
    this.gate = options.gate ?? new KnowledgeGate({ human_review_enabled: false });
    this._metric_store = options.metric_store ?? null;
    this._emit = options.emit ?? null;
    this._now = options.now ?? DEFAULT_NOW;
    this._uuid_gen = options.uuid_gen ?? DEFAULT_UUID_GEN;
  }

  // ── 事件发射（孵化动态 → 前端演化页签）──

  /** 注入事件发射回调（引擎装配后接引擎事件流；None = 静默）。 */
  set_emit(emit: GrowthEmit | null): void {
    this._emit = emit;
  }

  // ── 观察侧：回合事件 → 信号 ──

  /** EngineTransport：观察回合事件流（观测不阻断执行）。 */
  async send(event: EngineEvent): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this._observe(event);
    } catch {
      // 事件观察失败只跳过（Python 记 warning；core 零 IO 不落）
    }
  }

  async _observe(event: EngineEvent): Promise<void> {
    const payload = event.payload ?? {};
    // 工具调用失败（host 回合事件 tool_end 携带 success=false）→ 踩坑；
    // 其余事件按分类器规则路由
    let signal: ExecutionSignal | null;
    if (event.type === 'tool_end' && payload['success'] === false) {
      signal = new ExecutionSignal({
        kind: SIGNAL_PITFALL,
        message: pitfall_message(payload),
        source: source_from_event(event),
        context: { ...payload },
      });
    } else {
      signal = this._classifier.classify({
        type: event.type,
        message: payload['message'],
        source: source_from_event(event),
        context: payload,
      });
    }
    if (signal === null) return;
    this._buffer.push(signal);
    if (this._buffer.length > _MAX_INCUBATING) {
      this._buffer.shift();
    }
    this.collected_total += 1;
    if (signal.kind === SIGNAL_USER_CORRECTION) {
      this._interventions += 1;
    }
    // 事件侧：信号检测入队（观察侧在引擎传输锁内，不能同步发射——回合
    // 收尾 settle 锁外批量发出，前端演化页签「信号」节点）
    this._pending_signal_events.push(signal);
  }

  // ── 触发侧：回合收尾按需蒸馏 ──

  /** SettleHook：回合收尾（复杂度 = 结点步数）按需蒸馏 + 指标快照。 */
  async settle(ctx: SettleContext): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.flush_round({ complexity: ctx.steps.length });
    } catch {
      // 回合收尾失败只跳过（Python 记 warning；core 零 IO 不落）
    }
    // 每回合收尾追加成长指标快照（未达蒸馏阈值也记——曲线要能看出「信号
    // 在积累而知识未增长」的冷启动阶段；写入失败不阻断）
    await this._append_metric_snapshot();
  }

  /**
   * 回合收尾刷新：缓冲信号按需蒸馏 → 三层闸门 → 知识集落位。
   *
   * Args:
   *   complexity: 本回合复杂度（结点步数；触发判据之一）。
   */
  async flush_round(options: { complexity?: number } = {}): Promise<void> {
    const complexity = options.complexity ?? 0;
    // 先发射观察期累计的信号检测事件（settle 在引擎传输锁外，此处 publish
    // 无重入死锁风险；发射失败已由 publish_emit 吞异常）
    const pending = this._pending_signal_events;
    this._pending_signal_events = [];
    for (const signal of pending) {
      await emit_signal_detected(this._emit, signal);
    }
    if (!this.config.enabled || this._buffer.length === 0) return;
    const interventions = this._interventions;
    if (!this.distiller.should_distill({ complexity, interventions })) {
      // 未达阈值：信号继续孵化（跨回合累积）
      this.last_flush_note =
        `信号孵化中（${this._buffer.length} 条；复杂度 ${complexity} ` +
        `/ 干预 ${interventions} 未达蒸馏阈值）`;
      return;
    }
    this._interventions = 0;
    // 同因聚合升级（重复根因 → 升级信号；普通信号原样保留）
    const signals = this._classifier.aggregate(this._buffer);
    this._buffer = [];
    const anchor = signals.length > 0 ? signals[0]! : null;
    const data = this.distiller.distill(signals);
    if (data === null) {
      this.last_flush_note = '蒸馏无产物（无可沉淀素材，轨迹噪音已过滤）';
      if (anchor !== null) {
        await emit_distill_outcome(this._emit, anchor, null);
      }
      return;
    }
    if (anchor !== null) {
      await emit_distill_outcome(this._emit, anchor, data);
    }
    const entry = this._build_entry(data, signals);
    const [l1, l2, l3] = await this.gate.check(entry, {
      schema: _INSIGHT_SCHEMA,
      fixtures: _EMPTY_FIXTURES,
    });
    this.gate_checked += 1;
    if (l1.passed && l2.passed && l3.passed) {
      this.gate_passed += 1;
      this.knowledge_set.add(entry);
      this.landed += 1;
      this._last_landed_at = this._now();
      this.last_flush_note =
        `蒸馏产物过三层闸门落位知识集（${entry.id}，可信度 ` +
        `${entry.credibility}）`;
      if (anchor !== null) {
        await emit_gate_verdict(this._emit, anchor, {
          passed: true,
          level: 'L1/L2/L3',
          reason: '三层闸门通过',
        });
      }
    } else {
      this.last_flush_note = '蒸馏产物未过闸门（L1/L2/L3），本次不落库';
      if (anchor !== null) {
        await emit_gate_verdict(this._emit, anchor, {
          passed: false,
          level: 'L1/L2/L3',
          reason: '未通过三层闸门',
        });
      }
    }
  }

  /** 蒸馏产物 → 知识条目（来源取最可信者，可信度按来源分级）。 */
  private _build_entry(data: JsonRecord, signals: readonly ExecutionSignal[]): KnowledgeEntry {
    const ranked: Array<[ExecutionSignal, number]> = [];
    for (const s of signals) {
      if (s.kind === SIGNAL_INSIGHT || s.kind === SIGNAL_USER_CORRECTION) {
        ranked.push([s, SOURCE_RANK[s.source] ?? 0]);
      }
    }
    if (ranked.length === 0) {
      for (const s of signals) {
        ranked.push([s, SOURCE_RANK[s.source] ?? 0]);
      }
    }
    let source = SOURCE_MODEL;
    if (ranked.length > 0) {
      let best = ranked[0] as [ExecutionSignal, number];
      for (const item of ranked) {
        if (item[1] > best[1]) best = item;
      }
      source = best[0].source;
    }
    const rawInsight = data['insight'];
    const insight = isRecord(rawInsight) ? rawInsight : {};
    const rawMessage = insight['message'];
    const message = (typeof rawMessage === 'string' ? rawMessage : '').trim();
    return new KnowledgeEntry({
      id: `insight:g:${this._uuid_gen().slice(0, 12)}`,
      level: LEVEL_WORK,
      kind: KIND_INSIGHT,
      data,
      source,
      credibility: default_credibility(source),
      title: message.slice(0, 60) || '孵化知识',
      tags: ['孵化', source],
    });
  }

  // ── 诊断侧：只读快照 ──

  /** 成长状态只读快照（孵化中信号/知识集规模/闸门通过率）。 */
  snapshot(): Record<string, unknown> {
    const denom = Math.max(this.gate_checked, 1);
    let knowledge_count = 0;
    try {
      knowledge_count = this.knowledge_set.entries().length;
    } catch {
      knowledge_count = 0;
    }
    return {
      enabled: this.config.enabled,
      incubating_signals: this._buffer.length,
      collected_total: this.collected_total,
      knowledge_count,
      gate_checked: this.gate_checked,
      gate_passed: this.gate_passed,
      // Python round(x, 4)（银行家舍入）与 x*1e4 四舍五入在常规值域同效
      gate_pass_rate: Math.round((this.gate_passed / denom) * 10000) / 10000,
      landed: this.landed,
      last_flush_note: this.last_flush_note,
      last_landed_at: this._last_landed_at,
    };
  }

  // ── 成长指标时序（复利实证数据面：观测层，纯 append 不碰机制）──

  /** 追加一条成长指标快照（单键滚动缓冲，上限 METRICS_CAP 条）。 */
  private async _append_metric_snapshot(): Promise<void> {
    await append_metric_snapshot(
      this._metric_store,
      () => this.snapshot(),
      this._now,
    );
  }

  /** 读取成长指标时序（按 ts 升序，取最近 limit 条；无存储 = 空）。 */
  async metric_series(limit: number = 120): Promise<Array<Record<string, unknown>>> {
    return read_metric_series(this._metric_store, limit);
  }
}
