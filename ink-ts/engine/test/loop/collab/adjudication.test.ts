/**
 * 裁决数据面单测（adjudication.ts，设计稿 §7.4.4）。
 *
 * 测什么：
 * 1. ①去重——规范化（去空白/全半角）全等合并、包含关系合并（代表取最长）、
 *    单边反对标记的包含对不合并（冲突信号保留）、空文本全等合并；
 * 2. ②冲突检测——verdict 显式结论对立 = 冲突对、无 verdict 时内容「反对/否决」
 *    标记 + 文本相同/包含定位冲突、同结论不冲突、同 owner 不计；
 * 3. ④仲裁优先序三档——用户 > 质量信号 > 先验逐级判定 + 无信号 tie + 序重排；
 * 4. 输入契约门禁——schema 违规剔除并记失败清单、schema 声明非法记失败、
 *    produces 契约回退校验、形状违规剔除；
 * 5. ③综合输入结构（代表/成员/冲突对/逐条来源/失败清单）+ 空输入零漂移 + round-trip。
 */

import { describe, expect, it } from 'vitest';

import {
  ARBITRATION_PRIORITY,
  arbitrate_conflict,
  adjudicate,
  dedupe_opinions,
  detect_conflicts,
  USER_SCOPE,
  type OpinionEntry,
} from '../../../src/loop/collab/index.js';

function op(over: Partial<OpinionEntry>): OpinionEntry {
  return { owner: 'c1', content: '', seq: 1, ...over };
}

