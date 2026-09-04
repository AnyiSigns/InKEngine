/**
 * LLM 缓存生命周期单测（对标 Python test_llm_cache.py TTL/版本/统计段）：
 * TTL 过期（注入假时钟推进）、ttl=0 恒过期、负 TTL 拒绝、patch_version 提供
 * 者（同步/异步）版本变化 = 失效、invalidate() 本地代际失效、stats 命中率
 * 口径、clear 清库归零。
 */

import { describe, expect, it } from 'vitest';

import { CachingLLM } from '../../../src/core/llm/cache.js';
import { CACHE_COLLECTION } from '../../../src/core/llm/cache.js';
import { user } from '../../../src/core/llm/messages.js';

import { CountingLLM, MemStorage, makeCached, makeClock } from './helpers.js';

describe('TTL 过期', () => {
  it('注入时钟推进越过 TTL → 判 miss', async () => {
    const storage = new MemStorage();
    const clock = makeClock();
    const { cached, inner } = makeCached(storage, { ttl: 60.0, clock: clock.now });
    await cached.ainvoke([user('q')]);
    clock.set(clock.now() + 61); // 越过 TTL
    await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(2);
  });

  it('ttl=0 恒过期（时钟推进一位即过期）', async () => {
    const storage = new MemStorage();
    const clock = makeClock();
    const { cached, inner } = makeCached(storage, { ttl: 0, clock: clock.now });
    await cached.ainvoke([user('q')]);
    clock.set(clock.now() + 1);
    await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(2);
  });

  it('负 TTL 拒绝', () => {
    expect(() => new CachingLLM(new CountingLLM(), { ttl: -1 })).toThrow(/TTL 不能为负/);
  });
});

describe('patch_version 版本失效', () => {
  it('提供者版本变化 = 失效（记录版本随落库）', async () => {
    const storage = new MemStorage();
    let version = 1;
    const { cached, inner } = makeCached(storage, { patch_version: () => version });
    await cached.ainvoke([user('q')]);
    let records = await storage.list_records(CACHE_COLLECTION);
    expect(records[0]!['patch_version']).toBe('1');
    version = 2; // 链演化 → 版本变化
    await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(2);
    records = await storage.list_records(CACHE_COLLECTION);
    for (const record of records) {
      expect(record['patch_version']).toBe('2');
    }
  });

  it('异步版本提供者受支持', async () => {
    const storage = new MemStorage();
    let version = 1;
    const provider = async (): Promise<number> => version;
    const { cached, inner } = makeCached(storage, { patch_version: provider });
    await cached.ainvoke([user('q')]);
    await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(1);
  });

  it('invalidate() 本地代际 +1：既有记录视为 miss', async () => {
    const storage = new MemStorage();
    const { cached, inner } = makeCached(storage);
    await cached.ainvoke([user('q')]);
    cached.invalidate();
    await cached.ainvoke([user('q')]);
    expect(inner.ainvoke_calls).toBe(2);
  });
});

describe('stats 统计', () => {
  it('1 miss + 1 hit：条目/计数/命中率对齐', async () => {
    const storage = new MemStorage();
    const { cached, inner } = makeCached(storage);
    const messages = [user('q')];
    await cached.ainvoke(messages); // 1 miss（落库）
    await cached.ainvoke(messages); // 1 hit
    expect(inner.ainvoke_calls).toBe(1);
    const stats = await cached.stats();
    expect(stats.entries).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hit_rate).toBe(0.5);
  });

  it('无调用：命中率 0.0', async () => {
    const { cached } = makeCached(new MemStorage());
    const stats = await cached.stats();
    expect(stats.entries).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.hit_rate).toBe(0.0);
  });

  it('无存储：条目量 0，直通调用也算 miss', async () => {
    const { cached } = makeCached(null);
    await cached.ainvoke([user('q')]);
    await cached.ainvoke([user('q')]);
    const stats = await cached.stats();
    expect(stats.entries).toBe(0);
    expect(stats.misses).toBe(2);
  });
});

describe('clear 清空', () => {
  it('删记录并归零计数；清后重新落库', async () => {
    const storage = new MemStorage();
    const { cached, inner } = makeCached(storage);
    await cached.ainvoke([user('q')]);
    await cached.ainvoke([user('q')]);
    const cleared = await cached.clear();
    expect(cleared).toBe(1);
    const stats = await cached.stats();
    expect(stats.entries).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    // 记录已删：下一轮 ainvoke 重新 miss → 内层累计 2 次
    await cached.ainvoke([user('q')]);
    expect((await storage.list_records(CACHE_COLLECTION)).length).toBe(1);
    expect(inner.ainvoke_calls).toBe(2);
  });

  it('无存储：仅计数归零、返回 0', async () => {
    const { cached } = makeCached(null);
    await cached.ainvoke([user('q')]);
    expect(await cached.clear()).toBe(0);
    const stats = await cached.stats();
    expect(stats.misses).toBe(0);
  });
});
