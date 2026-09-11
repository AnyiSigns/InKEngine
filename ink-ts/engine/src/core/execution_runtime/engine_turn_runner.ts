/**
 * 引擎装载的单轮作用域加工默认执行器（ScopeTurnRunner 的真实默认实现）。
 *
 * 复用既有 executor/agent 机制件做作用域回合——不另起第二套模型调用面：
 * 目录作用域/临时作用域的实体记录 → `_build_agent_scope_graph`（与 core/nodes/
 * agent.ts 同一展开形态：persona 作 scope llm 的 system 自定义层、boot 基线在前
 * 由 llm_decider 经 compose_llm_system 合成）→ 现装配的节点注册表 + seams 盒
 * → Engine.ainvoke 跑单节点 llm_decider 回路至收口（消息链/工具回合/事件发射与
 * 常驻引擎同机制）。作用域 model 引用经 resolve_scope_llm 决议（缺失 seam /
 * 解析失败 = 显式失败，与 agent.ts 同口径不静默跑父模型）。
 *
 * 每轮加工独立子引擎实例（一次会话 = 多次作用域加工；回合间状态在 run 载荷层
 * 传递，不跨子引擎泄漏——scope 轮次本来就是独立收口的执行单元）。
 */

import { GraphRegistries } from '../registry/registry.js';
import { Graph } from '../graph/graph.js';
import { RunOptions } from '../run_result/run_result.js';
import { Engine } from '../../kernel/executor/index.js';
import { EntitySpec } from '../entities/entities.js';
import type { AsyncLLM } from '../../kernel/llm/_guard_types.js';
import type { ToolPipeline } from '../../kernel/tool_pipeline/tool_pipeline.js';
import type { ToolSpec } from '../../kernel/llm/tools.js';
import { register_engine_node_types, bind_engine_node_seams, default_engine_pool_seed } from '../nodes/index.js';
import { _build_agent_scope_graph } from '../nodes/agent.js';
import { failed_turn, ok_turn, type ScopeTurnResult, type ScopeTurnRunner } from './scope_turn.js';
import type { ScopeTurnContext } from './runtime_types.js';

/** 引擎装载执行器的装配选项。 */
export interface EngineTurnRunnerInit {
  /** 会话默认模型（model:null 作用域的回落面）。 */
  llm: AsyncLLM | null;
  /** 作用域 model 引用解析 seam（null = 无 per-scope override 能力）。 */
  resolve_scope_llm?:
    | ((model: Record<string, string>) => AsyncLLM | null | Promise<AsyncLLM | null>)
    | null;
  /** 工具执行流水线（守卫/审批全机制；空执行器 = 作用域不触工具）。 */
  tool_pipeline: ToolPipeline | null;
  /** 注入工具表（作用域能力类工具挂载面；缺省 = 空）。 */
  tool_specs?: readonly ToolSpec[];
  /** boot 基线系统提示词（只读；缺省 ''）。 */
  boot_system_prompt?: string;
  /** 工具回合上限（缺省 = 引擎常量）。 */
  max_tool_rounds?: number;
}

function model_label(model: Record<string, string>): string {
  return `${model['provider'] ?? '?'}/${model['model_id'] ?? '?'}`;
}

/** 从作用域实体记录解析本回合模型（model:null = 会话默认；引用须可解析）。 */
async function resolve_turn_llm(
  scope: EntitySpec,
  init: EngineTurnRunnerInit,
): Promise<AsyncLLM | null> {
  if (scope.model === null) return init.llm;
  if (init.resolve_scope_llm == null) {
    throw new Error(
      `作用域 ${scope.id} 配置了 model 引用（${model_label(scope.model)}）但未注入` +
        ' resolve_scope_llm（无法 override，拒绝静默沿用父模型）',
    );
  }
  const resolved = await init.resolve_scope_llm(scope.model);
  if (resolved === null) {
    throw new Error(
      `作用域 ${scope.id} 的 model 引用无法解析（${model_label(scope.model)}）`,
    );
  }
  return resolved;
}

/** 引擎装载执行器工厂（装配 seam → ScopeTurnRunner 真实实现）。 */
export function make_engine_turn_runner(init: EngineTurnRunnerInit): ScopeTurnRunner {
  const toolSpecs = init.tool_specs ?? [];
  const config: Record<string, unknown> = {};
  if (init.max_tool_rounds !== undefined && init.max_tool_rounds !== null) {
    config['max_tool_rounds'] = init.max_tool_rounds;
  }
  return {
    async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
      if (init.tool_pipeline === null) {
        return failed_turn('tool_pipeline 未装配', '作用域加工缺工具流水线（fail-closed）');
      }
      let llm: AsyncLLM | null;
      try {
        llm = await resolve_turn_llm(ctx.scope, init);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failed_turn(message, `作用域模型决议失败: ${ctx.scope.id}`);
      }
      if (llm === null) {
        return failed_turn('llm seam 未装配', '作用域加工缺会话默认模型（fail-closed）');
      }
      // 与 agent 结点同一展开形态：单节点 llm_decider 回路（persona 层 +
      // boot 基线合成在 llm_decider 内部）
      const graph: Graph = _build_agent_scope_graph(ctx.scope, config);
      const registries = new GraphRegistries();
      register_engine_node_types(registries, default_engine_pool_seed().node_types);
      bind_engine_node_seams(registries, {
        llm,
        tool_pipeline: init.tool_pipeline,
        tool_specs: toolSpecs,
        all_tool_specs: toolSpecs,
        collect_specs: null,
        boot_system_prompt: init.boot_system_prompt ?? '',
        resolve_entity: null,
        resolve_scope_llm: init.resolve_scope_llm ?? null,
      });
      const engine = new Engine(graph, new RunOptions({ registries }));
      const round_id = `${ctx.run_id}:scope:${ctx.step}`;
      try {
        const result = await engine.ainvoke(
          { input: ctx.input },
          {
            thread_id: ctx.thread_id,
            round_id,
            // 挂起恢复注入透传：工具审批决议经子引擎 InterruptCoordinator 宽容
            // 消费（base/base#N），通道审批键（gate:channel:）已由运行时隔离
            ...(ctx.inject !== null && ctx.inject !== undefined
              ? { inject: ctx.inject }
              : {}),
          },
        );
        if (result.reason === 'error') {
          const detail = result.error ?? '引擎回合异常';
          return failed_turn(detail, `作用域 ${ctx.scope.id} 加工失败: ${detail}`);
        }
        // 工具审批挂起（review 档弹卡）：interrupt 态透出给执行循环，由运行时
        // 写执行级 checkpoint + 挂起——不再被当作空回合静默吞掉
        if (result.reason === 'interrupted' && result.interrupt !== null) {
          return { ok: true, reply: '', interrupt: result.interrupt };
        }
        const state = result.state as Record<string, unknown>;
        const reply = typeof state['reply'] === 'string' ? state['reply'] : '';
        return ok_turn(reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failed_turn(message, `作用域 ${ctx.scope.id} 加工异常: ${message}`);
      }
    },
  };
}
