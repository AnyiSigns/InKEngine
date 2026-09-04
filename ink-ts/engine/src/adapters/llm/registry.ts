/**
 * LLM 适配器注册机制（新厂商 = 注册新适配器类，配置驱动选择）。
 *
 * 注册表以适配器名 → 适配器类的映射承载「可插拔扩展点」：
 * - 内置协议全名（用户可辨别的常见 API 协议）：openai_compatible
 *   （chat/completions）/ openai_responses（Responses）/ anthropic_messages
 *   （Messages）；旧简称 openai_compat / openai_response / anthropic 注册为
 *   兼容别名（既有配置零迁移）；
 * - 常见 OpenAI 兼容厂商别名（openai/deepseek/zhipu/moonshot/ollama 均指向
 *   OpenAICompatibleLLM 同一类，改 base_url 适配）；
 * - 新厂商：register_adapter 注册适配器类，LLMConfig.adapter 字段驱动选择，
 *   未知 adapter 显式抛 LLMConfigError（fail-fast，附已注册清单）。
 *
 * 内置注册只补缺省名（setdefault 语义）：宿主先 register_adapter 的同名
 * 适配器保持生效，不被惰性内置注册静默覆盖（mirror registry.py）。
 * Python 侧内置注册惰性化（防 import 即要求 httpx）在 TS 侧不必要——
 * 适配器为静态导入，无可选运行时依赖；「补缺省名不覆盖宿主」语义原样保留。
 * Gemini 适配器未迁移到 TS（迁移波未到），注册表只收录已落地的协议类。
 */

import { AsyncLLM, LLMConfig } from '../../core/llm/base.js';
import { LLMConfigError } from '../../core/llm/errors.js';
import { AnthropicLLM } from './anthropic.js';
import { OpenAICompatibleLLM } from './openai_compat.js';
import { OpenAIResponsesLLM } from './openai_response.js';

/** 适配器类形态：以 LLMConfig 单参构造即产出 AsyncLLM 实例。 */
export type LLMAdapterCtor = new (config: LLMConfig) => AsyncLLM;

/** 注册表本体（mirror python _LLM_REGISTRY；导出便于测试清理同名条目）。 */
export const _LLM_REGISTRY: Map<string, LLMAdapterCtor> = new Map();

/** 内置注册完成标志（保证只做一次 setdefault 补缺省名）。 */
let _BUILTINS_REGISTERED = false;

// OpenAI 兼容厂商别名 → 内置适配器（注册表按需扩容，未知厂商显式报错）
const _OPENAI_COMPAT_ALIASES = [
  'openai_compatible', // 协议全名（规范名）
  'openai_compat', // 兼容别名（旧配置零迁移）
  'openai',
  'deepseek',
  'zhipu',
  'moonshot',
  'ollama',
] as const;

/** 惰性注册内置适配器（首次访问注册表面时执行一次，只补缺省名）。 */
function _ensure_builtins(): void {
  if (_BUILTINS_REGISTERED) {
    return;
  }
  for (const name of _OPENAI_COMPAT_ALIASES) {
    if (!_LLM_REGISTRY.has(name)) {
      _LLM_REGISTRY.set(name, OpenAICompatibleLLM);
    }
  }
  // 原生协议厂商各自独立适配器（非 OpenAI 兼容包装）
  for (const [name, cls] of [
    ['anthropic_messages', AnthropicLLM],
    ['anthropic', AnthropicLLM], // 兼容别名（旧配置零迁移）
    ['openai_responses', OpenAIResponsesLLM],
    ['openai_response', OpenAIResponsesLLM], // 兼容别名（旧配置零迁移）
  ] as const) {
    if (!_LLM_REGISTRY.has(name)) {
      _LLM_REGISTRY.set(name, cls);
    }
  }
  _BUILTINS_REGISTERED = true;
}

/**
 * 注册适配器类（可覆盖同名——宿主可换掉内置实现）。
 *
 * 显式赋值允许宿主/后注册覆盖同名适配器；空注册名显式抛 LLMConfigError。
 */
export function register_adapter(name: string, cls: LLMAdapterCtor): void {
  if (!name) {
    throw new LLMConfigError('适配器注册名不能为空');
  }
  // python 侧缺 httpx 时内置注册被 suppress——TS 静态导入恒可用，无需抑制
  _ensure_builtins();
  _LLM_REGISTRY.set(name, cls);
}

/** 已注册适配器名（有序清单；访问注册表面时内置注册先落位）。 */
export function adapter_names(): string[] {
  _ensure_builtins();
  return [..._LLM_REGISTRY.keys()].sort();
}

/** 取适配器类（未注册返回 null，不抛错）。 */
export function get_adapter_class(name: string): LLMAdapterCtor | null {
  _ensure_builtins();
  return _LLM_REGISTRY.get(name) ?? null;
}

/**
 * 按配置创建 LLM 实例（配置驱动选择适配器）。
 *
 * @param config LLMConfig 或配置字典（dict 形态与既有模型配置兼容）。
 * @throws LLMConfigError 适配器未注册 / 配置缺字段时。
 */
export function create_llm(config: LLMConfig | Record<string, unknown>): AsyncLLM {
  const cfg = config instanceof LLMConfig ? config : LLMConfig.from_dict(config);
  _ensure_builtins();
  const cls = _LLM_REGISTRY.get(cfg.adapter);
  if (cls === undefined) {
    const registered = adapter_names();
    const listing = registered.length > 0 ? registered.join(', ') : '无';
    throw new LLMConfigError(
      `未注册的 LLM 适配器: '${cfg.adapter}'（已注册: ${listing}）`,
    );
  }
  return new cls(cfg);
}
