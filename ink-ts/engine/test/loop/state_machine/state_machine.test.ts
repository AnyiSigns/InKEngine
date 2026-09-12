/**
 * 状态机原语与 append-only 转换日志对标测试（逐点对标 pytest
 * test_state_machine.py）。覆盖：StateMachine 合法状态判定/终态单向/可选
 * 白名单/声明期校验，TransitionLog 的 append-only 累积/当前状态推导/无变化
 * 与非法目标拒绝写日志，回滚（截断重推）/历史回溯/序列化往返。
 *
 * Python frozenset 比较在 TS 以元素断言表达；Python 冻结数据类赋值即抛
 * AttributeError，在 TS 为冻结实例赋值抛 TypeError（ES 严格模式）。at 缺省
 * 依赖时间源：原测试断言 at > 0 处改经 now seam 注入确定值断言。
 */
import { describe, expect, it } from 'vitest';

import {
  INITIAL_STATE,
  StateMachine,
  StateTransition,
  TransitionLog,
} from '../../../src/core/state_machine/state_machine.js';

// 测试用状态机：draft → review → published（终态）/ rejected
const _STATES = ['draft', 'review', 'published', 'rejected'];

function _machine(): StateMachine {
  return new StateMachine(_STATES, { terminal_states: ['published'], name: 'doc' });
}

describe('StateMachine 规则', () => {
  it('test_valid_state：合法状态判定，None 是初始前态占位而非合法状态', () => {
    const m = _machine();
    expect(m.is_valid_state('draft')).toBe(true);
    expect(m.is_valid_state('bogus')).toBe(false);
    expect(m.is_valid_state(INITIAL_STATE)).toBe(false);
  });

  it('test_states_and_terminal_exposed：状态集/终态集/名称暴露', () => {
    const m = _machine();
    expect([...m.states].sort()).toEqual([..._STATES].sort());
    expect([...m.terminal_states]).toEqual(['published']);
    expect(m.name).toBe('doc');
    expect(m.is_terminal('published')).toBe(true);
    expect(m.is_terminal('draft')).toBe(false);
  });

  it('test_initial_write_allowed_for_any_valid_state：初始写入任意合法状态放行', () => {
    const m = _machine();
    for (const state of _STATES) {
      expect(m.is_illegal_transition(INITIAL_STATE, state)).toBe(false);
    }
  });

  it('test_invalid_target_is_illegal：目标不在状态集为非法', () => {
    expect(_machine().is_illegal_transition('draft', 'bogus')).toBe(true);
  });

  it('test_terminal_state_is_one_way：终态单向，未声明白名单时非终态自由转换', () => {
    const m = _machine();
    expect(m.is_illegal_transition('published', 'draft')).toBe(true);
    expect(m.is_illegal_transition('published', 'review')).toBe(true);
    expect(m.is_illegal_transition('rejected', 'review')).toBe(false);
    expect(m.is_illegal_transition('draft', 'published')).toBe(false);
  });

  it('test_allowed_whitelist_restricts_transitions：白名单约束转换', () => {
    const m = new StateMachine(_STATES, {
      terminal_states: ['published'],
      allowed: {
        draft: ['review'],
        review: ['published', 'rejected'],
        rejected: ['draft'],
      },
      name: 'doc_strict',
    });
    expect(m.is_illegal_transition('draft', 'review')).toBe(false);
    // 白名单外：draft 不能直接发布
    expect(m.is_illegal_transition('draft', 'published')).toBe(true);
    expect(m.is_illegal_transition('review', 'published')).toBe(false);
    // 初始写入不受白名单约束（只校验目标状态合法性）
    expect(m.is_illegal_transition(INITIAL_STATE, 'published')).toBe(false);
  });

  it('test_whitelist_missing_source_blocks_all：白名单缺前态来源 = 全部拦截', () => {
    const m = new StateMachine(_STATES, {
      allowed: { draft: ['review'] },
      name: 'partial',
    });
    expect(m.is_illegal_transition('review', 'draft')).toBe(true);
  });

  it('test_unknown_terminal_state_rejected_at_declaration：声明期终态越界报错', () => {
    expect(() =>
      new StateMachine(['a', 'b'], { terminal_states: ['c'], name: 'bad' }),
    ).toThrow(/终态/);
  });

  it('test_unknown_whitelist_state_rejected_at_declaration：声明期白名单越界报错', () => {
    expect(() =>
      new StateMachine(['a', 'b'], { allowed: { a: ['zzz'] }, name: 'bad' }),
    ).toThrow(/白名单/);
  });
});

