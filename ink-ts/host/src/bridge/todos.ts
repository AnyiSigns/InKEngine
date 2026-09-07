/**
 * 回合待办命令面（rounds.todos）——最新 checkpoint 计划未完成步骤 + 挂起
 * 审批卡的只读投影。
 *
 * 数据源（无第二份台账）：计划步骤 = 引擎 checkpoint.plan（运行时重规划
 * 快照 {steps, index}，随版本链持久化）；挂起审批卡 = 链尾 interrupt 状态
 * （engine.get_latest_interrupt）。无链 / 计划已走完 / 无挂起卡 = 空清单
 * （web 顶栏据此隐藏待办标签）。host 只接线投影，机制全在引擎。
 */

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 待办行（kind = plan 步骤类型或 approval）。 */
export interface TodoView {
  id: string;
  label: string;
  status: string;
  kind: string;
}

interface InterruptCard {
  key: string;
  node: string | null;
  graph_path: readonly string[];
  payload: Record<string, unknown>;
}

function requireThread(raw: unknown): string {
  const params = raw as { thread_id?: unknown } | null;
  if (
    typeof params !== 'object'
    || params === null
    || typeof params.thread_id !== 'string'
    || params.thread_id === ''
  ) {
    throw new BridgeError('rounds.todos 需 params.thread_id', 'invalid_params');
  }
  return params.thread_id;
}

/** 计划步骤 dict → 可读 label + kind。 */
function planStepTodo(step: Record<string, unknown>, index: number): TodoView {
  const nodes: string[] = Array.isArray(step['nodes'])
    ? (step['nodes'] as unknown[]).filter((name): name is string => typeof name === 'string')
    : [];
  const parallel: string[] = Array.isArray(step['parallel'])
    ? (step['parallel'] as unknown[]).filter((name): name is string => typeof name === 'string')
    : [];
  const spawns: unknown[] = Array.isArray(step['spawns']) ? (step['spawns'] as unknown[]) : [];
  if (nodes.length > 0) {
    return {
      id: `plan:${index}`,
      label: nodes.join(' → '),
      status: 'pending',
      kind: 'nodes',
    };
  }
  if (parallel.length > 0) {
    return {
      id: `plan:${index}`,
      label: parallel.join(' / '),
      status: 'pending',
      kind: 'parallel',
    };
  }
  if (spawns.length > 0) {
    return {
      id: `plan:${index}`,
      label: `并行子图 × ${spawns.length}`,
      status: 'pending',
      kind: 'spawns',
    };
  }
  return { id: `plan:${index}`, label: '待定步骤', status: 'pending', kind: 'step' };
}

/** 审批卡 → 待办行（id = 卡 key；label 取 payload 摘要/节点名）。 */
function cardTodo(card: InterruptCard): TodoView {
  const payload = card.payload ?? {};
  const summary =
    typeof payload['summary'] === 'string' && payload['summary'] !== ''
      ? payload['summary']
      : typeof payload['tool'] === 'string'
        ? payload['tool']
        : null;
  return {
    id: card.key,
    label: `审批待裁决: ${summary ?? card.node ?? card.key}`,
    status: 'pending',
    kind: 'approval',
  };
}

/** todos 命令声明（rounds.todos 挂 rounds 域；方法名唯一真源，装配由 index 聚合）。 */
export const TODOS_COMMANDS = [
  'rounds.todos',
] as const;

export type TodosCommand = (typeof TODOS_COMMANDS)[number];

/** rounds.todos 处理器组（本组仅一个方法；挂 rounds 域命令面）。 */
export function buildTodosCommands(deps: HostBridgeDeps): Readonly<Record<TodosCommand, BridgeHandler>> {
  const todos: BridgeHandler = async (raw): Promise<unknown> => {
    const thread_id = requireThread(raw);
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const todo: TodoView[] = [];
    const checkpoint = await storage.get_latest_checkpoint(thread_id).catch(() => null);
    if (checkpoint !== null && checkpoint.plan !== null) {
      const plan = checkpoint.plan as Record<string, unknown>;
      const steps = Array.isArray(plan['steps']) ? (plan['steps'] as unknown[]) : [];
      const index = typeof plan['index'] === 'number' ? plan['index'] : 0;
      for (let i = index; i < steps.length; i += 1) {
        const step = steps[i];
        if (typeof step !== 'object' || step === null) continue;
        todo.push(planStepTodo(step as Record<string, unknown>, i));
      }
    }
    // 引擎无常驻静态引擎：挂起审批卡读链尾 checkpoint interrupt（引擎链尾态）
    if (checkpoint !== null && checkpoint.interrupt !== null) {
      todo.push(cardTodo(checkpoint.interrupt as unknown as InterruptCard));
    }
    return { thread_id, todo };
  };

  return { 'rounds.todos': todos };
}
