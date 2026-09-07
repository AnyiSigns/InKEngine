/**
 * host 测试静态图配方（仅保留审批挂卡演示一个：rounds 已走组装，宿主不产
 * 任何产品图；gate 静态图仅测试经引擎静态图兼容通道注入后触发审批卡）。
 * 机制全在 engine（approval/interrupt），host 只提供图数据。
 */

import { Graph, approve_before_execute } from '@ink-ts/engine';
import type { GraphRecipeContext } from '@ink-ts/engine';

/** 审批挂卡图：agent 节点对 demo 动作走 approve_before_execute（决策写入
 *  state.reply：accept → approved / reject → skipped）。 */
export function gateGraphRecipe(_ctx: GraphRecipeContext): Graph {
  const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
    const nodeCtx = raw as {
      state: Record<string, unknown>;
      interrupt(key: string, payload: Record<string, unknown>): Promise<unknown>;
      get_interrupt_payload?(key: string): Promise<Record<string, unknown> | null>;
    };
    const decision = await approve_before_execute(
      nodeCtx,
      'gate:demo',
      { tool: 'demo_tool', summary: 'host bridge 审批冒烟' },
      { payload: { kind: 'demo' } },
    );
    // reply = 决议原文（accept/edit/reject/terminate/auto），供桥侧单测断言
    // 每种决议都原样抵达引擎裁决层（不经宿主侧双重包装回落 invalid/reject）。
    return { reply: decision.decision };
  };
  const graph = new Graph({ name: 'gate', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}
