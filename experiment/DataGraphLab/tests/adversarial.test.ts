import { describe, expect, it } from 'vitest';

import { FUZZ_COUNT, WRONG_ARTIFACTS, runAll } from '../verify/adversarial.js';
import { accept } from '../verify/acceptor.js';

describe('verify/adversarial 必拒错误产物套件（§4 对抗清单）', () => {
  it('套件非空且四族全覆盖', () => {
    expect(WRONG_ARTIFACTS.length).toBeGreaterThan(0);
    const families = new Set(WRONG_ARTIFACTS.map((c) => c.task.family));
    expect([...families].sort()).toEqual(['goal', 'goal_verify', 'value', 'verify']);
  });

  it('套件内每一条错误产物都被 accept 拒绝', () => {
    for (const c of WRONG_ARTIFACTS) {
      expect(accept(c.task, c.state), `${c.label} 应被拒`).toBe(false);
    }
  });

  it('runAll：错误产物 100% 被拒 + 正确通道产物 100% 被收（防全拒通关）', () => {
    const r = runAll();
    expect(r.rejectRatio).toBe(1);
    expect(r.acceptCorrectRatio).toBe(1);
    expect(r.caseCount).toBe(WRONG_ARTIFACTS.length + FUZZ_COUNT);
  });

  it('runAll 确定性：固定 seed 两次运行结果一致', () => {
    expect(runAll()).toEqual(runAll());
  });
});
