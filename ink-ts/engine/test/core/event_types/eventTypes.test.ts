import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_EVENT_TYPES,
  EVENT_STATUS_REGISTERED,
  EVENT_STATUS_UNKNOWN,
  EventTypeSpec,
} from '../../../src/core/event_types/eventTypeSpec.js';
import {
  EVENT_AUDIT_ASSEMBLY,
  EVENT_AUDIT_FINGERPRINT_REPLACE,
  EVENT_AUDIT_JUNCTION,
  EVENT_AUDIT_POLICY_REVIEW,
  EVENT_AUDIT_PROMOTION,
  audit_event_specs,
  register_audit_event_types,
} from '../../../src/core/event_types/eventTypeSpecs.js';
import {
  EventTypeRegistry,
  type EventTypeRecordsStore,
  type EventTypeSpecWriter,
} from '../../../src/core/event_types/registry.js';
import { SchemaField, SchemaSpec } from '../../../src/core/schema/schemaValidator.js';

function spec(name = 'thinking_start', renderer = 'ThinkingRow', system = false): EventTypeSpec {
  return new EventTypeSpec({
    name,
    schema: new SchemaSpec({ name: `${name}.payload`, fields: [] }),
    renderer,
    system,
    meta: { source: 'boot', description: '思考开始' },
  });
}

function memoryStore(): EventTypeRecordsStore &
  EventTypeSpecWriter & { put_record(c: string, k: string, d: Record<string, unknown>): Promise<void> } {
  const byCol = new Map<string, Map<string, Record<string, unknown>>>();
  return {
    async put_record(c, k, d) {
      if (!byCol.has(c)) byCol.set(c, new Map());
      byCol.get(c)!.set(k, d);
    },
    async list_records(c) {
      return [...(byCol.get(c)?.values() ?? [])];
    },
    async write(c, k, d) {
      await this.put_record(c, k, d);
    },
  };
}

describe('EventTypeSpec 序列化', () => {
  it('round-trip 保持全字段', () => {
    const s = spec('thinking_start', 'ThinkingRow', true);
    const restored = EventTypeSpec.from_dict(s.to_dict());
    expect(restored.to_dict()).toEqual(s.to_dict());
    expect(restored.schema?.name).toBe('thinking_start.payload');
    expect(restored.system).toBe(true);
    expect(restored.meta['source']).toBe('boot');
  });

  it('极简声明（无 schema/renderer）往返保持', () => {
    const s = new EventTypeSpec({ name: 'ping', system: true });
    const restored = EventTypeSpec.from_dict(s.to_dict());
    expect(restored.to_dict()).toEqual(s.to_dict());
    expect(restored.schema).toBeNull();
    expect(restored.renderer).toBe('');
  });

  it('非法声明拒绝', () => {
    expect(() => EventTypeSpec.from_dict({ renderer: 'X' })).toThrow(/缺 name/);
    expect(() =>
      EventTypeSpec.from_dict({ name: 'x', schema: { name: 'x.payload', fields: 'not-a-list' } }),
    ).toThrow(/schema 声明缺 fields 清单/);
    expect(() => EventTypeSpec.from_dict({ name: 'x', renderer: 7 })).toThrow(/renderer 须为字符串/);
    expect(() => EventTypeSpec.from_dict({ name: 'x', meta: 'oops' })).toThrow(/meta 须为 dict/);
  });
});

describe('EventTypeRegistry 注册门禁', () => {
  it('register/get/names 按注册序稳定', () => {
    const registry = new EventTypeRegistry();
    registry.register(spec('a'));
    registry.register(spec('b'));
    expect(registry.names()).toEqual(['a', 'b']);
    expect(registry.get('a')?.to_dict()).toEqual(spec('a').to_dict());
    expect(registry.get('missing')).toBeNull();
  });

  it('重复注册显式拒绝', () => {
    const registry = new EventTypeRegistry();
    registry.register(spec('a'));
    expect(() => registry.register(spec('a'))).toThrow(/重复注册/);
  });

  it('配额超限拒绝（max_types 参数化）', () => {
    const registry = new EventTypeRegistry({ max_types: 2 });
    registry.register(spec('a'));
    registry.register(spec('b'));
    expect(() => registry.register(spec('c'))).toThrow(/配额上限/);
    expect(DEFAULT_MAX_EVENT_TYPES).toBeGreaterThanOrEqual(1);
  });

  it('unregister 未注册显式拒绝', () => {
    const registry = new EventTypeRegistry();
    expect(() => registry.unregister('missing')).toThrow(/未注册/);
    registry.register(spec('a'));
    registry.unregister('a');
    expect(registry.names()).toEqual([]);
  });
});

