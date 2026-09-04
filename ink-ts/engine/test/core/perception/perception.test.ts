/**
 * core/perception.ts 测试：感知结点注册 + 双通道交叉验证 + 截图外发分级。
 *
 * 对标 pytest test_perception.py 全部用例（本模块语义；组装器集成面以
 * 注册表口径覆盖）：
 * - 感知结点注册 + 可组装（登记进结点类型注册表，进入组装器结点池，
 *   factory 产出结构化描述）；
 * - 视觉任务成败由执行器经通用边证据机制统一留痕（无专用函数——
 *   通用机制覆盖）；
 * - 双通道交叉验证（一致直进 / 不一致触发复核信号 + 降级决策）；
 * - 截图外发分级（本地多模态直喂、云端默认禁外发、授权放开）。
 *
 * 结点池口径说明：组装器结点池 = 注册表内全部带契约的类型（只取
 * contract_for 非空者），此处直接按该口径由注册表取池快照断言——与
 * 路径组装器侧的池快照同源同义。
 */

import { describe, expect, it } from 'vitest';

import { NodeTypeRegistry } from '../../../src/core/registry/registry.js';
import type { NodeContract } from '../../../src/core/contracts/contracts.js';
import {
  EXPORT_ALLOW,
  EXPORT_DENY,
  MODEL_CLOUD,
  MODEL_LOCAL,
  VALIDATE_PROCEED,
  VALIDATE_REVIEW,
  VISION_PERCEIVE_TYPE,
  CrossValidationResult,
  VisionExportDecision,
  classify_vision_export,
  cross_validate_channels,
  register_perception_nodes,
} from '../../../src/core/perception/perception.js';

/** 注册后的感知契约（完整契约类形态：schema 字段可读）。 */
function registered_contract(registry: NodeTypeRegistry): NodeContract {
  const raw = registry.contract_for(VISION_PERCEIVE_TYPE);
  expect(raw).toBeDefined();
  return raw as unknown as NodeContract;
}

/** 组装器结点池快照口径：注册表内全部带契约类型名。 */
function contract_pool(registry: NodeTypeRegistry): Map<string, unknown> {
  const pool = new Map<string, unknown>();
  for (const type_name of registry.types()) {
    const contract = registry.contract_for(type_name);
    if (contract !== undefined) pool.set(type_name, contract);
  }
  return pool;
}

/** 单通道结果构造（元素清单字符串形态，与 Python 用例同形）。 */
function _chan(elements: string): Record<string, unknown> {
  return { elements, description: 'x' };
}

// ── 感知结点注册 + 可组装 ──

describe('感知结点注册 + 可组装', () => {
  it('test_perception_node_registered_with_contract：登记携带契约，输入 = 截图引用、输出 = 结构化描述', () => {
    const registry = new NodeTypeRegistry();
    register_perception_nodes(registry);
    expect(registry.has(VISION_PERCEIVE_TYPE)).toBe(true);
    const contract = registered_contract(registry);
    expect(contract.safety_tier).toBe(1);
    expect(new Set(contract.input_schema!.fields.map((f) => f.name))).toEqual(
      new Set(['image_url', 'image_path']),
    );
    const output_names = new Set(contract.output_schema!.fields.map((f) => f.name));
    expect(output_names.has('description')).toBe(true);
  });

  it('test_perception_node_in_assembler_pool：登记后进入组装器结点池（可被组装进路径）', () => {
    const registry = new NodeTypeRegistry();
    register_perception_nodes(registry);
    const pool = contract_pool(registry);
    expect(pool.has(VISION_PERCEIVE_TYPE)).toBe(true);
    expect(pool.size).toBe(1);
  });

  it('test_perception_node_factory_produces_description：factory 产出可执行结点，输入截图引用 → 输出结构化描述', async () => {
    const registry = new NodeTypeRegistry();
    register_perception_nodes(registry);
    const node_fn = registry.create(VISION_PERCEIVE_TYPE, {});
    const out = await node_fn({ state: { image_url: 'file:///tmp/shot.png' } });
    expect(out).not.toBeNull();
    const record = out as Record<string, unknown>;
    expect(record['description']).toBeTruthy();
    expect('elements' in record).toBe(true);
    expect(record['confidence'] as number).toBeGreaterThan(0.0);
  });

  it('无截图引用时产出空结构化描述（引用缺失分支）', async () => {
    const registry = new NodeTypeRegistry();
    register_perception_nodes(registry);
    const node_fn = registry.create(VISION_PERCEIVE_TYPE, {});
    const out = (await node_fn({})) as Record<string, unknown>;
    expect(out['description']).toBe('');
    expect(out['confidence']).toBe(0.0);
    const via_path = (await node_fn({
      state: { image_path: '/tmp/shot.png' },
    })) as Record<string, unknown>;
    expect(via_path['description']).toContain('/tmp/shot.png');
  });
});

