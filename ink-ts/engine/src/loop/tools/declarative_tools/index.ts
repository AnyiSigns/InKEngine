/**
 * 声明式工具公开面（declarative_tools.py __all__ 镜像）。
 *
 * 语义检查点：注册新工具 = 声明一条数据（name/description/参数 schema/
 * 强制权限/端点类型），执行体经执行体注册表分发（宿主注入）；未声明
 * 权限 = 定义期拒绝（fail-closed 提前到建表期）；端点类型与沙箱守卫
 * 联动（判定目标推导供门禁/沙箱环节消费）；声明式工具过完整流水线
 * （门禁 → 沙箱 → 守卫 → 审批 → 审计 → 轨迹）。
 *
 * 实现拆分为数据/判定/装配/执行四层文件（≤350 行纪律）：
 * - endpoint_types / endpoint_registry：端点类型域与内置注册表单例；
 * - declarative_spec：声明式定义（数据形态 + 定义期校验）；
 * - operations / _hooks：判定目标推导与失败原因；
 * - executors / _http_executors / bridge：执行体注册表与流水线钩子；
 * - _gates / pipeline：定义门禁、网络审批桥、懒解析沙箱与装配；
 * - contracts_bridge：工具表 → 结点契约映射。
 */
export { EndpointType, EndpointTypeRegistry, EndpointTypeSpec } from './endpoint_types.js';
export type { EndpointExtractor, EndpointFailureReason } from './endpoint_types.js';
export { endpoint_registry } from './endpoint_registry.js';
export { DeclarativeToolSpec } from './declarative_spec.js';
export type { DeclarativeToolSpecInit } from './declarative_spec.js';
export { DeclarativeToolExecutors } from './executors.js';
export type { DeclarativeExecutor } from './executors.js';
export { coerce_argv } from './_hooks.js';
export {
  RETRIEVAL_CONTROLLED_FETCH,
  controlled_fetch_call,
  declarative_failure_reason,
  declarative_operation,
  endpoint_operation,
  endpoint_operation_failure_reason,
} from './operations.js';
export { make_declarative_extractor, make_declarative_failure_reason } from './bridge.js';
export { build_declarative_pipeline } from './pipeline.js';
export type { BuildDeclarativePipelineOptions } from './pipeline.js';
export {
  make_controlled_fetch_executor,
  make_http_fetch_executor,
} from './_http_executors.js';
export type { HttpStreamClient, HttpStreamResponse } from './_http_executors.js';
export {
  node_contracts_from_tools,
  tool_contract_from_declaration,
  tool_node_mapping,
  validate_tool_node_consistency,
} from './contracts_bridge.js';
