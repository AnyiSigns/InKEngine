/**
 * 指纹缓存纯机制单测（对标 test_fingerprint_cache.py 纯函数段）：
 * 证据漂移判定边界（阈值/最小样本/新边/信任档变化）、常量钉死、顶替
 * 审计记录形状、契约版本快照提取。
 *
 * 暂缓用例（需真实存储后端/执行器/组装器集成，见各段头注）：
 * - 组装命中域：cache hit 返回缓存路径不触发搜索、跳过草稿层、沉淀钩子
 *   与组装侧键一致 —— 依赖 PathAssembler/Graph/settle 集成，待迁移；
 * - 三失效信号集成：执行失败强失效、canary 命中失败重组装、证据漂移
 *   失效/顶替（分更高顶替 + fingerprint_replace 审计）、ε 抽样绕过 ——
 *   依赖组装器 + EdgeEvidenceStore 全链路；
 * - 契约版本钉死/模型 id 钉死集成用例 —— 依赖 NodeTypeRegistry 组装；
 * - flag 零生效/无闸门不入缓存 —— 依赖 PathAssemblyRuntime/settle hook；
 * - 上下文指纹稳定性 —— 属 fingerprint.request_fingerprint 域，另行单测。
 */

import { describe, expect, it } from 'vitest';

import { derive_edge_tier } from '../../../src/core/edge_evidence/tier_model.js';
import { TIER_PROMOTED, TIER_REGULAR } from '../../../src/core/edge_evidence/_types.js';
import { EVENT_AUDIT_FINGERPRINT_REPLACE } from '../../../src/core/event_types/eventTypeSpecs.js';
import {
  DRIFT_MIN_N,
  DRIFT_RATIO,
  REPLACE_REASON_DRIFT,
} from '../../../src/core/fingerprint_cache/_types.js';
import {
  contract_snapshot_from_path,
  evidence_drifted,
  fingerprint_replace_audit_record,
} from '../../../src/core/fingerprint_cache/mechanism.js';

const NOW = 1_800_000_000;

/** 证据行构造器（与 pytest `_row` 同形；契约版本固定在 "1"）。 */
function row(src: string, dst: string, s: number, f: number): Record<string, unknown> {
  return {
    src_type: src,
    dst_type: dst,
    src_contract_version: '1',
    dst_contract_version: '1',
    context_domain: 'code',
    success_count: s,
    fail_count: f,
  };
}

describe('evidence_drifted 漂移判定边界', () => {
  it('差 ≥20% 且 N≥5 判漂移；N<5 不误判；新边不参与', () => {
    expect(evidence_drifted([row('a', 'b', 5, 0)], [row('a', 'b', 5, 3)])).toBe(true);
    // 边界：差恰 20%（5/25）→ 漂移
    expect(evidence_drifted([row('a', 'b', 20, 5)], [row('a', 'b', 25, 5)])).toBe(true);
    // 差 <20% → 不漂移
    expect(evidence_drifted([row('a', 'b', 6, 0)], [row('a', 'b', 6, 1)])).toBe(false);
    // N<5（防小样本噪声）→ 不误判
    expect(evidence_drifted([row('a', 'b', 2, 0)], [row('a', 'b', 2, 2)])).toBe(false);
    // 快照未覆盖的新边不参与判定
    expect(
      evidence_drifted([row('a', 'b', 5, 0)], [row('a', 'b', 5, 0), row('c', 'd', 9, 0)]),
    ).toBe(false);
    // 空快照 = 不漂移
    expect(evidence_drifted([], [row('a', 'b', 5, 0)])).toBe(false);
  });

  it('信任档变化 → 漂移（计数差 <20% 但档位变 = 评分依据变）', () => {
    expect(derive_edge_tier(28, 2)).toBe(TIER_PROMOTED);
    expect(derive_edge_tier(28, 3)).toBe(TIER_REGULAR);
    // (28,2)→(28,3)：计数差 1/30 < 20% 但档位 转正→常规
    expect(evidence_drifted([row('a', 'b', 28, 2)], [row('a', 'b', 28, 3)])).toBe(true);
    expect(evidence_drifted([row('a', 'b', 6, 0)], [row('a', 'b', 7, 0)])).toBe(false);
  });
});

describe('契约版本快照提取', () => {
  it('节点绑定 → (类型, 版本) 对；缺契约按缺省版本；排序保确定性', () => {
    const snapshot = contract_snapshot_from_path({
      nodes: {
        a: { type: 'a', contract: { version: 2 } },
        b: { type: 'b' },
        c: { type: 'c', contract: { version: null } },
        skip_non_dict: 'x',
        empty_type: { type: '' },
      },
    });
    expect(snapshot).toEqual([
      ['a', '2'],
      ['b', '1'],
      ['c', '1'],
    ]);
    expect(contract_snapshot_from_path({})).toEqual([]);
    expect(contract_snapshot_from_path({ nodes: 'not-a-dict' })).toEqual([]);
  });
});

describe('常量钉死 + 顶替审计记录', () => {
  it('阈值常量与审计记录形状与事件注册表一致', () => {
    expect(DRIFT_RATIO).toBe(0.2);
    expect(DRIFT_MIN_N).toBe(5);
    const record = fingerprint_replace_audit_record({
      domain: 'code',
      fingerprint: 'new',
      old_fingerprint: 'old',
      reason: REPLACE_REASON_DRIFT,
      old_score: 1.0,
      new_score: 2.0,
      ts: NOW,
    });
    expect(record.type).toBe(EVENT_AUDIT_FINGERPRINT_REPLACE);
    expect(record.reason).toBe(REPLACE_REASON_DRIFT);
    expect(record.fingerprint).toBe('new');
    expect(record.old_fingerprint).toBe('old');
    expect(record.new_score).toBe(2.0);
    expect(record.old_score).toBe(1.0);
    expect(record.ts).toBe(NOW);
  });
});