describe('classify 发射判定', () => {
  it('未注册类型宽松允许 + 折叠', () => {
    const verdict = new EventTypeRegistry().classify('unregistered_type', { anything: 1 });
    expect(verdict.status).toBe(EVENT_STATUS_UNKNOWN);
    expect(verdict.violations).toEqual([]);
    expect(verdict.fold).toBe(true);
  });

  it('已注册 schema 通过不折叠', () => {
    const registry = new EventTypeRegistry();
    registry.register(spec());
    const verdict = registry.classify('thinking_start', { content: '...' });
    expect(verdict.status).toBe(EVENT_STATUS_REGISTERED);
    expect(verdict.violations).toEqual([]);
    expect(verdict.fold).toBe(false);
  });

  it('已注册 schema 违规宽松标记', () => {
    const registry = new EventTypeRegistry();
    registry.register(
      new EventTypeSpec({
        name: 'weighed',
        schema: new SchemaSpec({
          name: 'weighed.payload',
          fields: [new SchemaField({ name: 'content', required: true, kind: 'string' })],
        }),
        renderer: 'WeightRow',
      }),
    );
    const verdict = registry.classify('weighed', {});
    expect(verdict.status).toBe(EVENT_STATUS_REGISTERED);
    expect(verdict.fold).toBe(false);
    expect(verdict.violations.some((v) => v.includes('content') && v.includes('缺失'))).toBe(true);
  });

  it('renderer 缺失 = 折叠展示', () => {
    const registry = new EventTypeRegistry();
    registry.register(new EventTypeSpec({ name: 'raw_event' }));
    const verdict = registry.classify('raw_event', {});
    expect(verdict.status).toBe(EVENT_STATUS_REGISTERED);
    expect(verdict.fold).toBe(true);
  });

  it('合成 system_events', () => {
    const registry = new EventTypeRegistry();
    registry.register(spec('a', 'R', true));
    registry.register(spec('b', 'R', false));
    registry.register(spec('c', 'R', true));
    expect(new Set(registry.system_events())).toEqual(new Set(['a', 'c']));
  });
});

describe('随集持久化（seam）', () => {
  it('round-trip：save → load 恢复注册表', async () => {
    const store = memoryStore();
    const registry = new EventTypeRegistry({ recordsStore: store, writer: store, set_id: 'u1' });
    registry.register(spec('a', 'RA', true));
    registry.register(new EventTypeSpec({ name: 'b' }));
    await registry.save();

    const restored = new EventTypeRegistry({ recordsStore: store, set_id: 'u1' });
    expect(await restored.load()).toBe(2);
    expect(restored.names()).toEqual(['a', 'b']);
    expect(restored.get('a')?.system).toBe(true);
    expect(new Set(restored.system_events())).toEqual(new Set(['a']));
    const verdict = restored.classify('a', {});
    expect(verdict.status).toBe(EVENT_STATUS_REGISTERED);
  });

  it('load 跳过脏记录不阻断', async () => {
    const store = memoryStore();
    await store.put_record('event_types', 'good', spec('good').to_dict());
    await store.put_record('event_types', 'bad', { name: 42 });
    const registry = new EventTypeRegistry({ recordsStore: store });
    expect(await registry.load()).toBe(1);
    expect(registry.names()).toEqual(['good']);
  });

  it('无存储 load/save 静默跳过', async () => {
    const registry = new EventTypeRegistry();
    registry.register(spec('a'));
    expect(await registry.load()).toBe(0);
    await registry.save();
    expect(registry.names()).toEqual(['a']);
  });
});

describe('审计事件类型注册', () => {
  it('audit_event_specs 全审计用途且可往返', () => {
    const specs = audit_event_specs();
    const names = new Set(specs.map((s) => s.name));
    expect(names).toEqual(
      new Set([
        EVENT_AUDIT_ASSEMBLY,
        EVENT_AUDIT_JUNCTION,
        EVENT_AUDIT_FINGERPRINT_REPLACE,
        EVENT_AUDIT_POLICY_REVIEW,
        EVENT_AUDIT_PROMOTION,
      ]),
    );
    for (const s of specs) {
      expect(s.meta['purpose']).toBe('audit');
      expect(EventTypeSpec.from_dict(s.to_dict()).to_dict()).toEqual(s.to_dict());
    }
  });

  it('register_audit_event_types 注册 5 类，重复注册拒绝', () => {
    const registry = new EventTypeRegistry();
    register_audit_event_types(registry);
    expect(registry.names().length).toBe(5);
    expect(registry.get(EVENT_AUDIT_ASSEMBLY)).not.toBeNull();
    expect(() => register_audit_event_types(registry)).toThrow(/重复注册/);
  });

  it('审计负载按 schema 校验（宽松标记）', () => {
    const registry = new EventTypeRegistry();
    for (const s of audit_event_specs()) registry.register(s);
    const verdict = registry.classify(EVENT_AUDIT_ASSEMBLY, { domain: 'code' });
    expect(verdict.status).toBe(EVENT_STATUS_REGISTERED);
    expect(verdict.violations).toEqual([]);
    const fp = registry.classify(EVENT_AUDIT_FINGERPRINT_REPLACE, { domain: 'code' });
    expect(fp.status).toBe(EVENT_STATUS_REGISTERED);
    expect(fp.violations).toEqual([]);
  });
});
