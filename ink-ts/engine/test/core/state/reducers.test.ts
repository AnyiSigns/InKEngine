import { describe, expect, it } from 'vitest';

import { PatchChain } from '../../../src/core/patch/patchChain.js';
import type { Patch } from '../../../src/core/patch/types.js';
import { add_messages, merge_dicts, merge_metrics, patch_chain_reducer } from '../../../src/core/state/reducers.js';

function P(op: Patch['op'], path: readonly (string | number)[], value?: unknown): Patch {
  return { op, path, value: value as Patch['value'] };
}

describe('add_messages 累积型归约', () => {
  it('追加新 id 消息', () => {
    const out = add_messages([{ id: 'm1', content: 'hi' }], [{ id: 'm2', content: 'world' }]);
    expect((out as { id: string }[]).map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('同 id 消息替换', () => {
    const out = add_messages([{ id: 'm1', content: 'old' }], [{ id: 'm1', content: 'new' }]);
    expect(out.length).toBe(1);
    expect((out[0] as { content: string }).content).toBe('new');
  });

  it('RemoveMessage 删除', () => {
    const out = add_messages(
      [
        { id: 'm1', content: 'a' },
        { id: 'm2', content: 'b' },
      ],
      [{ id: 'm1', type: 'RemoveMessage' }],
    );
    expect((out as { id: string }[]).map((m) => m.id)).toEqual(['m2']);
  });

  it('无 id 消息追加（不重复去重）', () => {
    const out = add_messages([{ content: 'a' }], [{ content: 'b' }]);
    expect(out.length).toBe(2);
  });
});

describe('merge 型归约', () => {
  it('merge_dicts overlay 覆盖', () => {
    expect(merge_dicts({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  it('merge_metrics 数值相加 + 嵌套递归 + 键保留', () => {
    const out = merge_metrics(
      { calls: 2, nested: { x: 1 }, only_base: 'b' },
      { calls: 3, nested: { y: 2 }, only_overlay: 'o' },
    );
    expect(out).toEqual({ calls: 5, nested: { x: 1, y: 2 }, only_base: 'b', only_overlay: 'o' });
  });
});

describe('patch_chain_reducer 内容型归约', () => {
  it('逐补丁累积', () => {
    let chain = patch_chain_reducer(null, P('append', ['items'], 'a'));
    chain = patch_chain_reducer(chain, P('append', ['items'], 'b'));
    expect(chain).toBeInstanceOf(PatchChain);
    expect(chain.assemble()).toEqual({ items: ['a', 'b'] });
  });

  it('overlay 与 base 同一对象短路不重复', () => {
    const chain = new PatchChain({ text: '' });
    chain.apply(P('append', ['text'], 'A'));
    const result = patch_chain_reducer(chain, chain);
    expect(result).toBe(chain);
    expect(chain.length).toBe(1);
    expect(chain.assemble()).toEqual({ text: 'A' });
  });

  it('batch 与完整链混合', () => {
    const batch = [P('replace', ['x'], 1)];
    let chain = patch_chain_reducer(null, batch);
    chain = patch_chain_reducer(chain, new PatchChain({}, [P('replace', ['y'], 2)]));
    expect(chain.assemble()).toEqual({ x: 1, y: 2 });
  });

  it('base 非链 + overlay 完整链：整体保留基础', () => {
    const seed = new PatchChain({ text: '开头段落' });
    const chain = patch_chain_reducer(null, seed);
    expect(chain.assemble()).toEqual({ text: '开头段落' });
    expect(chain).not.toBe(seed);
  });

  it('整链写入返回隔离拷贝，不污染源链', () => {
    const parent = new PatchChain({ text: '开头' });
    parent.apply(P('append', ['text'], 'A'));
    const entry = patch_chain_reducer(null, parent);
    entry.apply(P('append', ['text'], 'B'));
    expect(entry.assemble()).toEqual({ text: '开头AB' });
    expect(parent.length).toBe(1);
    expect(parent.assemble()).toEqual({ text: '开头A' });
  });

  it('整链回流只追加差集段', () => {
    const parent = new PatchChain({ text: '开头' });
    parent.apply(P('append', ['text'], 'A'));
    const child = parent.branch();
    child.apply(P('append', ['text'], 'B'));
    const result = patch_chain_reducer(parent, child);
    expect(result).toBe(parent);
    expect(parent.length).toBe(2);
    expect(parent.assemble()).toEqual({ text: '开头AB' });
  });

  it('裸 dict 初值作为基础文本写入', () => {
    let chain = patch_chain_reducer(null, { text: '初始' });
    expect(chain.assemble()).toEqual({ text: '初始' });
    chain = patch_chain_reducer(chain, P('append', ['text'], '+A'));
    expect(chain.assemble()).toEqual({ text: '初始+A' });
  });
});