// ── 双通道交叉验证 ──

describe('双通道交叉验证', () => {
  it('test_cross_validate_consistent_proceeds：一致 = 直进', () => {
    const result = cross_validate_channels(
      _chan('window,button,text'),
      _chan('window,button,text'),
    );
    expect(result).toBeInstanceOf(CrossValidationResult);
    expect(result.consistent).toBe(true);
    expect(result.review_signal).toBe(false);
    expect(result.decision).toBe(VALIDATE_PROCEED);
  });

  it('test_cross_validate_inconsistent_triggers_review：不一致 = 复核信号 + 降级决策', () => {
    const result = cross_validate_channels(
      _chan('window,button,text'),
      _chan('window,link,image'),
    );
    expect(result.consistent).toBe(false);
    expect(result.review_signal).toBe(true);
    expect(result.decision).toBe(VALIDATE_REVIEW);
  });

  it('test_cross_validate_single_channel_missing_triggers_review：单通道缺失 = 复核', () => {
    const result = cross_validate_channels(_chan('window,button'), _chan(''));
    expect(result.consistent).toBe(false);
    expect(result.review_signal).toBe(true);
    expect(result.decision).toBe(VALIDATE_REVIEW);
  });

  it('两通道均无元素 = 按空一致处理直进（Python 空一致分支）', () => {
    const result = cross_validate_channels(_chan(''), _chan(''));
    expect(result.consistent).toBe(true);
    expect(result.review_signal).toBe(false);
    expect(result.decision).toBe(VALIDATE_PROCEED);
  });

  it('元素清单以序列形态传入同样归一比对（数组元素口径）', () => {
    const result = cross_validate_channels(
      { elements: ['window', 'button'], description: 'x' },
      { elements: ['window', 'button'], description: 'y' },
    );
    expect(result.consistent).toBe(true);
    expect(result.decision).toBe(VALIDATE_PROCEED);
  });

  it('threshold 决定一致判定边界：同对通道按阈值放行/触发复核', () => {
    const channels = () => [
      _chan('window,button,text'),
      _chan('window,link,image'),
    ] as const;
    const strict = cross_validate_channels(...channels(), { threshold: 0.5 });
    expect(strict.decision).toBe(VALIDATE_REVIEW);
    const lenient = cross_validate_channels(...channels(), { threshold: 0.2 });
    expect(lenient.consistent).toBe(true);
    expect(lenient.decision).toBe(VALIDATE_PROCEED);
  });
});

// ── 截图外发分级 ──

describe('截图外发分级', () => {
  it('test_classify_export_local_always_allowed：本地多模态直喂（不出网，无授权也放行）', () => {
    const decision = classify_vision_export(MODEL_LOCAL, { authorized: false });
    expect(decision).toBeInstanceOf(VisionExportDecision);
    expect(decision.decision).toBe(EXPORT_ALLOW);
  });

  it('test_classify_export_cloud_default_denied：云端默认禁外发（fail-closed）', () => {
    const decision = classify_vision_export(MODEL_CLOUD, { authorized: false });
    expect(decision.decision).toBe(EXPORT_DENY);
  });

  it('test_classify_export_cloud_allowed_when_authorized：云端显式授权后放开', () => {
    const decision = classify_vision_export(MODEL_CLOUD, { authorized: true });
    expect(decision.decision).toBe(EXPORT_ALLOW);
  });

  it('test_classify_export_unknown_kind_denied：未知模型类别一律 deny', () => {
    const decision = classify_vision_export('edge', { authorized: true });
    expect(decision.decision).toBe(EXPORT_DENY);
    expect(decision.reason).toContain('edge');
  });
});
