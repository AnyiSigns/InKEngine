/**
 * host 测试审批挂卡数据图装配（仅保留审批演示一个：rounds 已走组装，宿主不产
 * 任何产品图）。B3 后引擎无常驻静态引擎——审批卡演示经 runtime 按数据图
 * 构建本轮引擎（_build_graph_engine）触发审批卡：机制全在 engine
 * （approval/interrupt），host 只给图数据 + 节点执行体。
 */

import { approve_before_execute } from '@ink-ts/engine';
import type { Engine, Runtime } from '@ink-ts/engine';

/** 测试门禁节点类型名（数据图按类型名引用注册表执行体）。 */
export const GATE_NODE_TYPE = 'host.gate.agent';

/** 挂起卡经 checkpoint 随 state 落库的图定义键（与 engine 回合状态契约同键）。 */
const ROUND_GRAPH_STATE_KEY = '_round_graph';

/** 审批挂卡图数据：agent 节点对 demo 动作走 approve_before_execute（决策写入
 *  state.reply：accept → approved / reject → skipped，reply = 决议原文）。 */
export function gateGraphData(): Record<string, unknown> {
  return {
    name: 'gate',
    entry: 'agent',
    nodes: { agent: { type: GATE_NODE_TYPE, config: {} } },
    edges: {},
    exits: ['agent'],
    subgraphs: {},
    schema: null,
  };
}

/** 注册审批挂卡节点类型到 runtime（幂等；测试临时执行体不进声明式登记）。 */
export function installGateNode(runtime: Runtime): void {
  const registry = runtime.graph_registries?.nodes;
  if (registry === null || registry === undefined || registry.has(GATE_NODE_TYPE)) return;
  registry.register(GATE_NODE_TYPE, () => async (raw: unknown): Promise<Record<string, unknown>> => {
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
  });
}

/** 经 runtime 按数据图构建 gate 本轮引擎跑一张挂起卡（checkpoint 随 state 落图
 *  定义，approval.resolve 据此按图重建续跑）。 */
export async function runGateCard(runtime: Runtime, thread_id: string): Promise<void> {
  const anyRt = runtime as unknown as {
    _build_graph_engine(
      data: Record<string, unknown>,
      opts?: { llm?: unknown | null; domain?: string | null },
    ): Promise<Engine>;
  };
  installGateNode(runtime);
  const data = gateGraphData();
  const engine = await anyRt._build_graph_engine(data, {});
  const state: Record<string, unknown> = { [ROUND_GRAPH_STATE_KEY]: data };
  await engine.ainvoke(state, {
    thread_id,
    round_id: `r-${thread_id}`,
    continue_chain: true,
  });
}
