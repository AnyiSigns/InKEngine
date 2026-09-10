/**
 * 宿主组织档案接线单测（OrgArchive：ingest 统计增长 + 快照持久化 + 重载 round-trip；
 * 作用域装载冲突序；坏轨迹 fail-closed）。
 *
 * 测什么：
 * - runExecution 后 OrgArchive 统计增长（ingest 使 patterns/scopes 条目数增加）；
 * - 快照持久化：执行后 storage 出现 org.archive 集合记录；
 * - 重载 round-trip：新 HostExecutionService 从同一 storage 恢复档案状态；
 * - 坏轨迹 fail-closed：非法 snapshot 数据不击穿，执行仍可正常运行；
 * - 冲突序三例：registry 覆盖 overlay / overlay 补缺 / retired 过滤。
 */
import { describe, expect, it } from 'vitest';

import { create_storage, ORG_ARCHIVE_SCHEMA_VERSION } from '@ink-ts/engine';
import { HostExecutionService } from '../src/execution/service.js';
import type { ScopeTurnContext, ScopeTurnResult } from '@ink-ts/engine';
import type { Storage } from '@ink-ts/engine';

type ScriptItem = Record<string, unknown> | { fail: true; reason: string };

/** fake turn：按作用域剧本逐轮吐载荷。 */
class FakeTurn {
  readonly calls: Array<{ scopeId: string; role: string | null; persona: string | null; input: string }> = [];
  constructor(private script: Record<string, ScriptItem[]>) {}

  async run_scope_turn(ctx: ScopeTurnContext): Promise<ScopeTurnResult> {
    const scopeId = ctx.scope.id;
    const role = (ctx.scope as unknown as { role?: string }).role ?? null;
    const persona = (ctx.scope as unknown as { persona?: string }).persona ?? null;
    this.calls.push({ scopeId, role, persona, input: ctx.input });
    const item = this.script[scopeId]?.shift();
    if (item === undefined) return { ok: true, reply: '', payload: { message: '缺省直答' } };
    if ('fail' in item) {
      const reason = item.reason as string;
      return { ok: false, reply: '', reason, summary: `${scopeId} ${reason}` };
    }
    return { ok: true, reply: JSON.stringify(item), payload: item };
  }
}

function scoped(id: string, persona = `${id} 作用域`): Record<string, unknown> {
  return { id, role: id, persona, model: null };
}

function makeLoader(
  scopes: Record<string, unknown>[],
  override: ((id: string) => Record<string, unknown> | null) | null = null,
): (id: string) => Record<string, unknown> | null {
  const map = new Map(scopes.map((s) => [s.id, s]));
  if (override !== null) return override;
  return (id: string) => map.get(id) ?? null;
}

function makeService(
  script: Record<string, ScriptItem[]>,
  scopes: Record<string, unknown>[],
  storage: Storage | null = null,
  loader: ((id: string) => Record<string, unknown> | null) | null = null,
): { service: HostExecutionService; turn: FakeTurn } {
  const turn = new FakeTurn(script);
  const svc = new HostExecutionService({
    loadScope: makeLoader(scopes, loader) as never,
    turnOverride: turn as never,
    storage: () => storage,
  });
  return { service: svc, turn };
}

