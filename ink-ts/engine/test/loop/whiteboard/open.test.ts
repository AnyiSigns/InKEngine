/**
 * 白板 open 升级共享单测（board.ts Whiteboard + default_whiteboard_grants('open')）。
 *
 * 测什么：open 模式下意见块升级为共享——各协作者可读到他人意见块（互见）；
 * 其余块（task/board/conclusion）仍按默认授权互见；main 全可见。
 */

import { describe, expect, it } from 'vitest';

import {
  Whiteboard,
  default_whiteboard_grants,
  type WhiteboardBlock,
} from '../../../src/core/whiteboard/index.js';

function blk(over: Partial<WhiteboardBlock>): WhiteboardBlock {
  return { id: 'x', kind: 'opinion', owner: 'c1', content: '', seq: 1, ...over };
}

function seededOpen(): Whiteboard {
  const wb = new Whiteboard(default_whiteboard_grants('open', ['c1', 'c2']));
  wb.append(blk({ id: 'tk', kind: 'task', owner: 'main' }), 'main');
  wb.append(blk({ id: 'op1', kind: 'opinion', owner: 'c1' }), 'c1');
  wb.append(blk({ id: 'op2', kind: 'opinion', owner: 'c2' }), 'c2');
  wb.append(blk({ id: 'bd', kind: 'board', owner: 'c2' }), 'c2');
  wb.append(blk({ id: 'cn', kind: 'conclusion', owner: 'main' }), 'main');
  wb.append(blk({ id: 'su', kind: 'summary', owner: 'main' }), 'main');
  return wb;
}

describe('open 升级：意见互见', () => {
  it('c1 可读到 c2 的意见块（blind 下不可见）', () => {
    const wb = seededOpen();
    const ids = wb.view('c1').map((b) => b.id);
    expect(ids).toContain('op1');
    expect(ids).toContain('op2');
  });

  it('c2 可读到 c1 的意见块', () => {
    const wb = seededOpen();
    const ids = wb.view('c2').map((b) => b.id);
    expect(ids).toContain('op1');
    expect(ids).toContain('op2');
  });

  it('open 下 task/board/conclusion 仍互见且含全部意见', () => {
    const wb = seededOpen();
    const ids = wb.view('c1').map((b) => b.id).sort();
    expect(ids).toEqual(['bd', 'cn', 'op1', 'op2', 'tk']);
  });

  it('open 下 c1 仍读不到 summary（仅用户读）', () => {
    const wb = seededOpen();
    expect(wb.view('c1').map((b) => b.id)).not.toContain('su');
  });

  it('main 全可见 open 下读全部 6 块', () => {
    const wb = seededOpen();
    const ids = wb.view('main').map((b) => b.id).sort();
    expect(ids).toEqual(['bd', 'cn', 'op1', 'op2', 'su', 'tk']);
  });
});
