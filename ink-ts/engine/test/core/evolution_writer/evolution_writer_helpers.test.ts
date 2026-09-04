/**
 * EvolutionWriter 专用 writer 透传与常量语义（Python evolution_writer.py
 * 无专属 pytest）：harness/event_type/entity/memory/edge_tier/runtime_config
 * 六个 writer 透传正确的 kind/asset_id/collection/key 到 write 通道；
 * EVOLUTION_AUDIT_TYPE / _EVOLUTION_CHAIN_COLLECTION / _KIND_PATH 常量契约。
 */

import { describe, expect, it } from 'vitest';

import { AUDIT_COLLECTION } from '../../../src/core/audit_log/audit_log.js';
import {
  DefaultEvolutionWriter,
  EVOLUTION_AUDIT_TYPE,
  _EVOLUTION_CHAIN_COLLECTION,
  _EVOLUTION_CHAIN_KEY,
  _KIND_PATH,
  edge_tier_writer,
  entity_writer,
  event_type_writer,
  harness_writer,
  memory_writer,
  runtime_config_writer,
} from '../../../src/core/evolution_writer/evolution_writer.js';
import type { EvolutionRecord, EvolutionWriter } from '../../../src/core/evolution_writer/_types.js';
import { getChain, MemStore } from './evolution_writer.test.js';

describe('专用 writer 透传 kind/asset_id/collection/key', () => {
  it('harness_writer: kind=harness, asset_id, collection/key 透传', async () => {
    const store = new MemStore();
    const writer: EvolutionWriter = new DefaultEvolutionWriter(store);
    const data: EvolutionRecord = { steps: ['s1'] };
    await harness_writer(writer, 'harness:chains', 'chain:default', data, {
      asset_id: 'default',
      note: 'init',
    });
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data).toMatchObject({
      type: EVOLUTION_AUDIT_TYPE,
      evolution_kind: 'harness',
      asset_id: 'default',
      collection: 'harness:chains',
      key: 'chain:default',
      note: 'init',
    });
    expect(getChain(store).assemble()).toEqual({ harness: { default: data } });
  });

  it('event_type_writer: kind=event_type, asset_id=name', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await event_type_writer(writer, 'event_types', 'select', { tag: 't' }, { note: null });
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data).toMatchObject({
      evolution_kind: 'event_type',
      asset_id: 'select',
      collection: 'event_types',
      key: 'select',
      note: '',
    });
    expect(getChain(store).assemble()).toEqual({ event_types: { select: { tag: 't' } } });
  });

  it('entity_writer: kind=entity, asset_id=entity_id', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await entity_writer(writer, 'entities', 'ent-1', { x: 1 }, {});
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data).toMatchObject({
      evolution_kind: 'entity',
      asset_id: 'ent-1',
      collection: 'entities',
      key: 'ent-1',
    });
    expect(getChain(store).assemble()).toEqual({ entities: { 'ent-1': { x: 1 } } });
  });

  it('memory_writer: kind=memory, asset_id=entry_id', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await memory_writer(writer, 'memory', 'm1', { ts: 1, body: 'b' }, { note: 'upd' });
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data).toMatchObject({
      evolution_kind: 'memory',
      asset_id: 'm1',
      collection: 'memory',
      key: 'm1',
      note: 'upd',
    });
    expect(getChain(store).assemble()).toEqual({ memory: { m1: { ts: 1, body: 'b' } } });
  });

  it('edge_tier_writer: kind=edge_tier, asset_id=key_str', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await edge_tier_writer(writer, 'edge_tier_overrides', 'e1', { tier: 1 }, { note: 'degrade' });
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data).toMatchObject({
      evolution_kind: 'edge_tier',
      asset_id: 'e1',
      collection: 'edge_tier_overrides',
      key: 'e1',
    });
    expect(getChain(store).assemble()).toEqual({ edge_tier_overrides: { e1: { tier: 1 } } });
  });

  it('runtime_config_writer: kind=runtime_config, asset_id 显式', async () => {
    const store = new MemStore();
    const writer = new DefaultEvolutionWriter(store);
    await runtime_config_writer(
      writer,
      'runtime_config',
      'budget',
      { cap: 100 },
      { asset_id: 'budget.cap', note: null },
    );
    const audit = store.puts.find((p) => p.collection === AUDIT_COLLECTION);
    expect(audit?.data).toMatchObject({
      evolution_kind: 'runtime_config',
      asset_id: 'budget.cap',
      collection: 'runtime_config',
      key: 'budget',
      note: '',
    });
    expect(getChain(store).assemble()).toEqual({
      runtime_config: { 'budget.cap': { cap: 100 } },
    });
  });
});

describe('常量与 seam 形态', () => {
  it('EVOLUTION_AUDIT_TYPE = "evolution_write"', () => {
    expect(EVOLUTION_AUDIT_TYPE).toBe('evolution_write');
  });

  it('_EVOLUTION_CHAIN_COLLECTION = "evolution_patch_chain"；与集补丁链 set_patch_chain 隔离', () => {
    expect(_EVOLUTION_CHAIN_COLLECTION).toBe('evolution_patch_chain');
    expect(_EVOLUTION_CHAIN_KEY).toBe('chain');
  });

  it('_KIND_PATH 六类 kind → 路径段映射', () => {
    expect(_KIND_PATH).toEqual({
      harness: 'harness',
      event_type: 'event_types',
      entity: 'entities',
      memory: 'memory',
      edge_tier: 'edge_tier_overrides',
      runtime_config: 'runtime_config',
    });
  });
});
