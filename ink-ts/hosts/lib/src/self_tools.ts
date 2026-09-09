/**
 * 产品自指工具执行器（P4-B-1 续跑意图接线点）。
 *
 * 产品配方 tool_wiring 的 self_executor_factory 用本执行器包一层内核
 * make_self_executor：apply_patch 受控写落地成功后（显式进化），把当前回合
 * state 的续跑意图键置上（ROUND_CONTINUATION_STATE_KEY = {reason:'evolved'}）
 * ——引擎回合收尾按 P4-A 协议自动发起下一轮（护栏 = 配方 auto_continue_limit，
 * 宿主不重复做）。propose/revert 不续、apply 未落地不续：只有"落地成功"才
 * 算显式进化。落地信号取自 apply_patch 的内核 JSON 响应（ok=true）；读取经
 * ctx.state（节点上下文状态读写面，引擎公共面声明的可选成员），离线/单测
 * 上下文无 state = 直通不写。
 */

import {
  ROUND_CONTINUATION_STATE_KEY,
  make_self_executor,
} from '@ink-ts/engine';
import type {
  SelfApplicationPipeline,
  SelfToolContext,
  SelfToolExecutor,
  SelfToolNodeContext,
  ToolSpec,
} from '@ink-ts/engine';

/** 契约自指工具名：受控写落地（apply_patch = 显式进化，触发续跑意图）。 */
const APPLY_PATCH_TOOL = 'apply_patch';

/** apply_patch 内核响应的落地判定字段面（JSON 文本解析结果）。 */
interface ApplyResponse {
  ok?: unknown;
  patch_id?: unknown;
}

/** 解析自指工具 JSON 文本 → 落地判定面（前置标注/非 JSON = null 不判定）。
 *  审批策略 auto 直过时工具流水线会在结果前置「已自动批准」标注，故从首个
 *  '{' 起取对象段容错解析。 */
function parseApplyResponse(text: string): ApplyResponse | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as ApplyResponse;
  } catch {
    return null;
  }
}

/** 产品自指执行器（内核执行器 + 续跑意图写）：签名与 make_self_executor 同构，
 *  供产品配方 tool_wiring.self_executor_factory 装配。core 为测试 seam（缺省
 *  = 内核执行器；注入假内核可单测续跑意图写而无需真实自指管线）。 */
export function make_product_self_executor(
  pipeline: SelfApplicationPipeline,
  context_getter: () => SelfToolContext,
  core?: SelfToolExecutor,
): SelfToolExecutor {
  const execute = core ?? make_self_executor(pipeline, context_getter);
  return async (
    ctx: SelfToolNodeContext,
    spec: ToolSpec,
    args: Record<string, unknown>,
    approval: unknown,
  ): Promise<string> => {
    const text = await execute(ctx, spec, args, approval);
    if (spec.name !== APPLY_PATCH_TOOL) return text;
    const state = ctx.state;
    if (state === undefined || state === null) return text;
    const response = parseApplyResponse(text);
    if (response === null || response.ok !== true) return text;
    const meta: Record<string, unknown> = {};
    if (response.patch_id !== undefined && response.patch_id !== null) {
      meta['patch_id'] = response.patch_id;
    }
    state[ROUND_CONTINUATION_STATE_KEY] = { reason: 'evolved', meta };
    return text;
  };
}
