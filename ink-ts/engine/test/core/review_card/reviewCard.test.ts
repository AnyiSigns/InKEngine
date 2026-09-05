/**
 * review_card 移植对标测试（语义逐点对标 ink_engine/tests/test_review_card.py）：
 * 三类卡（gate/body/candidate）契约校验/预览截断/构造，与门控分级判定。
 *
 * 错误映射沿用移植口径：数值越界（负数下标等）→ RangeError；未知类型 /
 * 缺必填字段等契约类 ValueError → Error。Python 的 StrEnum 挡位在 TS 侧为
 * 字符串字面量联合（l1/l2/l3），注册表/覆盖映射中枚举实例与字符串取值
 * 天然同一形态。
 */
import { describe, expect, it } from 'vitest';

import {
  GATING_OVERRIDE_VALUES,
  PREVIEW_LIMIT_DEFAULT,
  build_body_card,
  build_candidate_card,
  build_gate_card,
  gating_tier_of,
  preview_limit_for,
  truncate_preview,
  validate_card,
} from '../../../src/core/review_card/reviewCard.js';

describe('validate_card：契约校验（枚举/必填/数值界/预览截断）', () => {
  it('未知审核卡类型被拒绝', () => {
    expect(() => validate_card({ review_type: 'bogus' })).toThrow('未知审核卡类型');
    expect(() => validate_card({})).toThrow(/须在 REVIEW_TYPES 登记/);
  });

  it('缺少必填字段被拒绝（缺 node_label）', () => {
    expect(() => validate_card({ review_type: 'gate', node_id: 'x' })).toThrow(
      /缺少必填字段/,
    );
    expect(() => validate_card({ review_type: 'gate', node_id: 'x' })).toThrow(/node_label/);
  });

  it('负数值字段被拒绝（RangeError）', () => {
    expect(() =>
      validate_card({
        review_type: 'body',
        node_id: 'generate_chapter',
        node_label: '生成',
        target_id: 1,
        chapter_index: -1,
        chapter_total: 3,
      }),
    ).toThrow(RangeError);
    expect(() =>
      validate_card({
        review_type: 'body',
        node_id: 'generate_chapter',
        node_label: '生成',
        target_id: 1,
        chapter_index: -1,
        chapter_total: 3,
      }),
    ).toThrow(/不能为负/);
  });

  it('合法卡过校验并截断预览（content 全量保留供编辑回填）', () => {
    const long = 'x'.repeat(8050);
    const card = validate_card({
      review_type: 'body',
      node_id: 'generate_chapter',
      node_label: '生成',
      target_id: 1,
      chapter_index: 1,
      chapter_total: 3,
      preview_limit: 8000,
      output_preview: long,
      content: long,
    });
    expect(String(card['content']).length).toBeGreaterThan(8000);
    expect(String(card['output_preview']).length).toBeLessThanOrEqual(8020);
    expect(String(card['output_preview'])).toContain('已截断');
  });
});

describe('preview_limit_for：按 node_id 分档的截断上限解析', () => {
  it('宿主注入映射按 node_id 命中', () => {
    const limits = { write_chapter_content: 8000, update_entity: 6000 };
    expect(preview_limit_for('write_chapter_content', limits)).toBe(8000);
    expect(preview_limit_for('update_entity', limits)).toBe(6000);
  });

  it('未注入映射时回退默认档', () => {
    expect(preview_limit_for('write_chapter_content')).toBe(PREVIEW_LIMIT_DEFAULT);
  });

  it('未命中键与空 node_id 均回退默认档', () => {
    expect(preview_limit_for('anything_else')).toBe(PREVIEW_LIMIT_DEFAULT);
    expect(preview_limit_for('')).toBe(PREVIEW_LIMIT_DEFAULT);
  });
});

describe('truncate_preview：预览截断语义', () => {
  it('返回新 dict（不改原卡）', () => {
    const card = { node_id: 'x', output_preview: 'short' };
    const out = truncate_preview(card);
    expect(out).not.toBe(card);
    expect(out['output_preview']).toBe('short');
  });

  it('短预览不截断', () => {
    const card = { node_id: 'x', output_preview: 'short' };
    expect(truncate_preview(card)['output_preview']).toBe('short');
  });

  it('缺 output_preview 视为空（不新增键）', () => {
    const out = truncate_preview({ node_id: 'x' });
    expect(out['output_preview']).toBeUndefined();
  });
});

