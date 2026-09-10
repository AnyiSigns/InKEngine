/**
 * scope_turn 白板装配测试（build_turn_input：零漂移 + 块→物理输入集成）。
 *
 * 测什么：
 * - 零漂移：blocks 为 undefined / 空数组时，async build_turn_input 与旧同步版
 *   行为逐字段一致（空载荷 ''、task 拼接、payload 投影、task 键直推）；
 * - 带白板：被授权块经 build_block_sources 生成装配源、交既有调配管线
 *   （ContextMixer 确定性组装）拼进本次调用的 input——块标题（【任务块】等）
 *   与内容在场，payload 投影作为 scope.context 源同批装配；
 * - 预算随作用域 model 走（§7.5）：小 context_window 下超长块内容被裁，
 *   input 长度受调配预算硬上界约束。
 */
import { describe, expect, it } from 'vitest';

import { build_turn_input } from '../../../src/core/execution_runtime/scope_turn.js';
import type { AuthorizedBlock } from '../../../src/core/context/block_source.js';

function block(kind: AuthorizedBlock['kind'], owner: string, content: string, seq = 0): AuthorizedBlock {
  return { kind, owner, content, seq };
}

describe('零漂移：无白板时与旧同步 build_turn_input 逐字段一致', () => {
  it('空 task + 空载荷 = 空字符串', async () => {
    expect(await build_turn_input('', {}, undefined)).toBe('');
  });

  it('空 task + 载荷 = 投影文本（task 键直推、其余 key: value）', async () => {
    expect(await build_turn_input('', { task: '做一件事', count: 2 }, undefined)).toBe(
      '做一件事\ncount: 2',
    );
  });

  it('task + 空载荷 = task 原文', async () => {
    expect(await build_turn_input('做一件事', {}, undefined)).toBe('做一件事');
  });

  it('task + 载荷 = task \\n 投影（既有拼接序）', async () => {
    expect(await build_turn_input('做一件事', { note: '备注' }, undefined)).toBe(
      '做一件事\nnote: 备注',
    );
  });

  it('空块数组 [] 与 undefined 等价（零漂移不因空清单引入装配段）', async () => {
    expect(await build_turn_input('任务', { a: 1 }, [])).toBe(await build_turn_input('任务', { a: 1 }, undefined));
    expect(await build_turn_input('任务', { a: 1 }, [])).toBe('任务\na: 1');
  });
});

describe('带白板：块 → 物理输入（装配源经既有调配管线拼进 input）', () => {
  it('task + opinion 块进 input：块标题行与内容在场（调用级临时拼接）', async () => {
    const blocks = [
      block('task', 'main', '分析季度数据'),
      block('opinion', 'collab_a', '我认为应先看趋势线', 1),
    ];
    const input = await build_turn_input('', { task: '会话任务' }, blocks);
    expect(input).toContain('【任务块】');
    expect(input).toContain('分析季度数据');
    expect(input).toContain('【意见块 #1】');
    expect(input).toContain('我认为应先看趋势线');
  });

  it('payload 投影作为 scope.context 源同批装配（私有上下文不丢）', async () => {
    const blocks = [block('task', 'main', '任务内容')];
    const input = await build_turn_input('', { task: '会话任务', hint: '私有提示' }, blocks);
    expect(input).toContain('hint: 私有提示');
    expect(input).toContain('会话任务');
  });

  it('task 前缀 + 装配段顺序：task 在前、装配文本随后', async () => {
    const blocks = [block('task', 'main', '块内容')];
    const input = await build_turn_input('根任务', {}, blocks);
    expect(input.startsWith('根任务\n')).toBe(true);
    expect(input).toContain('块内容');
  });

  it('结论块走主持人域：与协作块同批装配（两域内容都进 input）', async () => {
    const blocks = [
      block('task', 'main', '协作任务'),
      block('opinion', 'collab_a', '意见甲', 1),
      block('conclusion', 'main', '裁决结论'),
    ];
    const input = await build_turn_input('', {}, blocks);
    expect(input).toContain('协作任务');
    expect(input).toContain('意见甲');
    expect(input).toContain('【结论块】');
    expect(input).toContain('裁决结论');
  });
});

describe('预算随作用域 model 走（§7.5）：小窗口下装配受预算硬上界约束', () => {
  it('context_window=1000 时超长块内容被裁，input 长度有上界（低分源按预算语义可被 drop）', async () => {
    const blocks = [
      block('task', 'main', '任务'.repeat(500)),
      block('opinion', 'collab_a', '意见'.repeat(500), 1),
    ];
    const input = await build_turn_input('', { hint: 'h'.repeat(300) }, blocks, {
      context_window: 1000,
    });
    // 调配切片预算 = trunc(0.8×1000)×0.25 = 200 字符（含标题/分隔开销）：
    // 装配段受硬上界约束（超长块内容被裁，不得整块在场）；
    // 低分源（scope.context score=0.5 → 截断份额 < MIN_TRUNCATE_CHARS）按
    // 预算语义被 drop——「同块集在不同 cw 下可被裁得不同，属预期而非漂移」。
    expect(input).toContain('【任务块】');
    expect(input).not.toContain('任务'.repeat(500));
    expect(input.length).toBeLessThan('任务'.repeat(500).length);
  });

  it('中等窗口下 scope.context（payload 投影）与块内容同批在场', async () => {
    const blocks = [block('task', 'main', '任务内容')];
    const input = await build_turn_input('', { hint: '私有提示' }, blocks, {
      context_window: 20000,
    });
    expect(input).toContain('hint: 私有提示');
    expect(input).toContain('任务内容');
  });

  it('大窗口（缺省兜底 200k）下块内容完整保留', async () => {
    const content = '完整内容标记';
    const blocks = [block('task', 'main', content)];
    const input = await build_turn_input('', {}, blocks);
    expect(input).toContain(content);
  });
});