describe('①去重（§7.4.4：规范化全等或包含 → 合并，保留代表+成员）', () => {
  it('规范化全等合并：全角空格/全半角字符差异不构成新意见', () => {
    const groups = dedupe_opinions([
      op({ owner: 'c1', content: '采用方案Ａ', seq: 1 }),
      op({ owner: 'c2', content: '采用　方案A', seq: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.owner)).toEqual(['c1', 'c2']);
    expect(groups[0]?.representative.owner).toBe('c1');
  });

  it('包含关系合并：代表 = 规范化文本最长者（包含者胜出）', () => {
    const groups = dedupe_opinions([
      op({ owner: 'c1', content: '采用方案一', seq: 1 }),
      op({ owner: 'c2', content: '建议采用方案一，先试点两周', seq: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.representative.owner).toBe('c2');
    expect(groups[0]?.members).toHaveLength(2);
  });

  it('单边反对标记的包含对不合并（反对针对被包含意见，交冲突检测）', () => {
    const groups = dedupe_opinions([
      op({ owner: 'c1', content: '采用方案一', seq: 1 }),
      op({ owner: 'c2', content: '反对采用方案一：成本过高', seq: 2 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.representative.owner)).toEqual(['c1', 'c2']);
  });

  it('双方都带反对标记的全等意见正常合并（同反对 = 一致意见）', () => {
    const groups = dedupe_opinions([
      op({ owner: 'c1', content: '反对方案一', seq: 1 }),
      op({ owner: 'c2', content: '反对 方案一', seq: 2 }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('空文本全等合并（两条空意见 = 重复）', () => {
    const groups = dedupe_opinions([op({ seq: 1 }), op({ owner: 'c2', seq: 2 })]);
    expect(groups).toHaveLength(1);
  });
});

describe('②冲突检测（对立结论显式标记；输出冲突对，不裁决内容）', () => {
  it('verdict 路径：显式结论规范化后不同 = verdict 冲突对', () => {
    const conflicts = detect_conflicts([
      op({ owner: 'c1', content: '方案一可行', seq: 1, verdict: '采用方案一' }),
      op({ owner: 'c2', content: '方案一风险大', seq: 2, verdict: '否决方案一' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('verdict');
  });

  it('verdict 缺席时回退 stance（verdict ?? stance）', () => {
    const conflicts = detect_conflicts([
      op({ owner: 'c1', content: 'a', seq: 1, stance: '支持X' }),
      op({ owner: 'c2', content: 'b', seq: 2, stance: '反对X' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('verdict');
  });

  it('marker 路径：无 verdict，恰一边内容带反对标记且文本相关 = marker 冲突对', () => {
    const conflicts = detect_conflicts([
      op({ owner: 'c1', content: '采用方案一', seq: 1 }),
      op({ owner: 'c2', content: '反对采用方案一：成本过高', seq: 2 }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('marker');
  });

  it('同结论（显式结论全等）不冲突；文本无关且无标记不冲突', () => {
    const same = detect_conflicts([
      op({ owner: 'c1', content: 'a', seq: 1, verdict: '采用方案一' }),
      op({ owner: 'c2', content: 'b', seq: 2, verdict: '采用 方案一' }),
    ]);
    const unrelated = detect_conflicts([
      op({ owner: 'c1', content: '方案一可行', seq: 1 }),
      op({ owner: 'c2', content: '反对方案二', seq: 2 }),
    ]);
    expect(same).toHaveLength(0);
    expect(unrelated).toHaveLength(0);
  });

  it('同 owner 的两两不计入冲突对', () => {
    const conflicts = detect_conflicts([
      op({ owner: 'c1', content: 'a', seq: 1, verdict: 'X' }),
      op({ owner: 'c1', content: 'b', seq: 2, verdict: 'Y' }),
    ]);
    expect(conflicts).toHaveLength(0);
  });
});

describe('④仲裁优先序（用户 > 质量信号 > 先验，逐级取第一个有信号者）', () => {
  const a = op({ owner: 'c1', seq: 1 });
  const b = op({ owner: 'c2', seq: 2 });

  it('user 档：用户作用域意见直取（basis=user）', () => {
    const userA = arbitrate_conflict(op({ owner: USER_SCOPE, seq: 9 }), b);
    const userB = arbitrate_conflict(a, op({ owner: 'user', seq: 9 }));
    expect(userA).toEqual({ side: 'a', basis: 'user' });
    expect(userB).toEqual({ side: 'b', basis: 'user' });
  });

  it('quality 档：无用户信号时质量分高者胜（basis=quality）；分值相等降级先验', () => {
    const decided = arbitrate_conflict(a, b, { quality: { c1: 0.4, c2: 0.9 } });
    const equal = arbitrate_conflict(a, b, { quality: { c1: 0.5, c2: 0.5 } });
    expect(decided).toEqual({ side: 'b', basis: 'quality' });
    expect(equal).toEqual({ side: 'a', basis: 'prior' });
  });

  it('prior 档：无用户/质量信号时先验先到（seq 小者）；seq 相等 = tie 交 main', () => {
    expect(arbitrate_conflict(a, b)).toEqual({ side: 'a', basis: 'prior' });
    expect(arbitrate_conflict(a, op({ owner: 'c2', seq: 1 }))).toEqual({ side: null, basis: 'tie' });
  });

  it('优先序可重排：quality 提前则越过 user 档', () => {
    const result = arbitrate_conflict(op({ owner: USER_SCOPE, seq: 9 }), b, {
      priority: ['quality', 'user', 'prior'],
      quality: { [USER_SCOPE]: 0.1, c2: 0.9 },
    });
    expect(result).toEqual({ side: 'b', basis: 'quality' });
    expect(ARBITRATION_PRIORITY).toEqual(['user', 'quality', 'prior']);
  });
});

describe('输入契约门禁（意见块按 produces 契约 schema 校验，不符剔除并记失败）', () => {
  const strictSchema = {
    name: 'opinion',
    fields: [
      { name: 'content', kind: 'string', required: true },
      { name: 'verdict', kind: 'string', enum: ['支持', '反对'] },
    ],
  };

  it('schema 违规剔除并记失败清单（逐条原因可读）', () => {
    const result = adjudicate([
      { owner: 'c1', content: '意见正文', seq: 1, schema: strictSchema, verdict: '弃权' },
      { owner: 'c2', content: '意见正文', seq: 2, schema: strictSchema, verdict: '支持' },
    ]);
    expect(result.accepted.map((e) => e.owner)).toEqual(['c2']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.owner).toBe('c1');
    expect(result.rejected[0]?.reasons.join(';')).toContain('verdict');
  });

  it('schema 声明本身非法 = 记失败（fail-closed 不抛错）', () => {
    const result = adjudicate([{ owner: 'c1', content: 'x', seq: 1, schema: { name: 'bad' } }]);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reasons.join(';')).toContain('schema 声明非法');
  });

  it('无自带 schema 时回退 produces 契约首个带 schema 绑定校验', () => {
    const contract = { produces: [{ shape: 'field' as const, key: 'opinion', schema: strictSchema }] };
    const bad = adjudicate([{ owner: 'c1', content: 'x', seq: 1, verdict: '弃权' }], { contract });
    const good = adjudicate([{ owner: 'c1', content: 'x', seq: 1, verdict: '支持' }], { contract });
    expect(bad.rejected).toHaveLength(1);
    expect(good.rejected).toHaveLength(0);
  });

  it('形状违规（缺 owner/非 dict）剔除并记失败', () => {
    const result = adjudicate(['not-a-dict', { content: 'x', seq: 1 }, { owner: 'c1', content: 'ok', seq: 2 }]);
    expect(result.accepted.map((e) => e.seq)).toEqual([2]);
    expect(result.rejected.map((r) => r.reasons.length)).toEqual([1, 1]);
  });
});

describe('③综合输入 + 门面（结构化摘要 / 空输入零漂移 / round-trip）', () => {
  it('synthesis：每组代表+成员 owner、冲突对带仲裁建议、逐条来源、失败清单', () => {
    const result = adjudicate([
      { owner: 'c1', content: '采用方案一', seq: 1 },
      { owner: 'c2', content: '采用　方案一', seq: 2 },
      { owner: 'c3', content: '反对采用方案一：成本过高', seq: 3 },
    ]);
    expect(result.synthesis.points).toHaveLength(2);
    expect(result.synthesis.points[0]?.members.map((m) => m.owner)).toEqual(['c1', 'c2']);
    // 同声重复（c1/c2）折叠为一票：c3 的反对只对组代表出一对冲突
    expect(result.synthesis.conflicts).toHaveLength(1);
    expect(result.synthesis.conflicts[0]?.kind).toBe('marker');
    expect(result.synthesis.sources.map((s) => s.owner)).toEqual(['c1', 'c2', 'c3']);
    expect(result.synthesis.rejected).toHaveLength(0);
  });

  it('accepted 按 (seq, owner) 规范序，冲突对落在排序后的意见上', () => {
    const result = adjudicate([
      { owner: 'c2', content: 'b 意见', seq: 2, verdict: '反对X' },
      { owner: 'c1', content: 'a 意见', seq: 2, verdict: '支持X' },
    ]);
    expect(result.accepted.map((e) => e.owner)).toEqual(['c1', 'c2']);
    expect(result.conflicts[0]?.a.owner).toBe('c1');
  });

  it('空输入零漂移：空结果且 JSON round-trip 前后深度全等', () => {
    const empty = adjudicate([]);
    expect(empty).toEqual({
      accepted: [],
      rejected: [],
      groups: [],
      conflicts: [],
      synthesis: { points: [], conflicts: [], sources: [], rejected: [] },
    });
    const roundTrip = JSON.parse(JSON.stringify(empty));
    expect(roundTrip).toEqual(empty);
  });

  it('完整结果 round-trip：JSON 序列化再解析与原结果深度全等（纯数据面）', () => {
    const result = adjudicate(
      [
        { owner: 'c1', content: '采用方案一', seq: 1 },
        { owner: 'c2', content: '反对采用方案一：成本过高', seq: 2 },
        { owner: 'user', content: '按方案一执行', seq: 3, verdict: '支持' },
        { owner: 'c3', content: '缺内容', seq: 4, schema: { name: 's' } },
      ],
      { quality: { c1: 0.8, c2: 0.3 } },
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    // 冲突对 c1-c2（marker）：无用户信号 → 质量分 c1 0.8 > c2 0.3 胜出
    expect(result.conflicts[0]?.suggestion.basis).toBe('quality');
  });
});
