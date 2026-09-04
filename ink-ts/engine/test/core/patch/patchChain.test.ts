import { describe, expect, it } from 'vitest';

import { PatchChain } from '../../../src/core/patch/patchChain.js';
import type { Patch, PatchChainSerialized } from '../../../src/core/patch/types.js';

function P(op: Patch['op'], path: readonly (string | number)[], value?: unknown): Patch {
  return { op, path, value: value as Patch['value'] };
}

function kObj(value: unknown): { k: number[] } {
  return value as { k: number[] };
}

function firstOf<T>(value: unknown): T {
  const first = (value as (T | undefined)[])[0];
  if (first === undefined) throw new Error('空数组');
  return first;
}

describe('补丁链：append/replace/delete', () => {
  it('append 到列表', () => {
    const chain = new PatchChain({ items: ['a'] });
    chain.apply(P('append', ['items'], 'b'));
    expect(chain.assemble()).toEqual({ items: ['a', 'b'] });
  });

  it('append 拼接字符串', () => {
    const chain = new PatchChain({ content: '你好' });
    chain.apply(P('append', ['content'], '世界'));
    expect(chain.assemble().content).toBe('你好世界');
  });

  it('append 自动创建列表容器', () => {
    const chain = new PatchChain();
    chain.apply(P('append', ['drafts'], 'd1'));
    expect(chain.assemble()).toEqual({ drafts: ['d1'] });
  });

  it('replace 嵌套路径 + 自动创建', () => {
    const chain = new PatchChain({ a: { b: 1 } });
    chain.apply(P('replace', ['a', 'b'], 2));
    chain.apply(P('replace', ['c', 'd'], 3));
    expect(chain.assemble()).toEqual({ a: { b: 2 }, c: { d: 3 } });
  });

  it('replace 列表索引', () => {
    const chain = new PatchChain({ list: [1, 2, 3] });
    chain.apply(P('replace', ['list', 1], 99));
    expect(chain.assemble().list).toEqual([1, 99, 3]);
  });

  it('replace 列表越界自动填充 null', () => {
    const chain = new PatchChain({ list: [1] });
    chain.apply(P('replace', ['list', 3], 'x'));
    expect(chain.assemble().list).toEqual([1, null, null, 'x']);
  });

  it('delete', () => {
    const chain = new PatchChain({ keep: 1, drop: 2 });
    chain.apply(P('delete', ['drop']));
    expect(chain.assemble()).toEqual({ keep: 1 });
  });

  it('delete 缺失键幂等', () => {
    const chain = new PatchChain({ keep: 1 });
    chain.apply(P('delete', ['missing']));
    expect(chain.assemble()).toEqual({ keep: 1 });
  });

  it('append 到非容器在组装时报错', () => {
    const chain = new PatchChain({ n: 42 });
    chain.apply(P('append', ['n'], 1));
    expect(() => chain.assemble()).toThrow(TypeError);
  });
});

describe('补丁链：assemble 模式与纯度', () => {
  it('base_only 忽略补丁', () => {
    const chain = new PatchChain({ x: 1 });
    chain.apply(P('replace', ['x'], 2));
    expect(chain.assemble('base_only')).toEqual({ x: 1 });
  });

  it('partial 取指定区间', () => {
    const chain = new PatchChain({ log: '' });
    for (const ch of ['a', 'b', 'c']) chain.apply(P('append', ['log'], ch));
    expect(chain.assemble('partial', 0, 2).log).toBe('ab');
  });

  it('assemble 是纯函数', () => {
    const base = { x: 1 };
    const chain = new PatchChain(base);
    chain.apply(P('replace', ['x'], 2));
    expect(chain.assemble()).toEqual({ x: 2 });
    expect(base).toEqual({ x: 1 });
    expect(chain.assemble('base_only')).toEqual({ x: 1 });
  });
});

