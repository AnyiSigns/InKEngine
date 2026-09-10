/**
 * 白板审计记录单测（board.ts Whiteboard.audit）。
 *
 * 测什么：审计记录 scope×block×action 正确；写（append）与读（view）都记；main
 * 全可见读也产出读审计；重复 view 调用累加读审计；无读授权则不产生读审计。
 */

import { describe, expect, it } from 'vitest';

import {
  Whiteboard,
  WhiteboardAccessError,
  type WhiteboardBlock,
} from '../../../src/core/whiteboard/index.js';

function blk(over: Partial<WhiteboardBlock>): WhiteboardBlock {
  return { id: 'x', kind: 'task', owner: 'main', content: '', seq: 1, ...over };
}

describe('审计记录 scope×block×action 正确', () => {
  it('append 产出 1 条 write 审计，字段精确', () => {
    const wb = new Whiteboard({
      mode: 'blind',
      entries: [{ scope: 'main', kind: 'task', access: 'write' }],
    });
    const out = wb.append(blk({ id: 'tk' }), 'main');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ scope: 'main', block_id: 'tk', kind: 'task', action: 'write' });
  });

  it('view 对每个可见块产出 1 条 read 审计', () => {
    const wb = new Whiteboard({
      mode: 'blind',
      entries: [
        { scope: 'main', kind: 'task', access: 'write' },
        { scope: 'c1', kind: 'task', access: 'read' },
      ],
    });
    wb.append(blk({ id: 'tk' }), 'main');
    const seen = wb.view('c1');
    expect(seen.map((b) => b.id)).toEqual(['tk']);
    const audit = wb.audit();
    expect(audit).toContainEqual({ scope: 'c1', block_id: 'tk', kind: 'task', action: 'read' });
  });

  it('读与写都记入累计审计', () => {
    const wb = new Whiteboard({
      mode: 'blind',
      entries: [
        { scope: 'main', kind: 'task', access: 'write' },
        { scope: 'c1', kind: 'task', access: 'read' },
      ],
    });
    wb.append(blk({ id: 'tk' }), 'main');
    wb.view('c1');
    const actions = wb.audit().map((e) => e.action).sort();
    expect(actions).toEqual(['read', 'write']);
  });
});

describe('审计累加与全可见读', () => {
  it('main 全可见读亦产出 read 审计', () => {
    const wb = new Whiteboard({
      mode: 'blind',
      entries: [{ scope: 'main', kind: 'task', access: 'write' }],
    });
    wb.append(blk({ id: 'tk' }), 'main');
    wb.view('main');
    expect(wb.audit()).toContainEqual({
      scope: 'main',
      block_id: 'tk',
      kind: 'task',
      action: 'read',
    });
  });

  it('重复 view 累加读审计条数', () => {
    const wb = new Whiteboard({
      mode: 'blind',
      entries: [
        { scope: 'main', kind: 'task', access: 'write' },
        { scope: 'c1', kind: 'task', access: 'read' },
      ],
    });
    wb.append(blk({ id: 'tk' }), 'main');
    wb.view('c1');
    wb.view('c1');
    const reads = wb.audit().filter((e) => e.action === 'read');
    expect(reads).toHaveLength(2);
  });

  it('无读授权不产生读审计', () => {
    const wb = new Whiteboard({ mode: 'blind', entries: [] });
    wb.append(blk({ id: 'tk' }), 'main');
    expect(wb.view('stranger')).toEqual([]);
    expect(wb.audit().every((e) => e.action === 'write')).toBe(true);
  });

  it('未授权写不污染审计（append 抛错前无写入）', () => {
    const wb = new Whiteboard({ mode: 'blind', entries: [] });
    expect(() => wb.append(blk({ id: 'tk', owner: 'x' }), 'x')).toThrow(WhiteboardAccessError);
    expect(wb.audit()).toEqual([]);
  });
});
