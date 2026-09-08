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
 *   能力记录 auto_approve_tools / auto_approve_all_review 并入策略——策略
 *   实例为活读面（每次判定读当前记录），capability.put 后下个请求生效；
 * - build_transport：事件落文件实时刷新，每轮一个 JSONL 文件；
 * - 运行模型配置面（models.config.* 消费）：apply_model_config 校验并合并
 *   变更（关停并置空 _llm 使下轮重解析）、persist/reload 走
 *   data_dir/config.json（掩码回显，见 model_config_runtime.ts）；
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

import { normalize_model_config } from './config.js';
import type { ResolvedHostConfig } from './config.js';
import type { CapabilityRecord } from './capability/store.js';
import { applyProvidersConfig, isRecord } from './model_providers.js';
import {
  load_persisted_model_config,
  masked_model_config,
  merge_model_config,
  model_config_state as assemble_model_config_state,
  write_runtime_model_config,
} from './model_config_runtime.js';
import type { ModelConfigState } from './model_config_runtime.js';
import { FileEventsTransport } from './transport.js';

/**
 * 宿主审批策略（活读面）：autoApprove 显式 true = 全量直过；否则按能力
 * 记录并入——auto_approve_all_review = 全量直过；auto_approve_tools 工具
 * 命中 = 该工具直过；其余 fail-closed 全量挂起（超时窗口 = 配置值）。
 * 每次判定现取 capability.get()，put 后即生效（无需重建）。
 */
class HostInterruptPolicy implements InterruptPolicy {
  private readonly base: DefaultInterruptPolicy;

  constructor(
    private readonly config: ResolvedHostConfig,
    private readonly capability: (() => CapabilityRecord) | null,
  ) {
    this.base = new DefaultInterruptPolicy(
      new Set<string>(),
      new Set<string>(),
      this.config.approval_timeout,
    );
  }

  should_approve(key: string, action: Record<string, unknown>): boolean {
    if (this.config.autoApprove) return false;
    if (this.capability === null) return this.base.should_approve(key, action);
    const record = this.capability();
    if (record.auto_approve_all_review) return false;
    const tool = action['tool'];
    if (typeof tool === 'string' && record.auto_approve_tools.includes(tool)) return false;
    return this.base.should_approve(key, action);
  }

  timeout_for(): number | null {
    if (this.config.autoApprove) return null;
    return this.config.approval_timeout;
  }
}

/** host 运行资源面：宿主五件套 + 事件文件收口。 */
export class InkHost {
  readonly config: ResolvedHostConfig;
  private _llm: AsyncLLM | null = null;
  private readonly _transports: FileEventsTransport[] = [];
  private _closed = false;
  private readonly _capability: (() => CapabilityRecord) | null;
  private _policy: InterruptPolicy | null = null;

  constructor(
    config: ResolvedHostConfig,
    capability: (() => CapabilityRecord) | null = null,
  ) {
    this.config = config;
    this._capability = capability;
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

  /** 运行期应用模型配置：normalize 校验 → 关停并置空 _llm → 合并写回
   *  → 掩码态当前值。变更后由调用方触发引擎重建（下轮回合用新槽）。
   *  输入含 providers = 厂商面整档写：按 picks 派生 agent/router 角色槽
   *  端点后落档（派生逻辑见 model_providers）；否则走既有角色槽直写合并。 */
  async apply_model_config(input: unknown): Promise<Record<string, unknown>> {
    const prevLlm = this._llm;
    this._llm = null;
    if (prevLlm !== null) {
      try {
        await prevLlm.aclose();
      } catch {
        // LLM 链关闭失败（配置仍继续应用）
      }
    }
    const incoming = isRecord(input) ? input : null;
    let next: Record<string, unknown>;
    if (incoming !== null && Array.isArray(incoming['providers'])) {
      const doc = applyProvidersConfig(this.config.model_config, incoming);
      next = { ...doc };
      // 透传入参中非厂商面接管键（与整档合并语义一致：其余键并入）
      for (const [key, value] of Object.entries(incoming)) {
        if (
          ['providers', 'agent_pick', 'router_pick', 'agent_config', 'router_config',
            'agent_fallback_configs', 'router_fallback_configs'].includes(key)
        ) {
          continue;
        }
        if (value === undefined) continue;
        next[key] = value;
      }
    } else {
      const norm = incoming === null ? {} : normalize_model_config(incoming);
      next = merge_model_config(this.config.model_config, norm);
    }
    this.config.model_config = next;
    return masked_model_config(this.config.model_config);
  }

  /** 当前模型配置掩码态（models.config.get 回显；明文不出进程）。 */
  model_config_state(): ModelConfigState {
    return assemble_model_config_state(this.config.model_config);
  }

  /** 变更原子写回运行配置文件（重启由 cli 装配端读取合并）。 */
  async persist_model_config(): Promise<void> {
    write_runtime_model_config(this.config.data_dir, this.config.model_config);
  }

  /** 从运行配置文件重读并应用（models.config.reload；无文件 = 保留当前配置）。 */
  async reload_model_config(): Promise<Record<string, unknown>> {
    const persisted = load_persisted_model_config(this.config.data_dir);
    return this.apply_model_config(persisted ?? {});
  }

  /** 审批策略（惰性单实例活读面）：autoApprove 显式 true = 直过；能力
   *  记录 auto 字段并入（判定时现取，capability.put 后下个请求生效）。 */
  interrupt_policy(): InterruptPolicy {
    if (this._policy === null) {
      this._policy = new HostInterruptPolicy(this.config, this._capability);
    }
    return this._policy;
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
