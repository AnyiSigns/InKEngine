/**
 * tool_pipeline 基础节点执行体（引擎内置：承接上游产出待执行工具步骤的
 * 通用分发节点 + 图终态）。
 *
 * 三种配置形态（与旧产品数据图约定对齐）：
 * - ``role=terminal``：图出口终态实例——不执行工具直接收口（返回空增量，
 *   出口节点执行完图即终止）；
 * - ``config.tool`` 指定工具：执行该命名工具（参数 = state.step_args 同名
 *   项或 config.args 缺省），结果写入 state.results[tool]——工作流步骤节点；
 * - 缺省：消费 state.pending 待执行清单首项（名称/参数/调用 id），结果以
 *   tool 消息回填 state.messages、剩余清单回写 state.pending——供回环图
 *   逐项消费（每节点一项，图边驱动循环）。
 *
 * 工具执行走 seams.tool_pipeline（统一守卫/审批/沙箱）；流水线与全量工具表
 * 经 seams 实时读取（随引擎重建刷新，不携带过期闭包）。
 */

import { NodeContract } from '../../model/contracts/contracts.js';
import { FIELD_ARRAY, SchemaField, SchemaSpec } from '../../model/schema/schemaValidator.js';
import { tool_result } from '../../model/llm/messages.js';
import type { ToolPipeline } from '../../loop/tools/tool_pipeline/tool_pipeline.js';
import type { ToolSpec } from '../../model/llm/tools.js';
import type { NodeFactory } from '../registry/registry_types.js';
import {
  ROLE_TERMINAL,
  STATE_MESSAGES,
  STATE_PENDING,
  STATE_RESULTS,
  STATE_STEP_ARGS,
} from './constants.js';
import { type EngineNodeSeams, type _EngineNodeSeamsBox } from './seams.js';

/** 工具参数 JSON 解析（pending 条目 arguments 为对象或序列化 JSON 文本）。 */
function _pending_args(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 参数 JSON 非法：回落空参（失败文本留痕，不击穿回合）
    }
  }
  return {};
}

/** 单条工具执行（统一流水线分发），返回 (结果文本, 是否成功)。 */
async function _run_tool(
  seams: EngineNodeSeams,
  ctx: { state: Record<string, unknown>; emit(type: string, payload: Record<string, unknown>): Promise<void> },
  name: string,
  args: Record<string, unknown>,
  call_id: string,
): Promise<string> {
  const pipeline = seams.tool_pipeline;
  const all = seams.all_tool_specs;
  const spec = all.find((s) => s.name === name) ?? null;
  if (pipeline === null) return '工具未启用（无分发管线）';
  if (spec === null) {
    const diag = all.map((s) => s.name).sort().join(',');
    return `未知或未启用工具: ${name}（可用[${all.length}] ${diag.slice(0, 80)}）`;
  }
  try {
    const outcome = await pipeline.execute(ctx as never, spec, args);
    return outcome.ok ? (outcome.output ?? '') : `执行被拒: ${outcome.error}`;
  } catch (error) {
    return `工具执行异常: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** tool_pipeline 契约：消费 pending 待执行清单，产出 messages/终态（安全档 0）。 */
export function tool_pipeline_contract(): NodeContract {
  return new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: 'tool_pipeline.output',
      fields: [new SchemaField({ name: STATE_MESSAGES, required: false, kind: FIELD_ARRAY })],
    }),
    safety_tier: 0,
    version: 1,
  });
}

/** tool_pipeline 工厂：seams 盒 → 节点工厂（配置 → 节点执行函数）。 */
export function make_tool_pipeline_factory(box: _EngineNodeSeamsBox): NodeFactory {
  return (config: Record<string, unknown>) => {
    const role = String(config['role'] ?? '');
    const tool = config['tool'] !== null && config['tool'] !== undefined ? String(config['tool']) : null;
    const default_args = config['args'] !== null && config['args'] !== undefined
      ? config['args'] as Record<string, unknown>
      : {};

    return async (raw: unknown): Promise<Record<string, unknown> | null> => {
      if (role === ROLE_TERMINAL) return {};
      const seams = box.current;
      const ctx = raw as {
        state: Record<string, unknown>;
        emit(type: string, payload: Record<string, unknown>): Promise<void>;
      };
      const state = ctx.state;
      if (tool !== null) {
        const step_args = (state[STATE_STEP_ARGS] as Record<string, unknown> | null | undefined) ?? {};
        const args = (step_args[tool] as Record<string, unknown> | undefined) ?? default_args;
        const text = await _run_tool(seams, ctx, tool, args, tool);
        const results = { ...((state[STATE_RESULTS] as Record<string, unknown> | null | undefined) ?? {}) };
        results[tool] = text;
        return { [STATE_RESULTS]: results };
      }
      const pending = Array.isArray(state[STATE_PENDING]) ? (state[STATE_PENDING] as Record<string, unknown>[]) : [];
      if (pending.length === 0) return {};
      const call = pending[0]!;
      const name = String(call['name'] ?? '');
      const args = _pending_args(call['arguments']);
      const call_id = String(call['id'] ?? name);
      const text = await _run_tool(seams, ctx, name, args, call_id);
      const messages = Array.isArray(state[STATE_MESSAGES])
        ? [...(state[STATE_MESSAGES] as Record<string, unknown>[])]
        : [];
      messages.push(tool_result(text, call_id).to_dict());
      return {
        [STATE_MESSAGES]: messages,
        [STATE_PENDING]: pending.slice(1),
      };
    };
  };
}

export type { ToolPipeline, ToolSpec };