describe('补丁链：rebase/truncate/branch', () => {
  it('rebase 压扁为纯 base 新链', () => {
    const chain = new PatchChain({ n: 0 });
    for (let i = 1; i <= 3; i++) chain.apply(P('replace', ['n'], i));
    const flat = chain.rebase();
    expect(flat.base).toEqual({ n: 3 });
    expect(flat.length).toBe(0);
    expect(chain.length).toBe(3);
  });

  it('truncate 只保留前缀', () => {
    const chain = new PatchChain({ log: '' });
    for (const ch of ['a', 'b', 'c', 'd', 'e']) chain.apply(P('append', ['log'], ch));
    chain.truncate(2);
    expect(chain.assemble().log).toBe('ab');
  });

  it('truncate 负数抛错', () => {
    const chain = new PatchChain();
    expect(() => chain.truncate(-1)).toThrow(RangeError);
  });

  it('branch 共享前缀且互不影响', () => {
    const chain = new PatchChain({ log: '' });
    chain.apply(P('append', ['log'], 'a'));
    chain.apply(P('append', ['log'], 'b'));
    const branch = chain.branch(1);
    expect(branch.assemble().log).toBe('a');
    branch.apply(P('append', ['log'], 'x'));
    expect(chain.assemble().log).toBe('ab');
  });
});

describe('补丁链：序列化与隔离', () => {
  it('to_dict/from_dict 往返一致', () => {
    const chain = new PatchChain({ items: [] });
    chain.apply(P('append', ['items'], 'a'));
    chain.apply(P('replace', ['title'], 't'));
    const restored = PatchChain.from_dict(chain.to_dict());
    expect(restored.assemble()).toEqual(chain.assemble());
    expect(restored.patches).toEqual(chain.patches);
  });

  it('from_dict 容忍多余字段', () => {
    const data: PatchChainSerialized = {
      base: { a: 1 },
      patches: [{ op: 'replace', path: ['a'], value: 2 }],
    };
    const chain = PatchChain.from_dict(data);
    expect(chain.assemble()).toEqual({ a: 2 });
  });

  it('length', () => {
    const chain = new PatchChain();
    expect(chain.length).toBe(0);
    chain.apply(P('replace', ['a'], 1));
    expect(chain.length).toBe(1);
  });

  it('组装产物与链隔离（replace 值深拷贝）', () => {
    const chain = new PatchChain();
    chain.apply(P('replace', ['doc'], { k: [1] }));
    const doc = chain.assemble();
    kObj(doc['doc']).k.push(2);
    expect(chain.assemble().doc).toEqual({ k: [1] });
  });

  it('组装产物与链隔离（append 值深拷贝）', () => {
    const chain = new PatchChain();
    chain.apply(P('append', ['items'], { k: [1] }));
    const doc = chain.assemble();
    firstOf<{ k: number[] }>(doc['items']).k.push(2);
    expect(chain.assemble().items).toEqual([{ k: [1] }]);
  });

  it('branch 深拷贝补丁值', () => {
    const chain = new PatchChain();
    chain.apply(P('replace', ['doc'], { k: [1] }));
    const branch = chain.branch();
    const patch = branch.patches[0];
    if (!patch) throw new Error('分支应有补丁');
    kObj(patch.value).k.push(9);
    expect(chain.assemble().doc).toEqual({ k: [1] });
  });
});

describe('补丁链：version 与 on_change 失效钩子', () => {
  it('内容变更单调递增 version', () => {
    const chain = new PatchChain();
    expect(chain.version).toBe(0);
    chain.apply(P('replace', ['a'], 1));
    expect(chain.version).toBe(1);
    chain.apply_many([P('replace', ['b'], 2)]);
    expect(chain.version).toBe(2);
    chain.truncate(1);
    expect(chain.version).toBe(3);
  });

  it('每次变更触发 on_change', () => {
    const fired: number[] = [];
    const chain = new PatchChain(undefined, undefined, () => fired.push(chain.version));
    chain.apply(P('replace', ['a'], 1));
    chain.apply_many([P('replace', ['b'], 2)]);
    expect(fired).toEqual([1, 2]);
  });

  it('on_change 异常不阻断演化', () => {
    const chain = new PatchChain(undefined, undefined, () => {
      throw new Error('observer failed');
    });
    chain.apply(P('replace', ['a'], 1));
    expect(chain.length).toBe(1);
    expect(chain.assemble()).toEqual({ a: 1 });
  });

  it('branch/rebase 是全新链（version 从 0 起）', () => {
    const chain = new PatchChain();
    chain.apply(P('replace', ['a'], 1));
    expect(chain.branch().version).toBe(0);
    expect(chain.rebase().version).toBe(0);
  });
});
