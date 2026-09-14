/**
 * llm 端口提供方 logic 入口（S0 契约：默认导出 = 端口实现工厂）。
 *
 * 端口实装位：llm_port（协议适配器注册/创建）。注册表/适配器实现随插件
 * 同住 registry/anthropic/openai_* 等；本文件只做包装与工厂默认导出——
 * 装卸侧按 manifest「ports」段装载默认导出工厂，产出 { create_llm,
 * register_adapter, ... } 注入引擎 seam（与旧 create_llm 同一语义 slot）。
 */

export type { LLMAdapterCtor } from './registry.js';
import { adapter_names, create_llm, get_adapter_class, register_adapter } from './registry.js';
export { adapter_names, create_llm, get_adapter_class, register_adapter } from './registry.js';

/**
 * S0 端口提供方默认导出 = 端口实现工厂（`(init?) => 端口实现实例`，装载器
 * 只装载不解析；llm 实例 = 协议注册/创建面，仓库装配取用）。
 */
export default function createLlmPort(): Record<string, unknown> {
  return { adapter_names, create_llm, get_adapter_class, register_adapter };
}