describe('build_gate_card：单动作卡 / 合并卡 / payload 优先', () => {
  it('单动作卡：tool 定位 + summary 预览', () => {
    const action = { tool: 'write_file', args: { path: 'a.md' }, summary: '写入 a.md' };
    const card = build_gate_card(action);
    expect(card['review_type']).toBe('gate');
    expect(card['node_id']).toBe('write_file');
    expect(card['node_label']).toBe('write_file');
    expect(card['action']).toEqual(action);
    expect(card['output_preview']).toBe('写入 a.md');
    expect(validate_card(card)['review_type']).toBe('gate');
  });

  it('宿主 payload 显式字段优先（缺省字段补全）', () => {
    const action = { tool: 'write_file', diff: '宿主摘要' };
    const card = build_gate_card(action, {
      payload: { node_id: 'custom_node', node_label: '自定义卡' },
    });
    expect(card['node_id']).toBe('custom_node');
    expect(card['review_type']).toBe('gate');
    expect(card['output_preview']).toBe('宿主摘要');
  });

  it('合并卡：actions 汇总预览 + 批量定位', () => {
    const actions = [
      { tool: 'a', summary: 's1' },
      { tool: 'b', summary: 's2' },
    ];
    const card = build_gate_card(undefined, { actions });
    expect(card['review_type']).toBe('gate');
    expect(card['node_id']).toBe('approval_batch');
    expect(card['node_label']).toBe('批量审批');
    expect((card['actions'] as unknown[]).length).toBe(2);
    expect(String(card['output_preview'])).toContain('- a: s1');
    expect(String(card['output_preview'])).toContain('- b: s2');
  });

  it('actions 优先于单 action；payload 字段仍优先', () => {
    const card = build_gate_card(
      { tool: 'single' },
      {
        actions: [{ tool: 'a', summary: 's1' }],
        payload: { node_label: '批量' },
      },
    );
    expect(card['node_id']).toBe('approval_batch');
    expect(card['node_label']).toBe('批量');
    expect(card['action']).toBeUndefined();
  });

  it('长预览按默认档截断', () => {
    const card = build_gate_card({ tool: 'write_file', diff: 'x'.repeat(5000) });
    expect(String(card['output_preview']).length).toBeLessThanOrEqual(
      PREVIEW_LIMIT_DEFAULT + 20,
    );
    expect(String(card['output_preview'])).toContain('已截断');
  });

  it('payload 缺定位字段且无动作兜底时契约拒绝', () => {
    expect(() =>
      build_gate_card(undefined, { payload: { output_preview: '无定位字段' } }),
    ).toThrow(/缺少必填字段/);
  });
});

describe('build_body_card：内容卡构造与 node_id 必传', () => {
  it('字段按协议名映射（chapter_index/chapter_total）', () => {
    const card = build_body_card(1, 2, 3, '正文内容', '生成章节', 'generate_chapter');
    expect(card['review_type']).toBe('body');
    expect(card['content']).toBe('正文内容');
    expect(card['target_id']).toBe(1);
    expect(card['chapter_index']).toBe(2);
    expect(card['chapter_total']).toBe(3);
  });

  it('缺 node_id 被必填校验拒绝', () => {
    expect(() => build_body_card(1, 2, 3, '正文内容', '生成章节')).toThrow(/缺少必填字段/);
  });
});

describe('build_candidate_card：候选选择卡按 source 分流', () => {
  it('workflow 来源候选', () => {
    const card = build_candidate_card(
      1,
      'wf-1',
      [{ node_id: 'n', output: 'x' }],
      'workflow',
      'workflow_candidate',
    );
    expect(card['review_type']).toBe('candidate');
    expect(card['source']).toBe('workflow');
    expect(card['node_id']).toBe('workflow_candidate');
  });

  it('divergent 来源候选', () => {
    const card = build_candidate_card(
      1,
      'divergent',
      [{ node_id: 'd:0', output: 'x' }],
      'divergent',
      'divergent_draft',
    );
    expect(card['source']).toBe('divergent');
    expect(card['node_id']).toBe('divergent_draft');
  });
});

describe('gating_tier_of：门控分级判定优先级', () => {
  it('默认挡位为 l2（未登记写操作保守弹卡）', () => {
    expect(gating_tier_of('some_tool')).toBe('l2');
  });

  it('注册表登记 l1 生效（字符串取值）', () => {
    const registry = { create_entities: 'l1' };
    expect(gating_tier_of('create_entities', undefined, registry)).toBe('l1');
  });

  it("注册表登记 l1 生效（StrEnum 枚举与字符串取值在 TS 数据面同一形态）", () => {
    const registry = { create_entities: 'l1' };
    expect(gating_tier_of('create_entities', undefined, registry)).toBe('l1');
  });

  it('用户覆盖优先于注册表', () => {
    const registry = { create_entities: 'l1' };
    expect(gating_tier_of('create_entities', { create_entities: 'l2' }, registry)).toBe(
      'l2',
    );
  });

  it('非法覆盖值忽略并回退默认挡位', () => {
    expect(gating_tier_of('t', { t: 'l9' })).toBe('l2');
  });

  it('覆盖白名单为 {l1,l2,l3}', () => {
    expect(GATING_OVERRIDE_VALUES).toEqual(new Set(['l1', 'l2', 'l3']));
  });
});
