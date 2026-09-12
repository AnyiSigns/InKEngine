/**
 * 白板未授权读写 fail-closed 单测（board.ts Whiteboard）。
 *
 * 测什么：未授权写 → append 显式抛 WhiteboardAccessError；owner 与写入者不符
 * → 显式抛错；未授权读 → view 不返回该块（缺省拒绝，不抛错）。main 全可见不在此
 * 处验证（见 blind/open 测试）。
 */

import { describe, expect, it } from 'vitest';

import {
  Whiteboard,
  WhiteboardAccessError,
  default_whiteboard_grants,
  type WhiteboardBlock,
} from '../../../src/loop/whiteboard/index.js';

function block(over: Partial<WhiteboardBlock>): WhiteboardBlock {
  return {
    id: 'b1',
    kind: 'opinion',
    owner: 'c1',
    content: 'x',
    seq: 1,
    ...over,
  };
}

describe('未授权写 fail-closed（显式抛错）', () => {
  it('协作者写 conclusion（仅 main 可写）→ 抛 WhiteboardAccessError', () => {
    const wb = new Whiteboard(default_whiteboard_grants('open', ['c1']));
    expect(() => wb.append(block({ kind: 'conclusion', owner: 'c1' }), 'c1')).toThrow(
      WhiteboardAccessError,
    );
  });

  it('owner 与写入者不符 → 抛 WhiteboardAccessError', () => {
    const wb = new Whiteboard(default_whiteboard_grants('open', ['c1']));
    // c1 对自己的 opinion 有权写，但声称 owner=c2
    expect(() => wb.append(block({ kind: 'opinion', owner: 'c2' }), 'c1')).toThrow(
      WhiteboardAccessError,
    );
  });

  it('空授权下写任何块都拒绝', () => {
    const wb = new Whiteboard({ mode: 'blind', entries: [] });
    expect(() => wb.append(block({ owner: 'x' }), 'x')).toThrow(WhiteboardAccessError);
  });
});

describe('未授权读 fail-closed（缺省拒绝，不返回该块）', () => {
  it('无读授权的协作者读不到任何块', () => {
    const wb = new Whiteboard(default_whiteboard_grants('open', ['c1']));
    wb.append(block({ kind: 'task', owner: 'main', id: 't1' }), 'main');
    // c1 对 task 有读授权，但此处构造一个无任何读授权的旁观者
    const stranger = new Whiteboard({ mode: 'blind', entries: [] });
    stranger.append(block({ kind: 'task', owner: 'main', id: 't2' }), 'main');
    expect(stranger.view('nobody')).toEqual([]);
  });

  it('协作者读不到 summary（仅用户读）', () => {
    const wb = new Whiteboard(default_whiteboard_grants('open', ['c1'], { userScope: 'user' }));
    wb.append(block({ kind: 'summary', owner: 'main', id: 's1' }), 'main');
    expect(wb.view('c1').map((b) => b.id)).not.toContain('s1');
  });
});
