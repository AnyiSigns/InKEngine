/**
 * 出厂池可区分实例清单（P4.2a-3）断言：
 * - 默认池种子在既有 llm_decider/tool_pipeline/router_judge 基础上含可区分
 *   llm 实例（llm_planner/llm_reviewer/llm_main）与计划后路由实例；
 * - 每个新增实例有独立实例键 + executor 解耦（llm 实例 → engine:llm_decider；
 *   router_plan_judge → engine:router_judge）+ 完整元数据（kind/label/description）；
 * - 实例契约随 config_defaults 派生：planner 产出 plan、reviewer 读 plan 出
 *   review、main 读 plan+review 出 reply、router_plan_judge 读 plan；
 * - 实例两两**可区分**（杜绝「同契约换壳」）：任意两条至少一个维度不同
 *   （kind / 派生产出面 / 派生需求面 / 行为 config / 用途描述）；
 * - 出厂边先验数据与上面实例匹配（planner→reviewer、reviewer→main）。
 */
import { describe, expect, it } from 'vitest';

import {
  required_field_names,
  produced_field_names,
} from '../../../src/core/link_validator/link_validator.js';
import {
  NODE_KIND_LLM,
  NODE_KIND_ROUTER,
  NODE_KIND_TOOL,
  STATE_PLAN,
  STATE_REVIEW,
  TYPE_LLM_DECIDER,
  TYPE_LLM_MAIN,
  TYPE_LLM_PLANNER,
  TYPE_LLM_REVIEWER,
  TYPE_ROUTER_JUDGE,
  TYPE_ROUTER_PLAN_JUDGE,
  TYPE_TOOL_PIPELINE,
} from '../../../src/graph/nodes/constants.js';
import {
  default_engine_pool_seed,
  default_engine_seed_edges,
  type EngineNodeTypeSeed,
} from '../../../src/graph/nodes/index.js';

/** 实例派生契约的产出/需求字段名（排序后断言）。 */
function outNames(seed: EngineNodeTypeSeed): string[] {
  return [...produced_field_names(seed.contract.output_schema)].sort();
}
function inNames(seed: EngineNodeTypeSeed): string[] {
  return [...required_field_names(seed.contract.input_schema)].sort();
}

/** 实例区分签名（kind + 派生产出/需求 + 行为 config 要点 + 用途描述）。 */
function signature(seed: EngineNodeTypeSeed): string {
  const cfg = seed.default_config;
  return JSON.stringify({
    kind: seed.kind ?? null,
    out: outNames(seed),
    in: inNames(seed),
    output_field: cfg['output_field'] ?? null,
    routes: Array.isArray(cfg['routes'])
      ? (cfg['routes'] as Array<Record<string, unknown>>).map((r) => r['key'])
      : null,
    desc: seed.description ?? null,
  });
}

