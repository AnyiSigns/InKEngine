/**
 * 五类块默认读者语义单测（board.ts + default_whiteboard_grants）。
 *
 * 测什么：按设计稿 §7.2 块模型表，验证五类块对三类读者（协作者 / main / 用户）的
 * 默认可见性：task=协作者读；opinion=协作者写读（blind 仅自己、open 全体）、main
 * 全可见、用户不可见；board=协作者+main 读、用户不可见；conclusion=协作者+用户+main
 * 读；summary=仅用户读（main 经全可见额外可读）。
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

function seeded(mode: 'blind' | 'open'): Whiteboard {
  const wb = new Whiteboard(default_whiteboard_grants(mode, ['c1', 'c2'], { userScope: 'user' }));
  wb.append(blk({ id: 'tk', kind: 'task', owner: 'main' }), 'main');
  wb.append(blk({ id: 'op1', kind: 'opinion', owner: 'c1' }), 'c1');
  wb.append(blk({ id: 'op2', kind: 'opinion', owner: 'c2' }), 'c2');
  wb.append(blk({ id: 'bd', kind: 'board', owner: 'c2' }), 'c2');
  wb.append(blk({ id: 'cn', kind: 'conclusion', owner: 'main' }), 'main');
  wb.append(blk({ id: 'su', kind: 'summary', owner: 'main' }), 'main');
  return wb;
}

describe('五类块默认读者语义（协作者视角）', () => {
  it('blind：协作者见 task/自己opinion/board/conclusion，不见他人opinion与summary', () => {
    const ids = seeded('blind').view('c1').map((b) => b.id).sort();
    expect(ids).toEqual(['bd', 'cn', 'op1', 'tk']);
  });

  it('open：协作者见 task/全部opinion/board/conclusion，不见 summary', () => {
    const ids = seeded('open').view('c1').map((b) => b.id).sort();
    expect(ids).toEqual(['bd', 'cn', 'op1', 'op2', 'tk']);
  });
});

describe('五类块默认读者语义（用户视角）', () => {
  it('用户仅见 conclusion / summary，不见其余', () => {
    const ids = seeded('open').view('user').map((b) => b.id).sort();
    expect(ids).toEqual(['cn', 'su']);
  });

  it('blind 下用户同样仅见 conclusion / summary', () => {
    const ids = seeded('blind').view('user').map((b) => b.id).sort();
    expect(ids).toEqual(['cn', 'su']);
  });
});

describe('五类块默认读者语义（main 全可见）', () => {
  it('blind/main 读到全部 6 块（含 summary、他人 opinion）', () => {
    const ids = seeded('blind').view('main').map((b) => b.id).sort();
    expect(ids).toEqual(['bd', 'cn', 'op1', 'op2', 'su', 'tk']);
  });
});
