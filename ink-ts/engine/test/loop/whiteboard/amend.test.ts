/**
 * 白板授权运行中变更单测（amend.ts amend_grants + grants.ts 变更解析/纯应用 +
 * board.ts 仲裁者与 amendment 审计）。
 *
 * 测什么（设计稿 §7.2「召集一次性声明为缺省，运行中变更走 main 仲裁」）：
 * - 非仲裁者 amend 显式抛 WhiteboardAccessError（fail-closed，grants/审计零变化）；
 * - 构造时声明的仲裁者可 amend；main 让位后无仲裁权；
 * - main amend（grant 意见互读）后新视图即时生效（blind→open 式意见块升级共享）；
 * - revoke 后视图收窄；已读内容无追回能力（历史视图结果与审计不受影响）；
 * - grant 幂等去重 / revoke 无匹配不抛；mode 保持召集声明；
 * - amendment 审计正确（scope=仲裁者×block_id='__grants__'×kind='amendment'×
 *   action='write'×amendment 清单+理由），action 词汇不扩（归 write 语义）；
 * - 变更单解析 fail-closed（空清单/op/kind/reason/非 dict 抛 GraphDefinitionError），
 *   amend_grants 对类型化豁口穿入的坏结构同样再校验拦截；
 * - to_dict/from_dict round-trip：amendment 审计与自定义 arbiter 键全保真；
 *   非缺省 arbiter 才落键（缺省板零漂移）。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/model/errors.js';
import {
  AMENDMENT_AUDIT_KIND,
  GRANTS_AUDIT_BLOCK_ID,
  MAIN_SCOPE,
  Whiteboard,
  WhiteboardAccessError,
  amend_grants,
  apply_grant_amendment,
  default_whiteboard_grants,
  parse_grant_amendment,
} from '../../../src/loop/whiteboard/index.js';
import type {
  WhiteboardBlock,
  WhiteboardGrantAmendment,
} from '../../../src/loop/whiteboard/index.js';

function blk(over: Partial<WhiteboardBlock>): WhiteboardBlock {
  return { id: 'x', kind: 'task', owner: 'main', content: '', seq: 1, ...over };
}

/** blind 双协作者场景：任务块 + 两人私密意见块（同召集下发形态）。 */
function blindBoard(): Whiteboard {
  const wb = new Whiteboard(default_whiteboard_grants('blind', ['c1', 'c2']));
  wb.append(blk({ id: 'tk', kind: 'task', owner: 'main' }), 'main');
  wb.append(blk({ id: 'op1', kind: 'opinion', owner: 'c1', content: 'C1意见' }), 'c1');
  wb.append(blk({ id: 'op2', kind: 'opinion', owner: 'c2', content: 'C2意见' }), 'c2');
  return wb;
}

const SHARE_C1: WhiteboardGrantAmendment = {
  changes: [{ scope: 'c1', kind: 'opinion', access: 'read', op: 'grant' }],
  reason: '圆桌升级：放开 c1 意见互读',
};

describe('仲裁者判定（fail-closed）', () => {
  it('非仲裁者 amend 显式抛 WhiteboardAccessError，授权与审计零变化', () => {
    const wb = blindBoard();
    const before = wb.to_dict();
    expect(() => amend_grants(wb, SHARE_C1, 'c1')).toThrow(WhiteboardAccessError);
    expect(() => amend_grants(wb, SHARE_C1, 'stranger')).toThrow(WhiteboardAccessError);
    expect(wb.to_dict()).toEqual(before);
    // 视图未被放大：c1 仍看不见 c2 意见
    expect(wb.view('c1').map((b) => b.id)).not.toContain('op2');
  });

  it('仲裁者可构造声明：自定义 arbiter 生效，main 让位后无仲裁权', () => {
    const wb = new Whiteboard(default_whiteboard_grants('blind', ['c1', 'c2']), {
      arbiter: 'chair',
    });
    expect(wb.arbiter).toBe('chair');
    expect(() => amend_grants(wb, SHARE_C1, MAIN_SCOPE)).toThrow(WhiteboardAccessError);
    const entry = amend_grants(wb, SHARE_C1, 'chair');
    expect(entry.scope).toBe('chair');
    expect(entry.kind).toBe(AMENDMENT_AUDIT_KIND);
  });

  it('amend_grants 再解析防线：类型化豁口穿入坏结构也显式抛 GraphDefinitionError', () => {
    const wb = blindBoard();
    const bogus = {
      changes: [{ scope: 'c1', kind: 'not-a-kind', access: 'read', op: 'grants' }],
      reason: '',
    } as unknown as WhiteboardGrantAmendment;
    expect(() => amend_grants(wb, bogus, MAIN_SCOPE)).toThrow(GraphDefinitionError);
    expect(wb.audit().some((e) => e.kind === AMENDMENT_AUDIT_KIND)).toBe(false);
  });
});

