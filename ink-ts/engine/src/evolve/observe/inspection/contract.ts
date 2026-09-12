/**
 * introspection 机制件契约声明：自指层观察原语（引擎运行形态的只读 JSON
 * 快照通道）。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——introspection 把引擎
 * 持有的运行时数据整理为确定性快照（图结构/规则集/知识集/界面/工具表/实体
 * 目录），快照出口统一过敏感信息剥离；数据源经注入的 IntrospectionSources
 * 按引用读取（不直接消费存储 seam），工具经统一工具流水线执行（runtime 装配
 * 的 tool_pipeline 按只读判定路由——本机制不自造独立流水线），src 不发
 * 模型调用、不读写 Storage 记录、不消费回合端口。0-IO：不自持 IO。effects
 * 为空。
 *
 * depends：introspection 只 value 组合 llm（ToolSpec 工具描述数据面）；
 * tool_pipeline/permissions 仅 type 引用（executor seam 数据形态），不构成
 * 装配值依赖。契约化归属见 engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../../../dock/registry/contract_types.js';

/** introspection 机制契约：value 依赖 llm，零副作用端口（只读观察）。 */
export const introspection_contract: MechanismContract = {
  id: 'introspection',
  contract: {
    effects: [],
  },
  depends: ['llm'],
};
