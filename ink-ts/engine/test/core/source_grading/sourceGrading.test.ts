/**
 * 来源分级常量/辅助单测（语义对标 ink_engine/core/source_grading.py）：
 * 来源四档字面量与升序、默认可信度基准映射、未知来源回退、可信度分级
 * 档位边界。模块零依赖纯函数，直接导入断言即可。
 */
import { describe, expect, it } from 'vitest';

import {
  SOURCE_DIALOG,
  SOURCE_MODEL,
  SOURCE_ORDER,
  SOURCE_USER,
  SOURCE_WEB,
  _SOURCE_CREDIBILITY,
  default_credibility,
  grade_level_for_credibility,
} from '../../../src/core/source_grading/sourceGrading.js';

describe('来源常量', () => {
  it('四档来源字面量正确', () => {
    expect(SOURCE_WEB).toBe('web');
    expect(SOURCE_DIALOG).toBe('dialog');
    expect(SOURCE_MODEL).toBe('model');
    expect(SOURCE_USER).toBe('user');
  });

  it('SOURCE_ORDER 按 web < dialog < model < user 升序', () => {
    expect(SOURCE_ORDER).toEqual([SOURCE_WEB, SOURCE_DIALOG, SOURCE_MODEL, SOURCE_USER]);
  });

  it('默认可信度基准按来源映射定值', () => {
    expect(_SOURCE_CREDIBILITY[SOURCE_WEB]).toBe(0.3);
    expect(_SOURCE_CREDIBILITY[SOURCE_DIALOG]).toBe(0.6);
    expect(_SOURCE_CREDIBILITY[SOURCE_MODEL]).toBe(0.7);
    expect(_SOURCE_CREDIBILITY[SOURCE_USER]).toBe(0.9);
  });
});

describe('default_credibility', () => {
  it('按来源返回默认可信度', () => {
    expect(default_credibility(SOURCE_WEB)).toBe(0.3);
    expect(default_credibility(SOURCE_DIALOG)).toBe(0.6);
    expect(default_credibility(SOURCE_MODEL)).toBe(0.7);
    expect(default_credibility(SOURCE_USER)).toBe(0.9);
  });

  it('未知来源回退模型级可信度（保守不激进）', () => {
    expect(default_credibility('unknown')).toBe(0.7);
    expect(default_credibility('')).toBe(0.7);
  });
});

describe('grade_level_for_credibility', () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [1.0, SOURCE_USER],
    [0.9, SOURCE_USER],
    [0.89, SOURCE_MODEL],
    [0.7, SOURCE_MODEL],
    [0.69, SOURCE_DIALOG],
    [0.6, SOURCE_DIALOG],
    [0.59, SOURCE_WEB],
    [0.3, SOURCE_WEB],
  ];

  it('按可信度自高向低匹配首个达标档位', () => {
    for (const [credibility, expected] of cases) {
      expect(grade_level_for_credibility(credibility)).toBe(expected);
    }
  });

  it('档位边界按 1e-9 容差判定', () => {
    expect(grade_level_for_credibility(0.9 - 1e-10)).toBe(SOURCE_USER);
    expect(grade_level_for_credibility(0.9 - 1e-9)).toBe(SOURCE_USER);
    expect(grade_level_for_credibility(0.9 - 2e-9)).toBe(SOURCE_MODEL);
    expect(grade_level_for_credibility(0.7 - 1e-9)).toBe(SOURCE_MODEL);
  });

  it('均不匹配最低档时回退 web', () => {
    expect(grade_level_for_credibility(0.3 - 1e-6)).toBe(SOURCE_WEB);
    expect(grade_level_for_credibility(-1)).toBe(SOURCE_WEB);
  });
});
