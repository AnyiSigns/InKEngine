/**
 * 白板序列化 round-trip 与未知键容忍单测（board.ts Whiteboard.to_dict/from_dict）。
 *
 * 测什么：to_dict 形态含 version/grants/blocks/audit；from_dict 还原等价；未知顶层
 * 键、未知块字段、缺省可选键（无 audit）均被容忍不抛；grants 非法 →
 * GraphDefinitionError；缺 grants → GraphDefinitionError。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  Whiteboard,
  default_whiteboard_grants,
  type WhiteboardBlock,
} from '../../../src/core/whiteboard/index.js';

function blk(over: Partial<WhiteboardBlock>): WhiteboardBlock {
  return { id: 'x', kind: 'task', owner: 'main', content: '', seq: 1, ...over };
}

describe('to_dict / from_dict round-trip', () => {
  it('追加多块后等价还原（grants/blocks/audit 全保真）', () => {
    const wb = new Whiteboard(default_whiteboard_grants('open', ['c1'], { userScope: 'user' }));
    wb.append(blk({ id: 'tk', kind: 'task' }), 'main');
    wb.append(blk({ id: 'op1', kind: 'opinion', owner: 'c1' }), 'c1');
    wb.view('c1'); // 产生读审计
    const data = wb.to_dict();
    expect(data['version']).toBe(1);

    const restored = Whiteboard.from_dict(data);
    expect(restored.to_dict()).toEqual(data);
    expect(restored.audit()).toEqual(wb.audit());
  });

  it('from_dict 重内容可被正常读写', () => {
    const wb = new Whiteboard(default_whiteboard_grants('open', ['c1'], { userScope: 'user' }));
    wb.append(blk({ id: 'tk', kind: 'task' }), 'main');
    const restored = Whiteboard.from_dict(wb.to_dict());
    expect(restored.view('c1').map((b) => b.id)).toEqual(['tk']);
  });
});

describe('from_dict 版本容忍 / 未知键忽略', () => {
  it('未知顶层键被忽略不抛', () => {
    const base = new Whiteboard(default_whiteboard_grants('open', ['c1'])).to_dict();
    base['notes'] = 'ignored';
    base['meta'] = { arbitrary: true };
    expect(() => Whiteboard.from_dict(base)).not.toThrow();
  });

  it('块内未知字段被忽略', () => {
    const data = {
      version: 1,
      grants: { mode: 'open', entries: [{ scope: 'main', kind: 'task', access: 'write' }] },
      blocks: [{ id: 'tk', kind: 'task', owner: 'main', content: '', seq: 1, extra: 'x' }],
    };
    const wb = Whiteboard.from_dict(data);
    expect(wb.view('main').map((b) => b.id)).toEqual(['tk']);
  });

  it('缺省 audit 键回落空审计不抛', () => {
    const data = {
      version: 1,
      grants: { mode: 'open', entries: [{ scope: 'main', kind: 'task', access: 'write' }] },
      blocks: [{ id: 'tk', kind: 'task', owner: 'main', content: '', seq: 1 }],
    };
    const wb = Whiteboard.from_dict(data);
    expect(wb.audit()).toEqual([]);
  });

  it('未知 version 值仍容忍（前向兼容，不强制等于 1）', () => {
    const data = new Whiteboard(default_whiteboard_grants('open', ['c1'])).to_dict();
    data['version'] = 99;
    expect(() => Whiteboard.from_dict(data)).not.toThrow();
  });
});

describe('from_dict 非法输入 fail-closed', () => {
  it('非 dict → GraphDefinitionError', () => {
    expect(() => Whiteboard.from_dict('nope')).toThrow(GraphDefinitionError);
  });

  it('grants 非法 → GraphDefinitionError', () => {
    expect(() =>
      Whiteboard.from_dict({ grants: { mode: 'weird', entries: [] } }),
    ).toThrow(GraphDefinitionError);
  });

  it('缺 grants → GraphDefinitionError', () => {
    expect(() => Whiteboard.from_dict({ version: 1, blocks: [] })).toThrow(GraphDefinitionError);
  });

  it('blocks 非 list → GraphDefinitionError', () => {
    expect(() =>
      Whiteboard.from_dict({
        grants: { mode: 'open', entries: [] },
        blocks: {},
      }),
    ).toThrow(GraphDefinitionError);
  });
});
