/**
 * R6 词法顺序槽 + R7 进度对齐槽 行为测试（自 features.test.ts 拆出，控制单文件
 * ≤350 行纪律）。R6 槽是静态指令编码（distinct 首现序）；R7 槽是进度指针
 * （occurrencePlan 逐位置 + hist 消耗），两者口径不同属设计语义。
 */

import { describe, expect, it } from 'vitest';

import {
  GOAL_HINT_DIM,
  HASH_DIM,
  HIST_DIM,
  MENTION_DIM,
  NEXT_OP_DIM,
  NUM_DIM,
  OBS_DIM,
  ORDER_DIM,
  ORDER_SLOTS,
  STATE_DIM,
  STEP_DIM,
  type ObsView,
  featurizeInstr,
  featurizeObs,
} from '../controller/features.js';
import { LEX_OPS_BASE } from '../world/operators.js';

describe('R6 词法顺序槽（义项首现升序 one-hot）', () => {
  const orderOf = (instr: string): number[] => {
    const a = featurizeInstr(instr);
    const off = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM;
    const out: number[] = [];
    for (let j = 0; j < ORDER_SLOTS; j++) {
      let found = -1;
      for (let k = 0; k < LEX_OPS_BASE.length; k++) {
        if (a[off + j * LEX_OPS_BASE.length + k] === 1) {
          found = k;
          break;
        }
      }
      out.push(found);
    }
    return out;
  };

  it('按渲染顺序逐位 one-hot：加三→翻倍→减一', () => {
    const idx = (id: string): number => LEX_OPS_BASE.indexOf(id);
    const slots = orderOf('先加三，然后翻倍，最后减一');
    expect(slots[0]).toBe(idx('add3'));
    expect(slots[1]).toBe(idx('mul2'));
    expect(slots[2]).toBe(idx('sub1'));
    expect(slots[3]).toBe(-1);
  });

  it('并列共享义项（`取反` → neg/reverse）按 LEX_OPS_BASE 固定序占位（与弱扫描同源）', () => {
    const slots = orderOf('把值取反再提交');
    expect(slots[0]).toBe(LEX_OPS_BASE.indexOf('neg'));
    expect(slots[0]).toBeLessThan(LEX_OPS_BASE.indexOf('reverse'));
  });

  it('未提及算子不占槽；重复提及只占首现槽', () => {
    const slots = orderOf('加三，再加三');
    const idx = (id: string): number => LEX_OPS_BASE.indexOf(id);
    expect(slots[0]).toBe(idx('add3'));
    expect(slots[1]).toBe(-1);
    expect(slots[2]).toBe(-1);
  });

  it('goal 族指令（无算子义项）顺序槽全零；hash_only 消融不含顺序槽', () => {
    const g = featurizeInstr('结果大于20');
    const off = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM;
    for (let j = 0; j < ORDER_DIM; j++) expect(g[off + j]).toBe(0);
    expect(featurizeInstr('先加三', 'hash_only').length).toBe(HASH_DIM);
  });
});

describe('R7 进度对齐槽（下一个待执行算子 one-hot，occurrence 指针语义）', () => {
  const NEXT_OP_OFF = MENTION_DIM + GOAL_HINT_DIM + NUM_DIM + ORDER_DIM + HASH_DIM;
  const idx = (id: string): number => LEX_OPS_BASE.indexOf(id);
  const obsOf = (hist: readonly string[]): ObsView => ({ x: null, answer: null, verdict: null, hist });
  const nextOf = (instr: string, hist: readonly string[]): number => {
    const v = featurizeObs(instr, obsOf(hist), 'lang');
    for (let k = 0; k < NEXT_OP_DIM; k++) {
      if (v[NEXT_OP_OFF + k] === 1) return k;
    }
    return -1;
  };

  it('按指令义项出现位置逐位推进（distinct-op 任务）', () => {
    const instr = '先加三，然后翻倍，最后减一';
    expect(nextOf(instr, [])).toBe(idx('add3'));
    expect(nextOf(instr, ['add3'])).toBe(idx('mul2'));
    expect(nextOf(instr, ['add3', 'mul2'])).toBe(idx('sub1'));
    expect(nextOf(instr, ['noop', 'shuffle'])).toBe(idx('add3')); // 非序列节点不消耗
  });

  it('重复算子任务：hist 逐次消耗同算子多个位置（P0 回归）', () => {
    // 「加三，再加三，然后提交」→ 位置序 [add3, add3, submit]
    const instr = '加三，再加三，然后提交';
    expect(nextOf(instr, [])).toBe(idx('add3'));
    expect(nextOf(instr, ['add3'])).toBe(idx('add3')); // 第二次 add3 仍在
    expect(nextOf(instr, ['add3', 'add3'])).toBe(idx('submit'));
  });

  it('decoy 干预不消耗序列位置', () => {
    const instr = '加三，再加三，然后提交';
    expect(nextOf(instr, ['add3', 'mul2', 'add3'])).toBe(idx('submit'));
    expect(nextOf(instr, ['mul2'])).toBe(idx('add3'));
  });

  it('终算子续步：submit 后仍按序列推进到 check（R5 trace 含终算子）', () => {
    const instr = '加三，然后提交，接着检查奇偶';
    expect(nextOf(instr, ['add3'])).toBe(idx('submit'));
    expect(nextOf(instr, ['add3', 'submit'])).toBe(idx('check_parity'));
  });

  it('并列共享义项（`取反` → neg/reverse）组内任一算子执行即消耗该位置', () => {
    expect(nextOf('把值取反再提交', [])).toBe(idx('neg'));
    expect(nextOf('把值取反再提交', ['neg'])).toBe(idx('submit'));
    expect(nextOf('把值取反再提交', ['reverse'])).toBe(idx('submit'));
  });

  it('历史耗尽 → 该段全零（此时应选 submit/check/exit，靠原特征）', () => {
    const v = featurizeObs('先加三', obsOf(['add3']), 'lang');
    for (let j = 0; j < NEXT_OP_DIM; j++) expect(v[NEXT_OP_OFF + j]).toBe(0);
    expect(nextOf('先加三', ['add3'])).toBe(-1);
  });

  it('goal 族指令（无算子义项）恒零；hash_only 消融不含本段', () => {
    const g = featurizeObs('结果大于20', obsOf([]), 'lang');
    for (let j = 0; j < NEXT_OP_DIM; j++) expect(g[NEXT_OP_OFF + j]).toBe(0);
    const h = featurizeObs('先加三', obsOf([]), 'hash_only');
    expect(h.length).toBe(OBS_DIM.hash_only);
    expect(h.length).toBe(HASH_DIM + STATE_DIM + HIST_DIM + STEP_DIM);
  });
});