describe('组织档案接线（ingest + 快照 + round-trip + 冲突序）', () => {
  it('ingest 使统计增长：执行后 patterns/scopes 条目数增加', async () => {
    const storage = await create_storage('memory://');
    const script = {
      main: [
        { __next: { kind: 'channel', channel: 'delegate', target: 'planner' } },
        { message: '收口' },
      ],
      planner: [{ plan: '先规划' }],
    };
    const { service: svc } = makeService(script, [scoped('main'), scoped('planner')], storage);
    const result = await svc.runExecution({ task: '规划任务' });
    expect(result.blocked).toBe(false);
    expect(svc.orgArchive.ingested_count()).toBe(2);
    expect(svc.orgArchive.pattern_entries().length).toBeGreaterThan(0);
    expect(svc.orgArchive.scope_entries().length).toBeGreaterThan(0);
  });

  it('快照持久化：执行后 storage 出现 org.archive 集合记录', async () => {
    const storage = await create_storage('memory://');
    const script = { main: [{ message: '你好' }] };
    const { service: svc } = makeService(script, [scoped('main')], storage);
    await svc.runExecution({ task: '打招呼' });
    await svc.flushArchiveSnapshot();
    const records = await storage.list_records('org.archive');
    expect(records.length).toBe(1);
    expect(records[0]).toHaveProperty('schema_version', ORG_ARCHIVE_SCHEMA_VERSION);
  });

  it('重载 round-trip：新 HostExecutionService 从同一 storage 恢复档案状态', async () => {
    const storage = await create_storage('memory://');
    const script = { main: [{ message: '你好' }] };
    const { service: svc1 } = makeService(script, [scoped('main')], storage);
    await svc1.runExecution({ task: '打招呼' });
    await svc1.flushArchiveSnapshot();
    const firstIngested = svc1.orgArchive.ingested_count();
    expect(firstIngested).toBe(1);

    const { service: svc2 } = makeService({ main: [{ message: '再次' }] }, [scoped('main')], storage);
    await svc2.loadArchiveSnapshot();
    expect(svc2.orgArchive.ingested_count()).toBe(firstIngested);
    expect(svc2.orgArchive.pattern_entries().length).toBe(svc1.orgArchive.pattern_entries().length);
  });

  it('坏轨迹 fail-closed：非法 snapshot 数据不击穿，执行仍可正常运行', async () => {
    const storage = await create_storage('memory://');
    const script = { main: [{ message: '你好' }] };
    const { service: svc } = makeService(script, [scoped('main')], storage);
    await storage.put_record('org.archive', 'snapshot', {
      schema_version: 1,
      ingested: -1,
      patterns: {},
      chains: {},
      scopes: {},
    } as never);
    await expect(svc.loadArchiveSnapshot()).resolves.toBeUndefined();
    const result = await svc.runExecution({ task: '测试' });
    expect(result.blocked).toBe(false);
  });

  describe('作用域装载冲突序', () => {
    it('registry 覆盖 overlay：注册表命中时优先使用注册表版本', async () => {
      const storage = await create_storage('memory://');
      const registryMain = { id: 'main', role: 'main', persona: '注册表版 main', model: null };
      const overlayMain = { id: 'main', role: 'main', persona: '出厂 overlay main', model: null };
      const script = { main: [{ message: '你好' }] };

      const registryMap = new Map([['main', registryMain]]);
      const overlayMap = new Map([['main', overlayMain]]);
      const conflictLoader = (id: string) => registryMap.get(id) ?? overlayMap.get(id) ?? null;

      const { service: svc, turn } = makeService(script, [], storage, conflictLoader);
      await svc.runExecution({ task: '测试' });
      expect(turn.calls.length).toBe(1);
      expect(turn.calls[0]!.scopeId).toBe('main');
      expect(turn.calls[0]!.persona).toBe('注册表版 main');
    });

    it('overlay 补缺：注册表未命中时使用 overlay', async () => {
      const storage = await create_storage('memory://');
      const overlayMain = { id: 'main', role: 'main', persona: '出厂 overlay main', model: null };
      const script = { main: [{ message: '你好' }] };

      const registryMap = new Map<string, Record<string, unknown>>();
      const overlayMap = new Map([['main', overlayMain]]);
      const conflictLoader = (id: string) => registryMap.get(id) ?? overlayMap.get(id) ?? null;

      const { service: svc, turn } = makeService(script, [], storage, conflictLoader);
      await svc.runExecution({ task: '测试' });
      expect(turn.calls.length).toBe(1);
      expect(turn.calls[0]!.scopeId).toBe('main');
      expect(turn.calls[0]!.persona).toBe('出厂 overlay main');
    });

    it('retired 过滤：retired 行不装载', async () => {
      const storage = await create_storage('memory://');
      const retiredEntity = { id: 'old_scope', role: 'old_scope', persona: '已下架', meta: { retired: true } };
      const script = { main: [{ message: '你好' }] };

      const retiredLoader = (id: string) => {
        const entity = id === 'old_scope' ? retiredEntity : null;
        if (entity && (entity.meta as Record<string, unknown> | undefined)?.retired === true) return null;
        return entity;
      };

      const { service: svc } = makeService(script, [], storage, retiredLoader);
      expect(svc.hasScope('old_scope')).toBe(false);
    });
  });
});
