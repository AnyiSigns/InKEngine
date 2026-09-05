/**
 * 上下文调配器门面：确定性组装 + 可选 LLM 融合钩子（context.py 移植）。
 *
 * - 注册融合钩子（或 mix 调用时注入）→ 优先融合：融合产出即最终文本，
 *   且留痕 fused=True；融合返回 null / 抛异常 → 自动回退确定性组装
 *   （fail-open，融合成本 = 按需额外 LLM 调用，不默认）；
 * - 未直接注入钩子时，可按 ``fusion_registry`` 注册表按名取钩子
 *   （注册表有真实消费方，多策略注册经名称选择参与融合）；
 * - 未注册任何钩子 → 纯确定性组装，零额外 LLM 调用。
 *
 * 状态标注（机制就绪 / 宿主接线点待定）：上下文融合器——context 组装默认
 * 注册内置融合器位（当前无 src 消费方），接线点：assembly/context 组装链
 * （默认确定性组装，融合钩子按需注入/注册）。
 */

import {
  AssembledContext,
  ContextSource,
} from './context_types.js';
import { ContextAssembler } from './context_assembler.js';

/**
 * LLM「调酒师」融合钩子接口（按需/候选融合，注册制）。
 *
 * 实现约定：
 * - 对给定源列表按指令融合为连贯上下文段（深度融合/候选语义融合）；
 * - 返回 null = 本次不融合（宿主显式拒绝，走确定性组装）；
 * - 融合失败不得抛错——抛错由调用方捕获并回退确定性组装（fail-open，
 *   融合是增强能力，不阻断主流程）。
 */
export interface FusionHook {
  fuse(
    sources: readonly ContextSource[],
    opts: {
      instruction: string;
      budget_chars: number;
      context?: Record<string, unknown> | null;
    },
  ): Promise<string | null>;
}

/**
 * 融合钩子注册表（新增融合策略 = 注册新钩子类，装配核心零改动）。
 *
 * 插拔语义：同名重复注册 = 覆盖（宿主启动按配置装配，配置驱动）。
 * 消费方 = ContextMixer：mix 未直接注入 fusion_hook 时，按 fusion_hook_name
 * 从注册表取钩子。
 */
export class FusionRegistry {
  private hooks = new Map<string, FusionHook>();

  register(name: string, hook: FusionHook): void {
    if (!name) throw new RangeError('融合钩子名称不能为空');
    this.hooks.set(name, hook);
  }

  /** 按名取钩子（未注册返回 null，宿主自行决定是否回退确定性组装）。 */
  get(name: string): FusionHook | null {
    return this.hooks.get(name) ?? null;
  }

  /** 当前已注册钩子名（元组快照）。 */
  get names(): readonly string[] {
    return [...this.hooks.keys()];
  }
}

/** ContextMixer 构造选项。 */
export interface ContextMixerOptions {
  assembler?: ContextAssembler | null;
  fusion_hook?: FusionHook | null;
  fusion_instruction?: string;
  fusion_registry?: FusionRegistry | null;
  fusion_hook_name?: string;
}

/**
 * 调配器门面：确定性组装 + 可选 LLM 融合（按需，失败自动回退）。
 */
export class ContextMixer {
  readonly assembler: ContextAssembler;
  private _fusion_hook: FusionHook | null;
  private _fusion_instruction: string;
  readonly fusion_registry: FusionRegistry | null;
  readonly fusion_hook_name: string;

  constructor(options: ContextMixerOptions = {}) {
    this.assembler = options.assembler ?? new ContextAssembler();
    this._fusion_hook = options.fusion_hook ?? null;
    this._fusion_instruction = options.fusion_instruction ?? '';
    this.fusion_registry = options.fusion_registry ?? null;
    this.fusion_hook_name = options.fusion_hook_name ?? 'default';
  }

  /** 当前注入的融合钩子（运行期可由 attach_fusion 替换）。 */
  get fusion_hook(): FusionHook | null {
    return this._fusion_hook;
  }

  /** 挂载/替换融合钩子（运行期可换，插拔语义）。 */
  attach_fusion(hook: FusionHook, instruction: string = ''): void {
    this._fusion_hook = hook;
    if (instruction) this._fusion_instruction = instruction;
  }

  /**
   * 混合装配入口：有融合钩子先融合，失败/拒绝回退确定性组装。
   */
  async mix(
    sources: readonly ContextSource[],
    opts: { total_chars?: number | null; instruction?: string | null } = {},
  ): Promise<AssembledContext> {
    const total = opts.total_chars ?? this.assembler.default_budget_chars;
    let hook = this._fusion_hook;
    if (hook === null && this.fusion_registry !== null) {
      hook = this.fusion_registry.get(this.fusion_hook_name);
    }
    if (hook !== null && sources.length > 0) {
      try {
        const fused = await hook.fuse(sources, {
          instruction: opts.instruction ?? this._fusion_instruction,
          budget_chars: total,
        });
        if (fused) {
          const text = fused.slice(0, total);
          return new AssembledContext(text, [], [], total, text.length, true);
        }
        // 融合钩子返回 null/空串：宿主显式拒绝，走确定性组装
      } catch {
        // fail-open：融合失败不阻断主流程，回退确定性组装
      }
    }
    return this.assembler.assemble(sources, { total_chars: total });
  }
}