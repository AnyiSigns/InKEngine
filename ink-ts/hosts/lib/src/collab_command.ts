/**
 * host collab_request 组织类工具执行接线（执行模型 §7.1：工具统一触发协议，
 * 组织类后端 = 作用域/通道执行体，兑现为「子执行 + 归并契约」而非普通函数）。
 *
 * 声明真源 = plugins/tools/collab_request/spec.json（endpoint='collab_request'
 * 为引擎内置端点：数据面契约 + 判定钩子已就位，宿主只补执行体，同 web_search
 * 姿势）；本模块 = host 侧执行接线：声明式定义登记（与 plugin 声明对齐）+
 * 按端点登记执行体——工具调用经既有统一流水线（门禁/审批 review 档 =
 * 既有审批卡弹卡流程/审计）后，由 convene 组织执行语义跑子执行并归并回传。
 *
 * 执行体不直接触引擎机制：全部经 HostExecutionService（装配点注入的执行运行
 * 时依赖面）。召集参数语义/校验单一真源见 execution/convene.ts；本文件只做
 * 「模型参数 → 服务调用 → JSON 回执」的薄接线，异常归一为结构化失败结果
 * （模型可见、可自我纠正），不击穿回合。
 */

import {
  DeclarativeToolSpec,
  STATE_ROUND_POSE,
  type DeclarativeExecutor,
  type DeclarativeToolExecutors,
} from '@ink-ts/engine';

import type { HostExecutionService } from './execution/service.js';
import { ConveneError, convene } from './execution/convene.js';

/** 内置端点名（与 engine EndpointType.COLLAB_REQUEST / plugin 声明行一致）。 */
export const COLLAB_REQUEST_ENDPOINT = 'collab_request';

/** 服务取用面（createHost 注入；restore 重装后指向新装配——null = 未装配拒绝召集）。 */
export interface CollabRequestService {
  (): HostExecutionService | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** collab_request 运行时声明式定义（与 plugins/tools/collab_request 声明对齐；
 *  parameters = 召集协议 schema：task/scope(目录 id 或临时定义)/n/mode/contract/
 *  rounds/budget + 兼容位 entity_id/context_refs/constraints）。 */
export function collabRequestDefinition(): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    name: COLLAB_REQUEST_ENDPOINT,
    description:
      '行为意图：召唤协作者（多 agent 动态协作）——从作用域/实体目录选中协作者处理子任务，' +
      '结果回流主持汇总。\n\n使用时机：子任务需要专才/多方意见/并行拆分时；自身可完成 = 不调用；' +
      '协作者目录经 entities 快照内省。\n\n参数语义：entity_id=目录作用域/实体 id；' +
      'scope=目录作用域 id 或临时作用域现场定义（dict: {role,persona?,model?,capabilities?...}，' +
      '用完即散不沉淀）；task=子任务描述；n=并行路数（1..32，默认 1）；mode=blind 并行协奏（默认，' +
      '互不可见）| open 圆桌审议（后轮互见前轮意见，rounds 轮次上限）；contract=full 全量回执（默认）' +
      '|best 择优回执；budget=成本池上限（非负数，护栏兜底）；context_refs/constraints 可选。' +
      '\n\n边界与协作：目标未注册/已下架 = fail-closed 拒绝；通道资格/审批/并行/成本条件执行；' +
      '执行体把「调用」兑现为子执行树 + 归并产物（不是发请求等返回的普通函数）；审批档 review ' +
      '= 统一流水线弹卡确认召唤。',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', minLength: 1, description: '目录作用域/实体 id' },
        scope: {
          description:
            '目标作用域：目录作用域 id 字符串，或临时作用域现场定义 dict（{role,persona?,model?,...}）；' +
            '与 entity_id 二选一（同给时 entity_id 优先）',
        },
        task: { type: 'string', minLength: 1, description: '子任务描述' },
        n: { type: 'integer', minimum: 1, maximum: 32, description: '并行路数（默认 1）' },
        mode: { type: 'string', enum: ['blind', 'open'], description: '协作模式（默认 blind）' },
        contract: { type: 'string', enum: ['full', 'best'], description: '提交契约（默认 full）' },
        rounds: { type: 'integer', minimum: 1, maximum: 8, description: 'open 圆桌轮次上限' },
        budget: { type: 'number', minimum: 0, description: '成本池上限（子执行护栏）' },
        context_refs: { type: 'array', items: { type: 'string' }, description: '可选上下文引用' },
        constraints: { type: 'object', description: '可选约束（透传子执行载荷）' },
      },
      required: ['task'],
    },
    permissions: ['collab:request:*'],
    endpoint: COLLAB_REQUEST_ENDPOINT,
    endpoint_config: {},
    meta: {
      domain: 'collab',
      executor: 'host:collab_request',
      approval: 'review',
      note: '组织类工具：宿主执行体经 ExecutionRuntime 兑现为子执行 + 归并契约；审批档 review = 用户对话弹卡确认召唤',
    },
  });
}

/** 读节点 ctx 的回合审批姿态（round_pose；缺位/非法 = review 缺省语义）。 */
function poseFromCtx(ctx: unknown): string | null {
  const state = isRecord(ctx) ? ctx['state'] : undefined;
  if (!isRecord(state)) return null;
  const pose = state[STATE_ROUND_POSE];
  return typeof pose === 'string' ? pose : null;
}

/** collab_request 端点执行体（convene 组织语义；结果/失败均 JSON 字符串回模型）。 */
export function collabRequestExecutor(getService: CollabRequestService): DeclarativeExecutor {
  return async (ctx, _definition, args): Promise<string> => {
    const service = getService();
    if (service === null) {
      return JSON.stringify({
        ok: false,
        reason: 'execution_unavailable',
        error: '执行运行时未装配（宿主 execution service 缺位），召集拒绝',
      });
    }
    const params = isRecord(args) ? args : {};
    try {
      const result = await convene(service, params, { pose: poseFromCtx(ctx) });
      return JSON.stringify(result);
    } catch (error) {
      if (error instanceof ConveneError) {
        return JSON.stringify({ ok: false, reason: error.reason, error: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, reason: 'convene_failed', error: message });
    }
  };
}

/** collab_request 工具装配产物（boot/createHost 登记一次）。 */
export interface CollabCommandTools {
  register(declarative: DeclarativeToolExecutors): void;
}

/** 构建组织类工具接线（getService = 宿主执行装配活取面，restore 后指向新装配件）。 */
export function buildCollabCommandTools(getService: CollabRequestService): CollabCommandTools {
  const executor = collabRequestExecutor(getService);
  const definition = collabRequestDefinition();
  return {
    register(declarative: DeclarativeToolExecutors): void {
      // 内置端点执行体：同名重复注册 = 覆盖（配置驱动装配、幂等安全）
      declarative.register(COLLAB_REQUEST_ENDPOINT, executor);
      declarative.register_definition(definition);
    },
  };
}
