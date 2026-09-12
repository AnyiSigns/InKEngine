/**
 * agent 基础节点执行体（引擎内置 kind=agent：实体收敛的图内结点展开形态）。
 *
 * 图语义（§2.3/§2.4）：图内 ``kind=agent`` 结点是结构声明（config 携带实体
 * 引用 ``entity_id``），执行 = 从实体目录取 EntitySpec（persona/model/role）
 * → 展开内部子回路。本执行体只做「引用解析 + 子回路组装」，展开生命周期
 * 交给子作用域通道（ctx.run_agent_scope = 子图展开的同步单分支形态，见
 * run_subgraph.run_agent_scope）：沿当前图内联执行、状态并入父，与 spawn
 * （并发多实例、独立 checkpoint 子链）不是竞争而是同一子图通道的两个开关。
 *
 * 内部回路（最小递归展开）：单 llm 结点回路（scope 类型键 = config.scope_type
 * 缺省 llm_decider）——子作用域跑 llm/工具回合至收口，回复/消息等产出经
 * 子作用域回流并入父状态。persona 落在该 scope llm 结点的自定义 system_prompt
 * 层（scope 自定义层；执行时仍遵守 P4.2b 语义：boot 基线（seams 装配注入）
 * 恒在前、persona 在后的拼接由 llm 内核执行体自身完成——实体 persona 不绕过
 * boot 基线）。
 *
 * 作用域 model override（B）：实体 model 非 null = 经 seams.resolve_scope_llm
 * 解析为该子作用域的 llm（子作用域内 llm 调用点消费 ctx.scope_llm）；model
 * null = 沿用父作用域覆盖（已处某 agent scope 时）或会话默认（seams.llm）。
 * 解析失败/实体目录不可用/装配未注入解析 seam = 显式失败（诚实空态，不猜测）。
 *
 * 执行体只能来自池原则不变：内部回路引用的 scope llm 结点类型须已注册
 * （池/宿主登记）；agent 本身是执行形态，不在运行时引入任意代码。
 */

import type { EntitySpec } from '../../core/entities/entities.js';
import { GraphDefinitionError } from '../../model/errors.js';
import { Graph } from '../../model/graph/graph.js';
import type { AsyncLLM } from '../../kernel/llm/_guard_types.js';
import type { NodeFactory } from '../registry/registry_types.js';
import { NodeContract } from '../../model/contracts/contracts.js';
import { TYPE_LLM_DECIDER } from './constants.js';
import { type EngineNodeSeams, type _EngineNodeSeamsBox } from './seams.js';

/** 子作用域展开通道（执行器 NodeContext 注入；缺省不存在的报错面）。 */
interface _AgentScopeCtx {
  readonly state: Record<string, unknown>;
  /** 父作用域模型覆盖（agent 结点处于某 agent scope 内时继承；null = 会话默认）。 */
  readonly scope_llm?: AsyncLLM | null;
  run_agent_scope?(
    subgraph: Graph,
    opts?: {
      scope_llm?: AsyncLLM | null;
      entity_id?: string | null;
      entity_label?: string | null;
    },
  ): Promise<Record<string, unknown> | null>;
}

/** 实体 model 引用缺失字段时的不可能态（resolve_scope_llm 只收齐备引用）。 */
function _model_label(model: Record<string, string>): string {
  return `${model['provider'] ?? '?'}/${model['model_id'] ?? '?'}`;
}

/**
 * agent 结点契约：消费消息链/回合输入，产出并入父状态（回复/消息由内部
 * 回路经子作用域回流；输出 schema 不锁字段——agent 是展开形态非单字段产出）。
 */
export function agent_scope_contract(): NodeContract {
  return new NodeContract({
    input_schema: null,
    output_schema: null,
    safety_tier: 0,
    version: 1,
  });
}

/** 归一 scope_type 配置键（缺省 = llm_decider 实例；空/非字符串回落缺省）。 */
function _scope_type(config: Record<string, unknown>): string {
  const raw = config['scope_type'];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : TYPE_LLM_DECIDER;
}

/**
 * 构造实体子回路图：入口=出口=同一 scope llm 结点（单结点回路，跑一轮
 * llm/工具回合至收口）。persona 作为该 scope 的 system_prompt 自定义层；
 * 结点 name = 实体 label/id（展示留痕用）。schema 不声明 = 继承父引擎口径。
 */
