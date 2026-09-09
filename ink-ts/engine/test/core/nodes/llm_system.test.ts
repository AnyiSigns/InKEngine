/**
 * compose_llm_system 纯函数单测（boot 只读基线 + 自定义 system_prompt 拼一份）。
 *
 * 覆盖四形态（口径决议 16）：boot+custom 双非空 = `boot\n\ncustom`（boot 恒前）；
 * 仅 boot = boot 原样；仅 custom = custom 原样；双空 = ''。零分隔符/顺序漂移。
 */

import { describe, expect, it } from 'vitest';

import { compose_llm_system } from '../../../src/core/nodes/llm_system.js';

describe('compose_llm_system 合成', () => {
  it('boot 与 custom 双非空 → `boot + \\n\\n + custom`（boot 恒前）', () => {
    expect(compose_llm_system('BOOT', 'CUSTOM')).toBe('BOOT\n\nCUSTOM');
    expect(compose_llm_system('BOOT-A', 'BOOT-B')).toBe('BOOT-A\n\nBOOT-B');
  });

  it('仅 boot（custom 空）→ boot 原样（不加分隔符/尾随空行）', () => {
    expect(compose_llm_system('BOOT', '')).toBe('BOOT');
  });

  it('仅 custom（boot 空）→ custom 原样（boot 未注入零漂移回落）', () => {
    expect(compose_llm_system('', 'CUSTOM')).toBe('CUSTOM');
    expect(compose_llm_system('', '')).toBe('');
  });

  it('双空 → 空串（不产生 system 消息）', () => {
    expect(compose_llm_system('', '')).toBe('');
  });

  it('自定义含多行文本时保留原文（仅插入一次分隔）', () => {
    const custom = '第一行\n第二行';
    expect(compose_llm_system('BOOT', custom)).toBe(`BOOT\n\n${custom}`);
  });
});
