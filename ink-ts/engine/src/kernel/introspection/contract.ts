/**
 * introspection 机制件契约声明：自指层观察原语（引擎运行形态的只读 JSON
 * 快照通道）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——introspection 把引擎
 * 持有的运行时数据整理为确定性快照（图结构/规则集/知识集/界面/工具表/实体
 * 目录），快照出口统一过敏感信息剥离；数据源经注入的 IntrospectionSources
 * 按引用读取（不直接消费存储 seam），工具经标准工具流水线执行（判定动作
 * 固定 read——纯只读通道，不触文件/进程/网络执行信封），本机制 src 不发
 * 模型调用、不读写 Storage 记录、不消费回合端口（观察结果供模型消费，是
 * 上游装配面，非本机制内调用）。0-IO：不自持 IO。故 effects 为空。
 *
 * depends：introspection 组合 llm（ToolSpec 工具描述数据面）、permissions
 * （PermissionGate 门禁装配）与 tool_pipeline（ToolPipeline 标准流水线执行）。
 * 契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** introspection 机制契约：依赖 llm/permissions/tool_pipeline，零副作用端口（只读观察）。 */
export const introspection_contract: MechanismContract = {
  id: 'introspection',
  contract: {
    effects: [],
  },
  depends: ['llm', 'permissions', 'tool_pipeline'],
};
