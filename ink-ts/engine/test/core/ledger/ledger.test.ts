/** 回合账本合并（确定性归约，复用压缩形态）——对标 pytest test_ledger.py。 */

import { describe, expect, it } from 'vitest';

import { merge_ledger, SUMMARY_SCHEMA } from '../../../src/core/ledger/ledger.js';

describe('回合账本合并', () => {
  it('test_merge_first_time_no_old_summary：无旧摘要首次合并', () => {
    const ledgers = [{ intent: '做X', conclusion: '完成', events: [], summary: null }];
    const out = merge_ledger(null, ledgers);
    expect(out.schema).toBe(SUMMARY_SCHEMA);
    expect(out.summary).toContain('做X');
    expect(out.source_count).toBe(1);
  });

  it('test_merge_incremental_with_old_summary：带旧摘要增量合并', () => {
    const old = '历史摘要：已做A';
    const ledgers = [
      {
        intent: '做B',
        conclusion: '完成B',
        events: [{ kind: 'tool_end', detail: { path: 'a.rs' } }],
        summary: null,
      },
    ];
    const out = merge_ledger(old, ledgers);
    expect(out.summary).toContain('历史摘要');
    expect(out.summary).toContain('做B');
    expect(out.source_count).toBe(2);
  });

  it('test_merge_is_deterministic_and_uses_llm_hook：确定性且 LLM 钩子生效', () => {
    const ledgers = [{ intent: 'i', conclusion: 'c', events: [], summary: null }];
    const base = merge_ledger(null, ledgers);
    const again = merge_ledger(null, ledgers);
    expect(base.summary).toBe(again.summary);
    let seen = '';
    const out = merge_ledger(null, ledgers, {
      llm_summarize: (text) => {
        seen = text;
        return 'LLM摘要';
      },
    });
    expect(out.summary).toBe('LLM摘要');
    expect(seen).toContain('i');
  });

  it('空输入返回同构骨架（空摘要、0 来源）', () => {
    const out = merge_ledger(null, []);
    expect(out.schema).toBe(SUMMARY_SCHEMA);
    expect(out.summary).toBe('');
    expect(out.source_count).toBe(0);
    expect(out.generated_at).toBe(0);
  });

  it('空账本 dict 计入来源但产出空文本', () => {
    const out = merge_ledger(null, [{}]);
    expect(out.summary).toBe('');
    expect(out.source_count).toBe(1);
  });

  it('事件 detail dict 按 json.dumps 分隔符序列化', () => {
    const out = merge_ledger(null, [{ events: [{ kind: 'tool_end', detail: { path: 'a.rs' } }] }]);
    expect(out.summary).toContain('- tool_end: {"path": "a.rs"}');
  });

  it('kind/type 与 detail/payload 回退，缺省 event', () => {
    const out = merge_ledger(null, [
      {
        events: [
          { type: 'note', payload: { n: 1 } },
          { detail: '直接文本' },
        ],
      },
    ]);
    expect(out.summary).toContain('- note: {"n": 1}');
    expect(out.summary).toContain('- event: 直接文本');
  });

  it('超过上限保留可放下关键行并落截断标记', () => {
    const old = 'X'.repeat(1500);
    const out = merge_ledger(old, [{ events: [{ detail: 'a'.repeat(2000) }] }]);
    expect(out.summary).toBe(`[旧摘要]\n${old}\n…(截断)`);
  });

  it('单行超限直接只落截断标记', () => {
    const out = merge_ledger(null, [{ events: [{ kind: 'long', detail: 'a'.repeat(2100) }] }]);
    expect(out.summary).toBe('…(截断)');
  });

  it('空串旧摘要视同无旧摘要', () => {
    const out = merge_ledger('', [{ intent: '做X' }]);
    expect(out.summary).not.toContain('[旧摘要]');
    expect(out.summary).toContain('做X');
    expect(out.source_count).toBe(1);
  });

  it('generated_at 缺省为确定值，可由宿主注入时间源', () => {
    expect(merge_ledger(null, []).generated_at).toBe(0);
    const stamped = merge_ledger(null, [], { now: () => 1750000000.25 });
    expect(stamped.generated_at).toBe(1750000000.25);
  });
});
