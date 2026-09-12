/**
 * 白板 blind 隔离单测（board.ts Whiteboard + default_whiteboard_grants('blind')）。
 *
 * 测什么：blind 模式下意见块互不可见（各协作者仅见自己意见）；board/task/conclusion
 * 仍按默认授权互见；main（作用域 'main'）全可见——即便 grants 未给 main 任何读条目，
 * 亦可读到全部块（含 summary）。
 */

import { describe, expect, it } from 'vitest';

import {
  Whiteboard,
  default_whiteboard_grants,
  type WhiteboardBlock,
} from '../../../src/loop/whiteboard/index.js';

function blk(over: Partial<WhiteboardBlock>): WhiteboardBlock {
  return { id: 'x', kind: 'opinion', owner: 'c1', content: '', seq: 1, ...over };
}

function seededBlind(): Whiteboard {
  const wb = new Whiteboard(default_whiteboard_grants('blind', ['c1', 'c2']));
  wb.append(blk({ id: 'tk', kind: 'task', owner: 'main' }), 'main');
  wb.append(blk({ id: 'op1', kind: 'opinion', owner: 'c1' }), 'c1');
  wb.append(blk({ id: 'op2', kind: 'opinion', owner: 'c2' }), 'c2');
  wb.append(blk({ id: 'bd', kind: 'board', owner: 'c2' }), 'c2');
  wb.append(blk({ id: 'cn', kind: 'conclusion', owner: 'main' }), 'main');
  wb.append(blk({ id: 'su', kind: 'summary', owner: 'main' }), 'main');
  return wb;
}

describe('blind 隔离：意见互不可见', () => {
  it('c1 只见自己的意见块，不见 c2 的', () => {
    const wb = seededBlind();
    const ids = wb.view('c1').map((b) => b.id);
    expect(ids).toContain('op1');
    expect(ids).not.toContain('op2');
  });

  it('c2 只见自己的意见块，不见 c1 的', () => {
    const wb = seededBlind();
    const ids = wb.view('c2').map((b) => b.id);
    expect(ids).toContain('op2');
    expect(ids).not.toContain('op1');
  });

  it('task/board/conclusion 在 blind 下仍互见', () => {
    const wb = seededBlind();
    const ids = wb.view('c1').map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['tk', 'bd', 'cn']));
  });

  it('c1 读不到 summary（仅用户读）', () => {
    const wb = seededBlind();
    expect(wb.view('c1').map((b) => b.id)).not.toContain('su');
  });
});

describe('main 全可见（blind 下即便无显式读条目也读全部）', () => {
  it('main 读到全部 6 块，含 summary', () => {
    const wb = seededBlind();
    const ids = wb.view('main').map((b) => b.id).sort();
    expect(ids).toEqual(['bd', 'cn', 'op1', 'op2', 'su', 'tk']);
  });

  it('纯协作者授权下 main 仍全可见（隔离不遮蔽主机）', () => {
    const wb = new Whiteboard({
      mode: 'blind',
      entries: [{ scope: 'c1', kind: 'task', access: 'read' }],
    });
    wb.append(blk({ id: 'tk', kind: 'task', owner: 'main' }), 'main');
    expect(wb.view('main').map((b) => b.id)).toEqual(['tk']);
    expect(wb.view('c1').map((b) => b.id)).toEqual(['tk']);
    expect(wb.view('c2')).toEqual([]);
  });
});