describe('出厂池可区分实例清单', () => {
  const seed = default_engine_pool_seed();
  const rows = seed.node_types;
  const byType = new Map(rows.map((row) => [row.type, row]));

  it('保留既有三类 + 新增可区分实例（7 条；实例键互不重复）', () => {
    expect(seed.enabled).toBe(true);
    expect(rows.map((row) => row.type)).toEqual([
      TYPE_LLM_DECIDER,
      TYPE_LLM_PLANNER,
      TYPE_LLM_REVIEWER,
      TYPE_LLM_MAIN,
      TYPE_TOOL_PIPELINE,
      TYPE_ROUTER_JUDGE,
      TYPE_ROUTER_PLAN_JUDGE,
    ]);
  });

  it('llm 实例元数据齐全（kind=llm、label/description 存在、非终态 flags）', () => {
    for (const type of [TYPE_LLM_PLANNER, TYPE_LLM_REVIEWER, TYPE_LLM_MAIN]) {
      const row = byType.get(type)!;
      expect(row.kind).toBe(NODE_KIND_LLM);
      expect(row.label).toBeTruthy();
      expect(row.description).toBeTruthy();
      expect(row.flags).toEqual({});
    }
    // router_plan_judge：kind=router、routes 声明 + 用途描述
    const router = byType.get(TYPE_ROUTER_PLAN_JUDGE)!;
    expect(router.kind).toBe(NODE_KIND_ROUTER);
    expect(router.label).toBe('计划后路由');
    expect(Array.isArray(router.default_config['routes'])).toBe(true);
  });

  it('executor 解耦：llm 实例绑定 engine:llm_decider、router_plan_judge 绑定 engine:router_judge', () => {
    expect(byType.get(TYPE_LLM_PLANNER)!.executor).toBe(TYPE_LLM_DECIDER);
    expect(byType.get(TYPE_LLM_REVIEWER)!.executor).toBe(TYPE_LLM_DECIDER);
    expect(byType.get(TYPE_LLM_MAIN)!.executor).toBe(TYPE_LLM_DECIDER);
    expect(byType.get(TYPE_ROUTER_PLAN_JUDGE)!.executor).toBe(TYPE_ROUTER_JUDGE);
    // 既有类型无显式 executor（缺省 = 类型自身；向后兼容）
    expect(byType.get(TYPE_LLM_DECIDER)!.executor).toBeUndefined();
    expect(byType.get(TYPE_TOOL_PIPELINE)!.executor).toBeUndefined();
    expect(byType.get(TYPE_ROUTER_JUDGE)!.executor).toBeUndefined();
  });

  it('实例契约随 config_defaults 派生：planner 出 plan / reviewer 读 plan 出 review / main 读 plan+review 出 reply', () => {
    const planner = byType.get(TYPE_LLM_PLANNER)!;
    expect(planner.default_config['output_field']).toBe(STATE_PLAN);
    expect(outNames(planner)).toEqual([STATE_PLAN]);
    expect(inNames(planner)).toEqual([]);

    const reviewer = byType.get(TYPE_LLM_REVIEWER)!;
    expect(outNames(reviewer)).toEqual([STATE_REVIEW]);
    expect(inNames(reviewer)).toEqual([STATE_PLAN]);

    const main = byType.get(TYPE_LLM_MAIN)!;
    expect(main.default_config['output_field'] ?? 'reply').toBe('reply');
    expect(outNames(main)).toEqual(['reply']);
    expect(inNames(main)).toEqual([STATE_PLAN, STATE_REVIEW]);

    const routerPlan = byType.get(TYPE_ROUTER_PLAN_JUDGE)!;
    expect(inNames(routerPlan)).toEqual([STATE_PLAN]);
    expect(outNames(routerPlan)).toEqual(['_route_to']);

    // 未分化实例契约 = 类型级契约（llm_decider/tool_pipeline/router_judge 零漂移）
    expect(outNames(byType.get(TYPE_LLM_DECIDER)!)).toEqual(['reply']);
    expect(outNames(byType.get(TYPE_TOOL_PIPELINE)!)).toEqual(['messages']);
    expect(outNames(byType.get(TYPE_ROUTER_JUDGE)!)).toEqual(['_route_to']);
  });

  it('实例两两可区分：任意两条至少一个维度不同（杜绝同契约换壳）', () => {
    const sigs = rows.map(signature);
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        expect(sigs[i]).not.toBe(sigs[j]);
      }
    }
    // 工具类也覆盖到（kind=tool）
    expect(byType.get(TYPE_TOOL_PIPELINE)!.kind).toBe(NODE_KIND_TOOL);
  });
});

describe('出厂边先验（default_engine_seed_edges）', () => {
  it('预置可喂链 feed 关系（planner→reviewer、reviewer→main；general 域）', () => {
    const edges = default_engine_seed_edges();
    expect(edges.map((e) => [e.src_type, e.dst_type])).toEqual([
      [TYPE_LLM_PLANNER, TYPE_LLM_REVIEWER],
      [TYPE_LLM_REVIEWER, TYPE_LLM_MAIN],
    ]);
    for (const edge of edges) {
      expect(edge.context_domain).toBe('general');
      expect(edge.src_contract_version).toBe('1');
      expect(edge.dst_contract_version).toBe('1');
      expect(edge.success_count).toBeGreaterThan(0);
    }
  });
});
