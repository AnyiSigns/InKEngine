/**
 * 白板授权解析校验单测（grants.ts 数据面）。
 *
 * 测什么：parse_whiteboard_grants 的 fail-closed 校验（非法即抛
 * GraphDefinitionError），覆盖 mode 非法、entries 非 list、条目缺 scope/kind
 * 词表外/access 词表外；另测 default_whiteboard_grants 派生条目形状（blind/open
 * 在 opinion 上的差异）。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/model/errors.js';
import {
  BLOCK_KINDS,
  default_whiteboard_grants,
  parse_whiteboard_grants,
} from '../../../src/loop/whiteboard/index.js';

describe('parse_whiteboard_grants fail-closed 校验', () => {
  it('合法 blind 授权解析通过', () => {
    const g = parse_whiteboard_grants({
      mode: 'blind',
      entries: [{ scope: 'main', kind: 'task', access: 'write' }],
    });
    expect(g.mode).toBe('blind');
    expect(g.entries).toHaveLength(1);
  });

  it('非 dict → GraphDefinitionError', () => {
    expect(() => parse_whiteboard_grants(42)).toThrow(GraphDefinitionError);
    expect(() => parse_whiteboard_grants(null)).toThrow(GraphDefinitionError);
  });

  it('mode 非法 → GraphDefinitionError', () => {
    expect(() =>
      parse_whiteboard_grants({ mode: 'semi', entries: [] }),
    ).toThrow(GraphDefinitionError);
  });

  it('entries 非 list → GraphDefinitionError', () => {
    expect(() =>
      parse_whiteboard_grants({ mode: 'open', entries: {} }),
    ).toThrow(GraphDefinitionError);
  });

  it('条目缺 scope / scope 空 → GraphDefinitionError', () => {
    expect(() =>
      parse_whiteboard_grants({ mode: 'open', entries: [{ kind: 'task', access: 'write' }] }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      parse_whiteboard_grants({ mode: 'open', entries: [{ scope: '', kind: 'task', access: 'write' }] }),
    ).toThrow(GraphDefinitionError);
  });

  it('kind 词表外 → GraphDefinitionError', () => {
    expect(() =>
      parse_whiteboard_grants({ mode: 'open', entries: [{ scope: 'a', kind: 'memo', access: 'read' }] }),
    ).toThrow(GraphDefinitionError);
  });

  it('access 词表外 → GraphDefinitionError', () => {
    expect(() =>
      parse_whiteboard_grants({ mode: 'open', entries: [{ scope: 'a', kind: 'task', access: 'exec' }] }),
    ).toThrow(GraphDefinitionError);
  });
});

describe('default_whiteboard_grants 派生形状', () => {
  it('blind：opinion 不向他人授权读（隔离靠 owner-reads-own）；open：opinion 全体可读', () => {
    const blind = default_whiteboard_grants('blind', ['c1', 'c2']);
    const blindOpinionReads = blind.entries.filter(
      (e) => e.kind === 'opinion' && e.access === 'read',
    );
    // 盲态不授权跨读；各协作者经「作者读自己」规则隔离可见自己的意见块
    expect(blindOpinionReads).toEqual([]);

    const open = default_whiteboard_grants('open', ['c1', 'c2']);
    const openOpinionReads = open.entries.filter(
      (e) => e.kind === 'opinion' && e.access === 'read',
    );
    // 全体互读（含自己）：c1 读 c1/c2、c2 读 c1/c2
    expect(openOpinionReads).toEqual([
      { scope: 'c1', kind: 'opinion', access: 'read' },
      { scope: 'c1', kind: 'opinion', access: 'read' },
      { scope: 'c2', kind: 'opinion', access: 'read' },
      { scope: 'c2', kind: 'opinion', access: 'read' },
    ]);
  });

  it('五类块默认授权齐全（main 写 + 协作者/用户读），词表不越界', () => {
    const g = default_whiteboard_grants('open', ['c1'], { userScope: 'user' });
    for (const e of g.entries) {
      expect(BLOCK_KINDS).toContain(e.kind);
      expect(['read', 'write']).toContain(e.access);
    }
    // main 写 task/conclusion/summary
    const mainWrites = g.entries.filter((e) => e.scope === 'main' && e.access === 'write').map((e) => e.kind);
    expect(mainWrites.sort()).toEqual(['conclusion', 'summary', 'task']);
    // 用户读 conclusion/summary
    const userReads = g.entries.filter((e) => e.scope === 'user' && e.access === 'read').map((e) => e.kind);
    expect(userReads.sort()).toEqual(['conclusion', 'summary']);
  });
});
