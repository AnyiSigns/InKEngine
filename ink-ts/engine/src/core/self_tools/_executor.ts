/**
 * 契约自指工具执行器（core/self_tools.py make_self_executor 移植）。
 *
 * 宿主扩展（如种子沉淀）组合本执行器：契约工具名走内核行为，扩展名
 * 走宿主实现，未知名显式拒绝（fail-closed）。执行器为统一流水线分发
 * 用：ctx/spec/args/approval → JSON 文本。
 */

import { GraphDefinitionError } from '../errors.js';
import type { SelfApplicationPipeline } from '../self_application/index.js';
import { _apply, _propose, _propose_domain, _revert } from './_proposal_ops.js';
import { _request_tool, _search_tools } from './_discover_ops.js';
import type { SelfToolContext, SelfToolExecutor, SelfToolNodeContext } from './_types.js';
import type { ToolSpec } from '../llm/tools.js';

/**
 * 契约自指工具执行器（统一流水线分发用；ctx/spec/args/approval → 文本）。
 *
 * @param pipeline 自指应用管线（装配可见；context_getter 返回的执行上下
 *   文即以此为 self_pipeline，与宿主装配一致）。
 * @param context_getter 执行上下文取用器（宿主每次调用解析上下文——
 *   与 Python 端 context_getter 同构）。
 */
export function make_self_executor(
  _pipeline: SelfApplicationPipeline,
  context_getter: () => SelfToolContext,
): SelfToolExecutor {
  return async (
    ctx: SelfToolNodeContext,
    spec: ToolSpec,
    args: Record<string, unknown>,
    _approval: unknown,
  ): Promise<string> => {
    const context = context_getter();
    if (spec.name === 'propose_patch') return _propose(ctx, context, args);
    if (spec.name === 'propose_domain_manifest') return _propose_domain(ctx, context, args);
    if (spec.name === 'apply_patch') return _apply(ctx, context, args);
    if (spec.name === 'revert_patch') return _revert(ctx, context, args);
    if (spec.name === 'search_tools') return _search_tools(ctx, context, args);
    if (spec.name === 'request_tool') return _request_tool(ctx, context, args);
    throw new GraphDefinitionError(`未知自指工具: ${spec.name}`);
  };
}