export function _build_agent_scope_graph(entity: EntitySpec, config: Record<string, unknown>): Graph {
  const scope_type = _scope_type(config);
  const name = `agent:${entity.id}`;
  const graph = new Graph({ name, entry: 'scope', exits: ['scope'] });
  const llm_config: Record<string, unknown> = {};
  if (entity.persona !== '') llm_config['system_prompt'] = entity.persona;
  if (entity.label !== '') llm_config['name'] = entity.label;
  const maxRounds = config['max_tool_rounds'];
  if (maxRounds !== undefined && maxRounds !== null) {
    llm_config['max_tool_rounds'] = maxRounds;
  }
  graph.add_node_type('scope', scope_type, llm_config);
  return graph;
}

/** 展开 agent 子回路（scope 已解析；子作用域 llm 覆盖已决议）。 */
async function _expand_scope(
  entity: EntitySpec,
  ctx: _AgentScopeCtx,
  config: Record<string, unknown>,
  scope_llm: AsyncLLM | null,
): Promise<Record<string, unknown> | null> {
  // 直接以 ctx 接收者调用（方法依赖 this 绑定；解构再调会丢失接收者）
  if (typeof ctx.run_agent_scope !== 'function') {
    throw new GraphDefinitionError(
      `agent 结点展开通道未注入（ctx.run_agent_scope 缺失）: ${entity.id}`,
    );
  }
  const subgraph = _build_agent_scope_graph(entity, config);
  return ctx.run_agent_scope(subgraph, {
    scope_llm: scope_llm ?? null,
    entity_id: entity.id,
    entity_label: entity.label !== '' ? entity.label : null,
  });
}

/**
 * agent 工厂：seams 盒 → 节点工厂（配置 → 节点执行函数）。
 *
 * 执行语义：解析实体（目录 seam 缺失/实体未注册 = 显式失败）→ 决议作用域
 * llm（实体 model null = 继承父 scope 覆盖或会话默认；model 非 null 而
 * 解析 seam 缺失/解析失败 = 显式失败）→ 构造子回路 → 展开（子作用域结果
 * 回流为结点增量）。全程不猜：缺 seam/缺实体/解析不了 model 都抛错收口。
 */
export function make_agent_factory(box: _EngineNodeSeamsBox): NodeFactory {
  return (config: Record<string, unknown>) => {
    const rawEntity = config['entity_id'];
    const entity_id = typeof rawEntity === 'string' ? rawEntity.trim() : '';
    if (entity_id === '') {
      throw new GraphDefinitionError('agent 结点 config 缺实体引用（entity_id 字符串）');
    }
    const scopeType = _scope_type(config);

    return async (raw: unknown): Promise<Record<string, unknown> | null> => {
      const seams: EngineNodeSeams = box.current;
      const ctx = raw as _AgentScopeCtx;
      if (seams.resolve_entity == null) {
        throw new GraphDefinitionError(
          `agent 结点展开需要实体目录 seam（resolve_entity 未装配）: ${entity_id}`,
        );
      }
      const entity = seams.resolve_entity(entity_id);
      if (entity === null) {
        throw new GraphDefinitionError(`agent 结点引用的实体未注册: ${entity_id}`);
      }
      // scope llm 决议：model null = 继承父作用域覆盖或回落会话默认；非 null
      // = 必须经 resolve_scope_llm 解析到可用 llm（缺失 seam / 解析失败 = 显式失败）
      let scope_llm: AsyncLLM | null = ctx.scope_llm ?? null;
      if (entity.model !== null) {
        if (seams.resolve_scope_llm == null) {
          throw new GraphDefinitionError(
            `agent 结点实体 ${entity_id} 配置了 model 引用 ` +
              `(${_model_label(entity.model)})，但装配未注入 resolve_scope_llm（无法 override）`,
          );
        }
        const resolved = await seams.resolve_scope_llm(entity.model);
        if (resolved === null) {
          throw new GraphDefinitionError(
            `agent 结点实体 ${entity_id} 的 model 引用无法解析 ` +
              `(${_model_label(entity.model)})，拒绝静默沿用父模型`,
          );
        }
        scope_llm = resolved;
      }
      // 组装真实度前置校验：scope llm 类型须已注册（执行体只能来自池）——
      // 非缺省 scope 类型由子引擎建图解析兜底（类型名是数据；解析失败在
      // 子图校验期显式报错，不猜不回退）。
      return _expand_scope(entity, ctx, config, scope_llm);
    };
  };
}
