/**
 * 会话级骨架校验单测（P4 §4.1「可写」局部重校验的纯逻辑面）——测的是：
 * - 结构校验与图编译语义对齐（入口/出口/边引用/静态与条件混用）；
 * - 池成员校验（执行体只能来自池：未知类型/未注册条件显式拒绝）；
 * - 可达 + 终态校验（入口不可达出口 / 无可达终态出口拒绝；无终态候选池 =
 *   退化只做结构/可达判定）。
 */

import { describe, expect, it } from 'vitest';

import { ThreadSkeleton } from '../../../src/core/thread_skeleton/index.js';
import {
  validate_skeleton_impl,
  type SkeletonPoolEnv,
} from '../../../src/kernel/thread_skeleton/index.js';

/** 默认测试池视图：llm_decider 为唯一已知 + 终态类型；COND_LLM_PENDING 已注册。 */
function poolEnv(overrides: Partial<SkeletonPoolEnv> = {}): SkeletonPoolEnv {
  return {
    has_type: (type) => type === 'llm_decider',
    is_terminal: (type) => type === 'llm_decider',
    has_any_terminal: () => true,
    has_condition: (name) => name === 'COND_LLM_PENDING',
    ...overrides,
  };
}

function singleNode(overrides: Partial<Record<string, unknown>> = {}): ThreadSkeleton {
  return new ThreadSkeleton({
    thread_id: 't',
    entry: 'decide',
    nodes: { decide: { type: 'llm_decider' } },
    edges: {},
    exits: ['decide'],
    ...overrides,
  });
}

describe('validate_skeleton_impl（结构 + 池成员 + 可达/终态）', () => {
  it('通过：单节点终态骨架（入口=出口=终态类型）', () => {
    const result = validate_skeleton_impl(singleNode(), poolEnv());
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('拒绝：节点引用未知类型（执行体只能来自池）', () => {
    const skeleton = new ThreadSkeleton({
      thread_id: 't',
      entry: 'ghost',
      nodes: { ghost: { type: 'not_registered_type' } },
      exits: ['ghost'],
    });
    const result = validate_skeleton_impl(skeleton, poolEnv());
    expect(result.ok).toBe(false);
    expect(result.reasons.join('')).toContain('未入池类型');
  });

  it('拒绝：入口/出口引用不存在节点（结构校验）', () => {
    const missingEntry = singleNode({ entry: 'nope' });
    expect(validate_skeleton_impl(missingEntry, poolEnv()).ok).toBe(false);
    const missingExit = singleNode({ exits: ['nope'] });
    expect(validate_skeleton_impl(missingExit, poolEnv()).ok).toBe(false);
    const noExit = singleNode({ exits: [] });
    expect(validate_skeleton_impl(noExit, poolEnv()).ok).toBe(false);
  });

  it('拒绝：入口不可达任何出口（骨架不可终止）', () => {
    const skeleton = new ThreadSkeleton({
      thread_id: 't',
      entry: 'a',
      nodes: { a: { type: 'llm_decider' }, b: { type: 'llm_decider' } },
      edges: {},
      exits: ['b'],
    });
    const result = validate_skeleton_impl(skeleton, poolEnv());
    expect(result.ok).toBe(false);
    expect(result.reasons.join('')).toContain('入口不可达任何出口');
  });

  it('拒绝：出口非终态候选而池内存在终态候选（骨架须落终态出口）', () => {
    const skeleton = singleNode({
      entry: 'a',
      nodes: { a: { type: 'tool_pipeline' } },
      exits: ['a'],
    });
    const env = poolEnv({
      has_type: (type) => type === 'llm_decider' || type === 'tool_pipeline',
      is_terminal: (type) => type === 'llm_decider',
    });
    const result = validate_skeleton_impl(skeleton, env);
    expect(result.ok).toBe(false);
    expect(result.reasons.join('')).toContain('无可达的终态出口');
  });

  it('退化池：无终态候选池只做结构/可达判定（不误拒非终态出口）', () => {
    const skeleton = singleNode({
      nodes: { a: { type: 'plain_node' } },
      entry: 'a',
      exits: ['a'],
    });
    const env = poolEnv({
      has_type: () => true,
      is_terminal: () => false,
      has_any_terminal: () => false,
    });
    const result = validate_skeleton_impl(skeleton, env);
    expect(result.ok).toBe(true);
  });

  it('拒绝：边引用未注册条件（条件边先验须已登记）', () => {
    const skeleton = singleNode({
      edges: { decide: [{ target: 'decide', condition: 'NO_SUCH_COND' }] },
    });
    const result = validate_skeleton_impl(skeleton, poolEnv());
    expect(result.ok).toBe(false);
    expect(result.reasons.join('')).toContain('未注册条件');
  });

  it('拒绝：静态边与条件边混用（与图编译语义一致，防闷杀条件边）', () => {
    const skeleton = singleNode({
      edges: { decide: [{ target: 'decide' }, { target: 'decide', condition: 'COND_LLM_PENDING' }] },
    });
    const result = validate_skeleton_impl(skeleton, poolEnv());
    expect(result.ok).toBe(false);
    expect(result.reasons.join('')).toContain('混用');
  });

  it('拒绝：active_target 引用不存在节点', () => {
    const skeleton = singleNode({ active_target: 'missing' });
    expect(validate_skeleton_impl(skeleton, poolEnv()).ok).toBe(false);
  });

  it('可达：多节点链入口 → 中间 → 终态出口通过', () => {
    const skeleton = new ThreadSkeleton({
      thread_id: 't',
      entry: 'a',
      nodes: { a: { type: 'llm_decider' }, b: { type: 'llm_decider' } },
      edges: { a: [{ target: 'b' }] },
      exits: ['b'],
    });
    expect(validate_skeleton_impl(skeleton, poolEnv()).ok).toBe(true);
  });

  it('validate_skeleton（Runtime 公开面数据形态）对实例与 dict 等效', () => {
    const skeleton = singleNode();
    const env = poolEnv();
    expect(validate_skeleton_impl(skeleton, env)).toEqual(
      validate_skeleton_impl(ThreadSkeleton.from_dict(skeleton.to_dict()), env),
    );
  });
});
