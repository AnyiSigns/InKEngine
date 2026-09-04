/**
 * 自指元工具公开面（core/self_tools.py __all__ 镜像）。
 *
 * 观察工具让 AI 看清自己；这套工具让 AI 合法地修改产品形态——提案
 * （propose_patch）校验形态与基准版本但不落链；应用（apply_patch）走
 * 完整管线（校验 → 审批分级 → 补丁链落库 → 活跃态生效）；回退
 * （revert_patch）仅允许链尾补丁；领域生成（propose_domain_manifest）
 * 从高层描述产出新领域清单并提案。全部输出为 JSON 文本（工具流水线
 * 结果契约）。本模块承载 6 个契约工具（SELF_TOOL_CONTRACT，与
 * seeds/boot 的 BOOT_METATOOLS 中演化子集一一对应）——引擎能力，
 * 随机制层走补丁链演化、不随宿主壳漂移。上下文由宿主装配注入
 * （SelfToolContext：self_pipeline/harness_registry/knowledge_set 为内核
 * 组件；convergence/tool_index/tool_tagger/endpoint_probe 为可选钩子）。
 *
 * 实现拆分为常量/上下文/规格/演化操作/发现操作/执行器多文件
 * （≤350 行纪律）：
 * - _constants：权限/thread 标签/契约清单/扫描上限；
 * - _types：ConvergenceHook（可选前置闸门协议）+ SelfToolContext +
 *   执行上下文 seam；
 * - _specs：self_tool_specs（6 契约工具描述）+ operation_of（单一判定
 *   来源）；
 * - _proposal_ops：propose / propose_domain_manifest / apply / revert
 *   与提案构造；
 * - _discover_ops：search_tools / request_tool；
 * - _executor：make_self_executor（统一流水线分发）。
 */
export { PERMISSION_APPLY, PERMISSION_PROPOSE, SELF_TOOL_CONTRACT } from './_constants.js';
export { SelfToolContext } from './_types.js';
export type {
  ConvergenceAssessment,
  ConvergenceHook,
  EndpointProbe,
  SelfToolContextInit,
  SelfToolExecutor,
  SelfToolNodeContext,
  ToolTagger,
} from './_types.js';
export { make_self_executor } from './_executor.js';
export { operation_of, self_tool_specs } from './_specs.js';