describe('amend 后视图变化（变更即时生效）', () => {
  it('blind 板 main 仲裁 grant 意见互读 → c1 新视图见 C2 意见（升级共享案例）', () => {
    const wb = blindBoard();
    expect(wb.view('c1').map((b) => b.id)).not.toContain('op2');
    const entry = amend_grants(wb, SHARE_C1, MAIN_SCOPE);
    expect(entry.action).toBe('write'); // action 词汇不扩：amend 归 write 语义
    expect(wb.view('c1').map((b) => b.id)).toContain('op2');
  });

  it('revoke 后视图收窄（撤 c1 的 task 读授权）', () => {
    const wb = blindBoard();
    amend_grants(
      wb,
      { changes: [{ scope: 'c1', kind: 'task', access: 'read', op: 'revoke' }], reason: '收敛广播' },
      MAIN_SCOPE,
    );
    const seen = wb.view('c1').map((b) => b.id);
    expect(seen).not.toContain('tk');
    expect(seen).toContain('op1'); // 作者读自己不受授权变更影响
  });

  it('撤销无追回能力：撤权前已读到的块与审计历史不受影响', () => {
    const wb = blindBoard();
    amend_grants(wb, SHARE_C1, MAIN_SCOPE);
    const before = wb.view('c1'); // 已读到 op2
    wb.audit();
    amend_grants(
      wb,
      { changes: [{ scope: 'c1', kind: 'opinion', access: 'read', op: 'revoke' }], reason: '收回共享' },
      MAIN_SCOPE,
    );
    expect(before.map((b) => b.id)).toContain('op2'); // 历史结果不追回
    expect(wb.view('c1').map((b) => b.id)).not.toContain('op2'); // 后续收窄
    const readTrace = wb.audit().filter((e) => e.action === 'read' && e.block_id === 'op2' && e.scope === 'c1');
    expect(readTrace.length).toBeGreaterThan(0); // 留痕即追溯面
  });

  it('grant 幂等去重；revoke 无匹配 = 无操作不抛；mode 保持召集声明', () => {
    const wb = blindBoard();
    amend_grants(wb, SHARE_C1, MAIN_SCOPE);
    amend_grants(wb, SHARE_C1, MAIN_SCOPE);
    const grants = wb.current_grants();
    expect(grants.mode).toBe('blind');
    expect(
      grants.entries.filter((e) => e.scope === 'c1' && e.kind === 'opinion' && e.access === 'read'),
    ).toHaveLength(1);
    expect(() =>
      amend_grants(
        wb,
        { changes: [{ scope: 'ghost', kind: 'board', access: 'write', op: 'revoke' }], reason: '撤销不存在条目' },
        MAIN_SCOPE,
      ),
    ).not.toThrow();
    expect(wb.current_grants().entries).toHaveLength(grants.entries.length);
  });
});

describe('amendment 审计结构正确', () => {
  it('1 条审计：scope=仲裁者 × block_id=__grants__ × kind=amendment × write + 清单理由', () => {
    const wb = blindBoard();
    const entry = amend_grants(wb, SHARE_C1, MAIN_SCOPE);
    expect({ ...entry }).toEqual({
      scope: MAIN_SCOPE,
      block_id: GRANTS_AUDIT_BLOCK_ID,
      kind: AMENDMENT_AUDIT_KIND,
      action: 'write',
      amendment: SHARE_C1,
    });
    const total = wb.audit().filter((e) => e.kind === AMENDMENT_AUDIT_KIND);
    expect(total).toHaveLength(1);
  });
});

describe('变更单解析 fail-closed', () => {
  it('空清单 / 词表外 op / 词表外 kind / 空 reason / 非 dict 均抛 GraphDefinitionError', () => {
    expect(() => parse_grant_amendment({ changes: [], reason: 'x' })).toThrow(GraphDefinitionError);
    expect(() =>
      parse_grant_amendment({
        changes: [{ scope: 'c', kind: 'task', access: 'read', op: 'nope' }],
        reason: 'x',
      }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      parse_grant_amendment({
        changes: [{ scope: 'c', kind: 'unknown_kind', access: 'read', op: 'grant' }],
        reason: 'x',
      }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      parse_grant_amendment({
        changes: [{ scope: 'c', kind: 'task', access: 'read', op: 'grant' }],
        reason: '   ',
      }),
    ).toThrow(GraphDefinitionError);
    expect(() => parse_grant_amendment('nope')).toThrow(GraphDefinitionError);
  });

  it('apply_grant_amendment 纯函数：不改动入参授权集', () => {
    const grants = default_whiteboard_grants('blind', ['c1']);
    const snapshot = JSON.stringify(grants);
    apply_grant_amendment(grants, SHARE_C1);
    expect(JSON.stringify(grants)).toBe(snapshot);
  });
});

describe('序列化兼容（amendment 审计 / arbiter 前向兼容）', () => {
  it('to_dict/from_dict round-trip：amendment 审计与自定义 arbiter 全保真', () => {
    const wb = new Whiteboard(default_whiteboard_grants('blind', ['c1', 'c2']), {
      arbiter: 'chair',
    });
    wb.append(blk({ id: 'tk', kind: 'task', owner: 'main' }), 'main');
    const entry = amend_grants(wb, SHARE_C1, 'chair');
    expect(entry.scope).toBe('chair');
    const data = wb.to_dict();
    const restored = Whiteboard.from_dict(data);
    expect(restored.arbiter).toBe('chair');
    expect(restored.to_dict()).toEqual(data);
    expect(restored.audit()).toEqual(wb.audit());
  });

  it('缺省 arbiter 板不落 arbiter 键（零漂移）', () => {
    const data = new Whiteboard(default_whiteboard_grants('open', ['c1'])).to_dict();
    expect('arbiter' in data).toBe(false);
  });

  it('from_dict fail-closed：kind=amendment 审计缺 amendment 清单抛；普通审计带特记抛', () => {
    expect(() =>
      Whiteboard.from_dict({
        grants: { mode: 'blind', entries: [] },
        audit: [{ scope: 'main', block_id: GRANTS_AUDIT_BLOCK_ID, kind: 'amendment', action: 'write' }],
      }),
    ).toThrow(GraphDefinitionError);
    expect(() =>
      Whiteboard.from_dict({
        grants: { mode: 'blind', entries: [] },
        audit: [
          {
            scope: 'main',
            block_id: 'x',
            kind: 'task',
            action: 'read',
            amendment: { changes: SHARE_C1.changes, reason: 'r' },
          },
        ],
      }),
    ).toThrow(GraphDefinitionError);
  });
});
