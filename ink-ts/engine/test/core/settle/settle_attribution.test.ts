/**
 * 沉淀单元：轨迹回放与归因（硬规则段）。
 *
 * 对标 ink_engine/tests/test_settle.py 的「轨迹回放与归因」节：
 * 连续执行无图边不构成遍历；成功才全边 success+1；失败归因对称（加权分摊 +
 * 失败结点入边诊断）；成本随目标结点 token 计账归集；挂起/错误/预算截断 =
 * 中性不记；结点身份解析；归因键永远携带 context_domain。
 */

import { describe, expect, it } from 'vitest';

import { TerminateReason } from '../../../src/core/graph/graph_types.js';
import { Graph } from '../../../src/core/graph/graph.js';
import {
  attribution_plan,
  derive_traversals,
  run_verdict,
} from '../../../src/core/settle/attribution.js';
import { node_identity } from '../../../src/core/settle/types.js';
import {
  TRACE_FAILED,
  TRACE_SKIPPED,
  TRACE_SUCCESS,
  UPDATE_FAIL,
  UPDATE_SUCCESS,
} from '../../../src/core/settle/_constants.js';
import { edgeKey, linearGraph, makeCtx, stepsOf } from './helpers.js';

describe('settle 轨迹回放与归因', () => {
  it('连续执行对无图边 = 不构成遍历（计划跳跃不产生证据）', () => {
    const g = linearGraph(); // start → mid → end
    const ctx = makeCtx(
      stepsOf(['start', TRACE_SUCCESS], ['end', TRACE_SUCCESS]),
      { graph: g },
    );
    expect(derive_traversals(ctx)).toEqual([]); // start→end 无直连边
  });

  it('成功才全边 success+1（路径全通才证明每条边有效）', () => {
    const ctx = makeCtx(
      stepsOf(
        ['start', TRACE_SUCCESS],
        ['mid', TRACE_SUCCESS],
        ['end', TRACE_SUCCESS],
      ),
    );
    const plan = attribution_plan(ctx);
    expect(plan.map((u) => u.kind)).toEqual([UPDATE_SUCCESS, UPDATE_SUCCESS]);
    expect(plan[0]!.key.src_type).toBe('start');
    expect(plan[0]!.key.dst_type).toBe('mid');
    expect(plan[1]!.key.src_type).toBe('mid');
    expect(plan[1]!.key.dst_type).toBe('end');
  });

  it('失败归因对称（加权分摊）：失败结点入边额外 +1 诊断', () => {
    // end 未执行（run 终止于失败）
    const ctx = makeCtx(
      stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_FAILED]),
    );
    const plan = attribution_plan(ctx);
    expect(plan.length).toBe(1);
    expect(plan[0]!.kind).toBe(UPDATE_FAIL);
    expect(plan[0]!.key.src_type).toBe('start');
    expect(plan[0]!.key.dst_type).toBe('mid');
    expect(plan[0]!.delta).toBe(2); // 等权 1 + 失败结点入边诊断 1
  });

  it('上游成功边不记 success（整链未全通，按对称口径分摊失败）', () => {
    const ctx = makeCtx(
      stepsOf(
        ['start', TRACE_SUCCESS],
        ['mid', TRACE_SUCCESS],
        ['end', TRACE_FAILED],
      ),
    );
    const plan = attribution_plan(ctx);
    expect(plan.length).toBe(2);
    expect(plan.every((u) => u.kind === UPDATE_FAIL)).toBe(true);
    const byKey = new Map(plan.map((u) => [u.key.dst_type, u]));
    expect(byKey.get('end')!.delta).toBe(2); // 失败结点入边 + 诊断
    expect(byKey.get('mid')!.delta).toBe(1); // 上游成功边仅基础分摊
  });

  it('成本每次执行归集：目标结点 token 计账随归因携带', () => {
    const ctx = makeCtx(
      stepsOf(
        ['start', TRACE_SUCCESS],
        ['mid', TRACE_SUCCESS],
        ['end', TRACE_SUCCESS],
      ),
      { tokens: { mid: 100, end: 250 } },
    );
    const plan = attribution_plan(ctx);
    expect(plan[0]!.cost).toBe(100.0); // start→mid 的 cost = mid 执行成本
    expect(plan[1]!.cost).toBe(250.0); // mid→end 的 cost = end 执行成本
  });

  it('挂起/计划级错误/预算截断 = 中性不记（路径未走完无裁决）', () => {
    const ctx = makeCtx(
      stepsOf(['start', TRACE_SUCCESS], ['mid', TRACE_SKIPPED]),
    );
    expect(run_verdict(ctx)).toBe('neutral');
    expect(attribution_plan(ctx)).toEqual([]);
    expect(
      run_verdict(makeCtx(ctx.steps, { reason: TerminateReason.ERROR })),
    ).toBe('neutral');
    expect(
      run_verdict(
        makeCtx(ctx.steps, { reason: TerminateReason.BUDGET_EXCEEDED }),
      ),
    ).toBe('neutral');
  });

  it('结点身份解析：声明式绑定取类型名/契约版本；直挂取结点名+缺省', () => {
    const g = linearGraph();
    expect(node_identity(g, 'start')).toEqual(['start', '1', '']);
    expect(node_identity(null, 'x')).toEqual(['x', '1', '']);
    // 绑定形态：NodeBinding 携带类型与契约版本
    const g2 = new Graph({ name: 'typed', entry: 't' });
    g2.add_node_type('t', 't1', { contract_version: '3' });
    expect(node_identity(g2, 't')).toEqual(['t1', '3', '']);
  });

  it('归因键永远携带 context_domain（按域聚合写死）', () => {
    const ctx = makeCtx(
      stepsOf(
        ['start', TRACE_SUCCESS],
        ['mid', TRACE_SUCCESS],
        ['end', TRACE_SUCCESS],
      ),
    );
    const plan = attribution_plan(ctx);
    expect(plan.every((u) => u.key.context_domain === 'code')).toBe(true);
  });
});

describe('settle 归因键辅助', () => {
  it('edgeKey 夹具产出 code 域缺省主键', () => {
    expect(edgeKey('start', 'mid')).toMatchObject({
      src_type: 'start',
      dst_type: 'mid',
      context_domain: 'code',
    });
  });
});
