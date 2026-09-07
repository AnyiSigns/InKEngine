/**
 * llm 机制件契约声明：统一 LLM 接入面（AsyncLLM 协议 + 守卫链 + 模型链 +
 * 调用缓存）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——llm 的包装器与模型链
 * 对注入的 AsyncLLM 实例直接发 LLM 调用（UsageTrackingLLM/CompressingLLM
 * 与 CachingLLM 调 _inner.ainvoke/astream；ModelChain 经注入的 create 工厂
 * 惰性建模型后调 ainvoke/astream），真实适配器由宿主按配置注入，属
 * llm_port 端口面（模型推理 seam）。CachingLLM 走 Storage records 通道持久
 * 化缓存（CACHE_COLLECTION，get_record/put_record/list_records/
 * delete_collection），属 storage_seam 端口面；适配器实时传输/SSE 解析注册
 * 在适配器层，不在本机制。0-IO：不自持 IO，只调声明端口。
 *
 * depends：llm 引用 builder 的纯 TS sha256（_sha256，缓存指纹与内容寻址，
 * core 禁 node:crypto）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';
import { PORT_LLM_PORT, PORT_STORAGE_SEAM } from '../registry/ports.js';

/** llm 机制契约：依赖 builder，消费 storage_seam 缓存落库 + llm_port 推理端口面。 */
export const llm_contract: MechanismContract = {
  id: 'llm',
  contract: {
    effects: [PORT_STORAGE_SEAM, PORT_LLM_PORT],
  },
  depends: ['builder'],
};
