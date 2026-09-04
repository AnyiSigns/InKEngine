/**
 * 蒸馏挡位建链与挡位蒸馏器（knowledge_signals.py 挡位面移植）。
 *
 * 组装语义（计划「复用双挡位（router 建链，router_config 缺失回落
 * main_config，distill_enabled 为引擎配置开关）」落地）：
 * - resolve_distill_chain：按挡位构建蒸馏模型链（router 建链，配置
 *   缺失回落 main_config）——经 tiers.build_tier_chain 走与引擎其余
 *   挡位消费方同一条回落路径，无独立配置形态；主/router 挡位均无配置
 *   时返回 null（由 TieredDistiller 回落确定性蒸馏基线，不静默降级到
 *   错误）；
 * - TieredDistiller：开关关闭 → 蒸馏整体停用（触发判定恒 False、蒸馏
 *   恒无产物）；开关开启且有模型链 → 可走 LLM 蒸馏（异步入口
 *   distill_async，LLM 调用回调由实现方注入），链缺失 → 回落确定性
 *   蒸馏基线（零 LLM 调用，可测试可断言）；触发阈值（复杂度/干预双
 *   阈值）委托确定性基线，防「蒸馏垃圾进垃圾出」的保守语义不被开关/
 *   链配置削弱。
 */

import { isRecord, type JsonRecord } from '../json.js';
import { build_tier_chain } from '../tiers/tiers.js';
import {
  DEFAULT_COMPLEXITY_THRESHOLD,
  DEFAULT_DISTILL_TIER,
  DEFAULT_INTERVENTION_THRESHOLD,
} from './_types.js';
import { DeterministicDistiller, DistillConfig } from './distill.js';
import type { ExecutionSignal } from './signals.js';

/**
 * 按挡位构建蒸馏模型链（router 建链，配置缺失回落 main_config）。
 *
 * Args:
 *   model_config: 用户模型配置字典（可含 router_config/main_config）。
 *   tier: 建链挡位（默认 router）。
 *   options.create/retry: 适配器工厂与重试策略注入（透传挡位建链）。
 *
 * Returns:
 *   模型链（configs 观察面）；主/router 挡位均无配置时返回 null——
 *   由 TieredDistiller 回落确定性蒸馏基线，不静默降级到错误。
 */
export function resolve_distill_chain(
  model_config: JsonRecord | null | undefined,
  tier: string | null = null,
  options: { create?: (config: JsonRecord) => unknown; retry?: unknown } = {},
): ReturnType<typeof build_tier_chain> {
  return build_tier_chain(model_config, tier ?? DEFAULT_DISTILL_TIER, options);
}

/**
 * 挡位蒸馏器：distill_enabled 开关 + router 挡位建链 + 确定性回落。
 *
 * deterministic 基线注入面按蒸馏器协议（Distiller）放开的语义落为
 * DeterministicDistiller（协议扩展方自带蒸馏策略、共用本类的触发判定）。
 */
export class TieredDistiller {
  readonly config: DistillConfig;
  readonly chain: ReturnType<typeof build_tier_chain>;
  readonly deterministic: DeterministicDistiller;

  constructor(
    options: {
      config?: DistillConfig | null;
      chain?: unknown | null;
      deterministic?: DeterministicDistiller | null;
      complexity_threshold?: number;
      intervention_threshold?: number;
    } = {},
  ) {
    this.config = options.config ?? new DistillConfig();
    this.chain = (options.chain ?? null) as ReturnType<typeof build_tier_chain>;
    this.deterministic =
      options.deterministic ??
      new DeterministicDistiller({
        complexity_threshold:
          options.complexity_threshold ?? DEFAULT_COMPLEXITY_THRESHOLD,
        intervention_threshold:
          options.intervention_threshold ?? DEFAULT_INTERVENTION_THRESHOLD,
      });
  }

  /** 按需触发判定：开关关闭恒 False；开启后走双阈值保守语义。 */
  should_distill(options: { complexity?: number; interventions?: number } = {}): boolean {
    if (!this.config.enabled) return false;
    return this.deterministic.should_distill(options);
  }

  /** 同步蒸馏入口（确定性基线路径；模型链路径走异步入口）。
   *
   * 开关关闭恒 null；同步路径恒走确定性蒸馏（零 LLM 调用、可测试可
   * 断言）——配置了模型链的蒸馏经 distill_async 走 LLM 回调，二者不
   * 混叠。
   */
  distill(signals: readonly ExecutionSignal[]): JsonRecord | null {
    if (!this.config.enabled) return null;
    return this.deterministic.distill(signals);
  }

  /** 异步蒸馏入口：链可用时经 LLM 回调蒸馏，失败/缺失回落确定性。
   *
   * Args:
   *   signals: 待蒸馏的信号序列。
   *   options.llm_distill: LLM 蒸馏回调（签名
   *     (chain, signals) -> dict | null；null = 不调用 LLM）。回调返回
   *     null/抛异常 = 本次不产 LLM 产物，回落确定性蒸馏（fail-open——
   *     蒸馏是增强能力，不阻断知识沉淀）。
   */
  async distill_async(
    signals: readonly ExecutionSignal[],
    options: {
      llm_distill?:
        | ((chain: unknown, signals: readonly ExecutionSignal[]) => Promise<unknown>)
        | null;
    } = {},
  ): Promise<JsonRecord | null> {
    if (!this.config.enabled) return null;
    const llm = options.llm_distill ?? null;
    if (this.chain !== null && llm !== null) {
      try {
        const data = await llm(this.chain, signals);
        if (isRecord(data)) return data as JsonRecord;
      } catch {
        // fail-open：LLM 蒸馏失败回落确定性基线，不阻断知识沉淀
      }
    }
    return this.deterministic.distill(signals);
  }
}