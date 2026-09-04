import { describe, expect, it } from 'vitest';

import {
  BOOT_KEY_MULTIPATH_ENABLED,
  CONTRACT_VERSION_MIN,
  SAFETY_TIER_MAX,
  SAFETY_TIER_MIN,
  NodeContract,
  PathAssemblyConfig,
  PathAssemblyFlags,
  type QualityGate,
} from '../../../src/core/contracts/contracts.js';
import { FIELD_NUMBER, FIELD_STRING, SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';
import type { FieldKind } from '../../../src/core/schema/schemaValidator.js';

function field(name: string, required = false, kind: FieldKind = FIELD_STRING): SchemaField {
  return new SchemaField({ name, required, kind });
}

function spec(name: string, ...fields: SchemaField[]): SchemaSpec {
  return new SchemaSpec({ name, fields });
}

describe('NodeContract 契约形态', () => {
  it('缺省契约 = 无输入输出声明 + 最严安全档 + 首版', () => {
    const contract = new NodeContract();
    expect(contract.input_schema).toBeNull();
    expect(contract.output_schema).toBeNull();
    expect(contract.safety_tier).toBe(SAFETY_TIER_MIN);
    expect(contract.version).toBe(CONTRACT_VERSION_MIN);
  });

  it('序列化 → 反序列化：schema 声明/安全档/版本完整还原', () => {
    const contract = new NodeContract({
      input_schema: spec('in', field('x', true), field('y', false, FIELD_NUMBER)),
      output_schema: spec('out', field('z')),
      safety_tier: 2,
      version: 3,
    });
    const rebuilt = NodeContract.from_dict(contract.to_dict());
    expect(rebuilt.to_dict()).toEqual(contract.to_dict());
    expect(rebuilt.input_schema?.to_dict()).toEqual(contract.input_schema?.to_dict());
    expect(rebuilt.output_schema?.to_dict()).toEqual(contract.output_schema?.to_dict());
  });

  it('序列化形态稳定：四个键全量显式（数据自描述，无隐式缺省）', () => {
    const data = new NodeContract().to_dict();
    expect(Object.keys(data).sort()).toEqual(['input_schema', 'output_schema', 'safety_tier', 'version']);
    expect(data['input_schema']).toBeNull();
    expect(data['output_schema']).toBeNull();
  });

  it('缺省键反序列化 = 默认值（旧数据兼容）', () => {
    expect(NodeContract.from_dict({}).to_dict()).toEqual(new NodeContract().to_dict());
    expect(NodeContract.from_dict({ safety_tier: 1 }).safety_tier).toBe(1);
  });

  it('安全档越界拒绝（档位是声明约束：仅 0/1/2 三档）', () => {
    expect(() => new NodeContract({ safety_tier: -1 })).toThrow(/安全档/);
    expect(() => new NodeContract({ safety_tier: 3 })).toThrow(/安全档/);
    expect(new NodeContract({ safety_tier: SAFETY_TIER_MAX }).safety_tier).toBe(2);
  });

  it('契约版本须 ≥ 1（行为变更 = 升版，无零版本）', () => {
    expect(() => new NodeContract({ version: 0 })).toThrow(/版本/);
  });

  it('反序列化非法声明拒绝（防脏数据静默落库）', () => {
    expect(() => NodeContract.from_dict('nope')).toThrow(/契约声明非法/);
    expect(() => NodeContract.from_dict({ safety_tier: 'x' })).toThrow(/安全档\/版本须为整数/);
    expect(() => NodeContract.from_dict({ safety_tier: true })).toThrow(/不接受布尔值/);
    expect(() => NodeContract.from_dict({ input_schema: 3 })).toThrow(/input_schema 声明非法/);
    expect(() => NodeContract.from_dict({ version: 0 })).toThrow(/版本/);
  });

  it('schema 字段只接受 SchemaSpec（数据形态约束）', () => {
    expect(() =>
      new NodeContract({ input_schema: { name: 'x', fields: [] } as unknown as SchemaSpec }),
    ).toThrow(/SchemaSpec/);
  });
});

describe('PathAssemblyConfig 装配配置开关', () => {
  it('机制装配配置开关默认全关（增量接入），序列化往返一致', () => {
    const config = new PathAssemblyConfig();
    expect(config.enabled).toBe(false);
    expect(PathAssemblyConfig.from_dict(config.to_dict()).to_dict()).toEqual(config.to_dict());
    expect(PathAssemblyConfig.from_dict({ enabled: true }).enabled).toBe(true);
  });

  it('非 dict 声明拒绝', () => {
    expect(() => PathAssemblyConfig.from_dict('nope')).toThrow(/装配配置声明非法/);
  });
});

describe('PathAssemblyFlags 装配开关组', () => {
  it('from_boot 缺省全关；未知键忽略；按名单开', () => {
    const none = PathAssemblyFlags.from_boot(null);
    expect(none.multipath_enabled).toBe(false);
    expect(Object.values(none.to_dict()).every((v) => v === false)).toBe(true);
    const opened = PathAssemblyFlags.from_boot({
      [BOOT_KEY_MULTIPATH_ENABLED]: true,
      unknown_key: true,
    });
    expect(opened.multipath_enabled).toBe(true);
    expect(opened.assembler_enabled).toBe(false);
  });

  it('to_boot_dict 长键形态与 from_boot 读取同口径（单块翻转落库闭环）', () => {
    const flags = new PathAssemblyFlags({ multipath_enabled: true });
    const rebuilt = PathAssemblyFlags.from_boot(flags.to_boot_dict());
    expect(rebuilt.multipath_enabled).toBe(true);
    expect(rebuilt.contract_enabled).toBe(false);
    expect(Object.values(rebuilt.to_dict()).filter((v) => v === true)).toEqual([true]);
  });

  it('to_dict 短键与 to_boot_dict 长键键集稳定', () => {
    const flags = new PathAssemblyFlags();
    expect(Object.keys(flags.to_dict()).sort()).toEqual([
      'assembler_enabled',
      'contract_enabled',
      'edge_evidence_enabled',
      'fingerprint_cache_enabled',
      'multipath_enabled',
      'pool_governance_enabled',
      'settle_hooks_enabled',
    ]);
    expect(Object.keys(flags.to_boot_dict())).toContain(BOOT_KEY_MULTIPATH_ENABLED);
  });

  it('组装器块开关形态随 assembler_enabled 透传', () => {
    expect(new PathAssemblyFlags({ assembler_enabled: true }).as_path_assembly_config().enabled).toBe(true);
    expect(new PathAssemblyFlags().as_path_assembly_config().enabled).toBe(false);
  });
});

describe('QualityGate 闸门窄协议', () => {
  it('只定义按域判定接口，实现归使用方（同步/异步均可）', async () => {
    const gate: QualityGate = { judge: (_domain, _artifact) => true };
    const asyncGate: QualityGate = { judge: async () => false };
    expect(gate.judge('domain', {})).toBe(true);
    expect(await asyncGate.judge('domain', {})).toBe(false);
  });
});
