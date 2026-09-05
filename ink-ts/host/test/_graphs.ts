/**
 * host 测试图配方（镜像 engine e2e 图语义的最小面）：
 * - chatGraph：agent 节点用 ctx.llm（引擎装配守卫链）流式回复，token 逐帧
 *   发 reply_token 事件并累积为 state.reply（无工具循环，装配冒烟用）；
 * - gateGraph：agent 节点对固定动作走 approve_before_execute（审批卡挂起/
 *   注入裁决），供 approval bridge 单测。
 * 机制全在 engine（approval/interrupt），host 只提供图数据。
 */

import { Graph, approve_before_execute, system, user } from '@ink-ts/engine';
import type { GraphRecipeContext } from '@ink-ts/engine';

/** 模型回复图（minimal chat）：reply = 流式拼装内容。 */
export function chatGraphRecipe(ctx: GraphRecipeContext): Graph {
  const llm = ctx.llm;
  const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
    const nodeCtx = raw as {
      state: Record<string, unknown>;
      emit(type: string, payload: Record<string, unknown>): Promise<void>;
    };
    if (llm === null || llm === undefined) {
      throw new Error('host 冒烟需注入模型（config.model_config.agent_config）');
    }
    const messages = [system('测试助手'), user(String(nodeCtx.state['input'] ?? ''))];
    let reply = '';
    for await (const chunk of llm.astream(messages, { tools: null, params: null })) {
      if (chunk.token) {
        reply += chunk.token;
        await nodeCtx.emit('reply_token', { token: chunk.token });
      }
    }
    return { reply };
  };
  const graph = new Graph({ name: 'chat', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}

/** 回声图（无模型依赖；bridge/config 单测免假服务跑通回合）。 */
export function echoGraphRecipe(_ctx: GraphRecipeContext): Graph {
  const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
    const nodeCtx = raw as { state: Record<string, unknown> };
    return { reply: `echo:${String(nodeCtx.state['input'] ?? '')}` };
  };
  const graph = new Graph({ name: 'echo', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}

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
    return { reply: decision.decision === 'accept' ? 'approved' : 'skipped' };
  };
  const graph = new Graph({ name: 'gate', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}
