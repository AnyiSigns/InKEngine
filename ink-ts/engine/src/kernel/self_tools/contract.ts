/**
 * self_tools 机制件契约声明：自指元工具契约面（提案/应用/回退/领域清单提案/
 * 检索/绑定 6 个契约工具，输出 JSON 文本，走统一执行器分发）。
 *
 * 契约面：effects 为空——机制 src 不直接消费任何副作用端口：补丁写入与审批
 * 经注入的自指应用管线（self_application 值面，非本机制 seam 消费）；工具
 * 检索读取注入的 core 工具向量索引对象（检索不到 = 显式降级），绑定打标/
 * 端点探活/收敛管制为宿主注入的可选钩子回调（tool_tagger / endpoint_probe /
 * convergence），均不经 storage_seam / llm_port / exec_envelope / rounds.port
 * 四端口面。0-IO：不自持 IO，除显式构造的检索/绑定响应数据外无读写。
 *
 * depends = 值面机制清单：llm（ToolSpec 工具描述协议）、self_proposal（补丁
 * 类型值集合与提案构造判定）、tool_pipeline（执行上下文 seam 与结果上限等
 * 常量）。self_application / approval 仅作类型引用（SelfApplicationPipeline
 * 等类型面），不构成值级装配依赖，故不入列。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** self_tools 机制契约：零副作用端口，值依赖工具描述/提案协议/工具流水线。 */
export const self_tools_contract: MechanismContract = {
  id: 'self_tools',
  contract: {
    effects: [],
  },
  depends: ['llm', 'self_proposal', 'tool_pipeline'],
};
