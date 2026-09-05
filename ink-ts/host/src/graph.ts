/**
 * 产品默认图配方（宿主域服务阶段定稿的内置产品图；调用方可覆写）。
 *
 * chat 图 = 单 agent 节点：装配模型（ctx.llm 守卫链）流式回复，token 逐帧
 * 经 reply_token 事件发射并累积 state.reply；无模型 = 确定性 stub 回复
 * （无真实模型也能稳定抵达回复态）。机制全在 engine，本文件只出图数据。
 */

import type { Graph, GraphRecipeContext } from '@ink-ts/engine';
import { Graph as GraphImpl, system, user } from '@ink-ts/engine';

/** 确定性 stub 回复（无模型兜底；与 cli stub 语义一致）。 */
export const STUB_REPLY = '（host 默认会话已执行）';

interface AgentNodeCtx {
  state: Record<string, unknown>;
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
}

/** 产品默认 chat 图（llm 缺省 null = 确定性 stub 路径）。 */
export function productChatGraphRecipe(ctx: GraphRecipeContext): Graph {
  const llm = ctx.llm;
  const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
    const nodeCtx = raw as AgentNodeCtx;
    const input = String(nodeCtx.state['input'] ?? '');
    if (llm === null || llm === undefined) {
      await nodeCtx.emit('reply_token', { token: STUB_REPLY });
      return { reply: STUB_REPLY };
    }
    const messages = [system('ink-ts host 助手'), user(input)];
    let reply = '';
    for await (const chunk of llm.astream(messages, { tools: null, params: null })) {
      const token = chunk.token;
      if (token) {
        reply += token;
        await nodeCtx.emit('reply_token', { token });
      }
    }
    const finalReply = reply.trim() === '' ? STUB_REPLY : reply;
    return { reply: finalReply };
  };
  const graph = new GraphImpl({ name: 'chat', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}
