/**
 * CLI 产品占位图配方（S4 接线阶段；产品图语义在 S6 host 域服务定稿）。
 *
 * 机制全在 engine；本文件只出图数据（宿主产品语义）。图名清单与 argv
 * GRAPH_NAMES 对应（assistant=默认占位 / gate=审批挂卡演示）。
 *
 * - assistant：无模型 = 确定性 stub 回复（镜像 inkling/cli headless 的
 *   stub_script 语义——无真实模型也能稳定抵达回复态），有模型 = 流式聊天
 *   （token 经 reply_token 事件发射，web 事件订阅可观测）；
 * - gate：对 demo 动作走 approve_before_execute。决议策略由 CLI 审批姿态
 *   （--approve 显式声明，D8）构造——显式放行 = 策略直过（should_approve
 *   恒 false），否则全量挂起（fail-closed）。
 */

import {
  DefaultInterruptPolicy,
  Graph,
  approve_before_execute,
  system,
  user,
  type GraphRecipeContext,
  type InterruptPolicy,
} from '@ink-ts/engine';

import type { GraphName } from './argv.js';

/** 确定性 stub 回复文案（无模型兜底；与 headless stub 同语义）。 */
const STUB_REPLY = '（cli stub 回合已执行）';

/** 直过审批策略：所有动作 should_approve=false（与 host AutoApprovePolicy 等价）。 */
class CliAutoApprovePolicy implements InterruptPolicy {
  should_approve(): boolean {
    return false;
  }

  timeout_for(): number | null {
    return null;
  }
}

/** 显式放行 → 直过策略；否则全量挂起策略（fail-closed）。 */
function policyFor(autoApprove: boolean): InterruptPolicy {
  return autoApprove ? new CliAutoApprovePolicy() : new DefaultInterruptPolicy();
}

interface AgentNodeCtx {
  state: Record<string, unknown>;
  emit(type: string, payload: Record<string, unknown>): Promise<void>;
}

/** 流式把文本逐字发射 reply_token 事件（有模型与 stub 共用同一事件面）。 */
async function streamTokens(
  ctx: AgentNodeCtx,
  text: string,
): Promise<string> {
  let reply = '';
  for (const char of text) {
    reply += char;
    await ctx.emit('reply_token', { token: char });
  }
  return reply;
}

/** assistant 图配方（llm 缺省 null = 确定性 stub 路径）。 */
export function assistantGraphRecipe(ctx: GraphRecipeContext): Graph {
  const llm = ctx.llm;
  const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
    const nodeCtx = raw as AgentNodeCtx;
    const input = String(nodeCtx.state['input'] ?? '');
    if (llm === null || llm === undefined) {
      const reply = await streamTokens(nodeCtx, STUB_REPLY);
      return { reply };
    }
    const messages = [system('ink-ts cli 助手'), user(input)];
    const chunked = llm.astream(messages, { tools: null, params: null });
    let reply = '';
    for await (const chunk of chunked) {
      const token = chunk.token;
      if (token) {
        reply += token;
        await nodeCtx.emit('reply_token', { token });
      }
    }
    return { reply: reply.trim() === '' ? STUB_REPLY : reply };
  };
  const graph = new Graph({ name: 'assistant', entry: 'agent' });
  graph.add_node('agent', agent as never);
  graph.add_exit('agent');
  return graph;
}

/** gate 图配方（审批挂卡演示；决议策略随 --approve 姿态，D8）。 */
export function gateGraphRecipe(
  autoApprove: boolean,
): (ctx: GraphRecipeContext) => Graph {
  return (_ctx: GraphRecipeContext): Graph => {
    const agent = async (raw: unknown): Promise<Record<string, unknown>> => {
      const nodeCtx = raw as AgentNodeCtx & {
        interrupt(key: string, payload: Record<string, unknown>): Promise<unknown>;
        get_interrupt_payload?(key: string): Promise<Record<string, unknown> | null>;
      };
      const decision = await approve_before_execute(
        nodeCtx,
        'gate:demo',
        { tool: 'demo_tool', summary: 'cli gate 演示' },
        { payload: { kind: 'cli_gate_demo' } },
        policyFor(autoApprove),
      );
      const reply =
        decision.decision === 'accept' || decision.decision === 'auto' ? 'approved' : 'skipped';
      return { reply };
    };
    const graph = new Graph({ name: 'gate', entry: 'agent' });
    graph.add_node('agent', agent as never);
    graph.add_exit('agent');
    return graph;
  };
}

/** 图名 → 图配方工厂（autoApprove 影响 gate 决议策略）。 */
export function buildCliGraphRecipe(
  name: GraphName,
  autoApprove: boolean,
): (ctx: GraphRecipeContext) => Graph {
  return name === 'assistant'
    ? assistantGraphRecipe
    : gateGraphRecipe(autoApprove);
}
