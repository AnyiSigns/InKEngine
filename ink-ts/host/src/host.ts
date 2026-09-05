/**
 * Host 五件套实现（机制语义在 engine，host 只装配不复制）。
 *
 * - create_storage：engine adapters/storage 工厂（memory/sqlite 路由），
 *   连接串来自配置；
 * - resolve_llm：引擎 model_roles 按 agent 槽解析主配置 + 备用链
 *   （resolve_role_model，CODING §8 回落语义单点），经 llm/registry
 *   create_llm 或 ModelChain 装配为 AsyncLLM 形态——厂商只是端点配置，
 *   协议决定适配器；
 * - interrupt_policy：默认 fail-closed（autoApprove 仅显式 true 才直过）；
 * - build_transport：事件落文件实时刷新，每轮一个 JSONL 文件；
 * - close：幂等关停（LLM 链 aclose + 未关传输收口），由 Runtime.stop 调用。
 *
 * 类型说明：engine 公开 AsyncLLM 契约（core/llm/base）与 Runtime 装配内部
 * 守卫链 seam（_guard_types）为结构近似但类型不平等的协议形态——宿主实现
 * 按 e2e 纪律经鸭子转换进入 Runtime（core 不反向依赖适配器）。
 */

import { mkdirSync } from 'node:fs';

import {
  AsyncLLM,
  DefaultInterruptPolicy,
  ModelChain,
  RetryPolicy,
  ROLE_AGENT,
  create_llm,
  create_storage,
  resolve_role_model,
} from '@ink-ts/engine';
import type { EngineTransport, InterruptPolicy, Storage } from '@ink-ts/engine';

import type { ResolvedHostConfig } from './config.js';
import { FileEventsTransport } from './transport.js';

/** 显式 autoApprove 放行策略：所有动作直过（should_approve=false）。 */
class AutoApprovePolicy implements InterruptPolicy {
  should_approve(): boolean {
    return false;
  }

  timeout_for(): number | null {
    return null;
  }
}

/** host 运行资源面：宿主五件套 + 事件文件收口。 */
export class InkHost {
  readonly config: ResolvedHostConfig;
  private _llm: AsyncLLM | null = null;
  private readonly _transports: FileEventsTransport[] = [];
  private _closed = false;

  constructor(config: ResolvedHostConfig) {
    this.config = config;
  }

  /** 存储工厂：engine adapters 路由 memory:// / sqlite:///path。 */
  async create_storage(): Promise<Storage> {
    return create_storage(this.config.storage_uri);
  }

  /**
   * 模型解析：agent 槽主配置 + 备用链 → LLM 实例（null = 未配置模型）。
   * 单配置 create_llm 直建；多配置走 ModelChain（fallback 链由 llm 层承载）。
   */
  async resolve_llm(): Promise<AsyncLLM | null> {
    if (this._llm !== null) return this._llm;
    const resolved = resolve_role_model(
      this.config.model_config as unknown as Parameters<typeof resolve_role_model>[0],
      ROLE_AGENT,
    );
    if (resolved.config === null) return null;
    const configs = [resolved.config, ...resolved.fallbacks];
    const llm: AsyncLLM =
      configs.length === 1
        ? create_llm(configs[0] as unknown as Record<string, unknown>)
        : (new ModelChain(configs as never[], {
            create: (cfg) =>
              create_llm(cfg as unknown as Record<string, unknown>),
            retry: new RetryPolicy(),
          }) as unknown as AsyncLLM);
    this._llm = llm;
    return llm;
  }

  /** 审批策略：autoApprove 显式 true = 直过；否则 fail-closed 全量挂起。 */
  interrupt_policy(): InterruptPolicy {
    if (this.config.autoApprove) return new AutoApprovePolicy();
    return new DefaultInterruptPolicy(
      new Set<string>(),
      new Set<string>(),
      this.config.approval_timeout,
    );
  }

  /** 事件传输工厂：每轮一个 JSONL 事件文件（events 目录，实时 flush）。 */
  build_transport(): EngineTransport {
    if (this._closed) {
      throw new Error('host 已关停（build_transport 不可用）');
    }
    mkdirSync(this.config.events_dir, { recursive: true });
    const seq = this._transports.length + 1;
    const file = `${this.config.events_dir}/${seq.toString().padStart(4, '0')}-events.jsonl`;
    const transport = new FileEventsTransport(file);
    this._transports.push(transport);
    return transport as unknown as EngineTransport;
  }

  /** 幂等关停：释放 LLM 链 + 收口全部事件文件流。 */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const llm = this._llm;
    this._llm = null;
    if (llm !== null) {
      try {
        await llm.aclose();
      } catch {
        // LLM 链关闭失败（继续收口其它资源）
      }
    }
    const transports = this._transports.splice(0);
    for (const transport of transports) {
      try {
        await transport.close();
      } catch {
        // 事件文件关闭失败（忽略）
      }
    }
  }
}