describe('TransitionLog', () => {
  it('test_current_state_derived_from_log：当前状态由日志推导', () => {
    const log = _machine().log();
    expect(log.current_state).toBeNull();
    log.append('draft', { actor: 'user' });
    expect(log.current_state).toBe('draft');
    log.append('review', { actor: 'user' });
    expect(log.current_state).toBe('review');
    expect(log.length).toBe(2);
  });

  it('test_initial_state_seeds_current_state：初始状态作空日志当前状态', () => {
    const log = _machine().log({ initial_state: 'review' });
    expect(log.current_state).toBe('review');
    const entry = log.append('published');
    expect(entry).not.toBeNull();
    expect(entry?.from_state).toBe('review');
  });

  it('test_noop_transition_not_logged：无变化转换拒绝写入', () => {
    const log = _machine().log({ initial_state: 'draft' });
    expect(log.append('draft')).toBeNull();
    expect(log.length).toBe(0);
  });

  it('test_invalid_target_not_logged：非法目标拒绝写入', () => {
    const log = _machine().log({ initial_state: 'draft' });
    expect(log.append('bogus')).toBeNull();
    expect(log.length).toBe(0);
    expect(log.current_state).toBe('draft');
  });

  it('test_illegal_transition_blocked_with_audit：终态复活在 append 内强制拦截', () => {
    const machine = _machine();
    const log = machine.log({ initial_state: 'published' });
    expect(machine.is_illegal_transition('published', 'draft')).toBe(true);
    expect(log.append('draft')).toBeNull();
    expect(log.current_state).toBe('published');
    expect(log.length).toBe(0);
  });

  it('test_allowed_whitelist_violation_blocked：白名单外转换同样拦截', () => {
    const machine = new StateMachine(_STATES, {
      terminal_states: ['published'],
      allowed: { draft: ['review'] },
      name: 'doc_strict',
    });
    const log = machine.log({ initial_state: 'draft' });
    expect(log.append('published')).toBeNull(); // draft 不能直接发布
    expect(log.append('review')).not.toBeNull(); // 白名单内放行
    expect(log.current_state).toBe('review');
  });

  it('test_history_is_ordered_and_copied：历史正序且返回副本', () => {
    const log = _machine().log();
    log.append('draft');
    log.append('review');
    const history = log.history();
    expect(history.map((e) => e.to_state)).toEqual(['draft', 'review']);
    expect(history.map((e) => e.from_state)).toEqual([null, 'draft']);
    // 返回副本：外部追加不影响日志本体
    history.push(new StateTransition({ to_state: 'published' }));
    expect(log.length).toBe(2);
  });

  it('test_metadata_recorded：actor/note/meta/at 完整落条目', () => {
    const log = _machine().log();
    const entry = log.append('draft', {
      actor: 'agent',
      note: '写工具创建',
      meta: { chapter_id: 7 },
      at: 1234.5,
    });
    expect(entry).not.toBeNull();
    expect(entry?.actor).toBe('agent');
    expect(entry?.note).toBe('写工具创建');
    expect(entry?.meta).toEqual({ chapter_id: 7 });
    expect(entry?.at).toBe(1234.5);
  });

  it('test_meta_defensively_copied：meta 防御性拷贝', () => {
    const log = _machine().log();
    const meta = { k: 1 };
    const entry = log.append('draft', { meta });
    meta['k'] = 999;
    expect(entry).not.toBeNull();
    expect(entry?.meta).toEqual({ k: 1 });
  });

  it('test_rollback_truncates_and_rederives_state：回滚截断重推当前状态', () => {
    const log = _machine().log();
    log.append('draft');
    log.append('review');
    log.append('rejected');
    expect(log.rollback()).toBe('review');
    expect(log.length).toBe(2);
    expect(log.rollback(5)).toBeNull();
    expect(log.length).toBe(0);
  });

  it('test_rollback_non_positive_is_noop：非正步数为空操作', () => {
    const log = _machine().log();
    log.append('draft');
    expect(log.rollback(0)).toBe('draft');
    expect(log.rollback(-3)).toBe('draft');
    expect(log.length).toBe(1);
  });

  it('test_log_rebuilt_from_entries：从存储读回的条目重建日志并推导状态', () => {
    const entries = [
      new StateTransition({ to_state: 'draft' }),
      new StateTransition({ to_state: 'review', from_state: 'draft' }),
    ];
    const log = new TransitionLog(_machine(), { entries });
    expect(log.current_state).toBe('review');
    expect(log.length).toBe(2);
  });

  it('test_machine_exposed：日志持有其状态机', () => {
    const machine = _machine();
    expect(machine.log().machine).toBe(machine);
  });
});

describe('StateTransition 序列化', () => {
  it('test_dict_round_trip：to_dict/from_dict 往返相等', () => {
    const entry = new StateTransition({
      to_state: 'review',
      from_state: 'draft',
      actor: 'agent',
      note: 'n',
      at: 100.0,
      meta: { a: 1 },
    });
    const restored = StateTransition.from_dict(entry.to_dict());
    expect(restored).toEqual(entry);
  });

  it('test_from_dict_tolerates_missing_fields：字段缺失走默认值（存储 schema 增量演进兼容）', () => {
    const restored = StateTransition.from_dict(
      { to_state: 'draft' },
      { now: () => 123.5 },
    );
    expect(restored.to_state).toBe('draft');
    expect(restored.from_state).toBeNull();
    expect(restored.actor).toBe('system');
    expect(restored.note).toBeNull();
    expect(restored.meta).toEqual({});
    expect(restored.at).toBe(123.5);
  });

  it('test_immutable：冻结实例赋值即抛错', () => {
    const entry = new StateTransition({ to_state: 'draft' });
    expect(() => {
      (entry as unknown as Record<string, unknown>)['to_state'] = 'review';
    }).toThrow(TypeError);
  });
});
