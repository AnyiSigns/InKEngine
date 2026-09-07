/**
 * host bridge H2 补桥命令面单测（records.ledger / sessions.messages /
 * rounds.todos / recovery.reset / audit.list / tools.full / capability
 * baseline+tier / mcp.market / knowledge / memory / growth / backup）。
 *
 * 纪律覆盖：方法表与 BRIDGE_METHODS 双向一致；入参校验（BridgeError
 * invalid_params）；危险操作确认标记 fail-closed；各方法数据源锚点
 * （引擎 runtime 装配产物 / data_dir 快照域）。
 * // gate: 超限(674 行) - 21 个补桥方法行为/校验/别名断言集中在一文件便于交叉核验
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MemoryEntry } from '@ink-ts/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { BridgeError } from '../../src/bridge/_types.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { gateGraphRecipe } from '../_graphs.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

interface Dirs {
  dir: string;
  events: string;
  seed?: string;
}

function dirs(): Dirs {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-h2-'));
  return { dir, events: path.join(dir, 'events') };
}

describe('H2 bridge 方法表（三向一致）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('BRIDGE_METHODS 含全部新方法且与装配表双向一致', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    expect(BRIDGE_METHODS.length).toBeGreaterThan(40);
    expect([...handle.bridge.keys()].sort()).toEqual([...BRIDGE_METHODS].sort());
    for (const method of [
      'records.ledger',
      'sessions.messages',
      'rounds.todos',
      'recovery.reset',
      'audit.list',
      'tools.full',
      'capability.baseline.get',
      'capability.baseline.set',
      'capability.tier.set',
      'backup.export',
      'backup.preview',
      'backup.restore',
      'mcp.market',
      'mcp.mount',
      'mcp.unmount',
      'knowledge.list',
      'knowledge.graph',
      'knowledge.export',
      'memory.list',
      'memory.invalidate',
      'growth.report',
    ]) {
      expect(handle.bridge.get(method)).toBeTypeOf('function');
    }
  });

  it('rounds.todos / sessions.messages / records.ledger 入参校验（缺 thread_id → invalid_params）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    await expect(handle.bridge.get('rounds.todos')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(handle.bridge.get('sessions.messages')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(handle.bridge.get('records.ledger')!({ limit: -1 }, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });
});

describe('sessions.messages（链记录消息投影）', () => {
  let handle: HostHandle;
  let dir: string;
  let server: FakeOpenAIServer;

  async function bootChat(content: string): Promise<void> {
    const made = dirs();
    dir = made.dir;
    server = new FakeOpenAIServer({ content });
    await server.start();
    handle = await createHost(
      {
        data_dir: made.dir,
        events_dir: made.events,
        model_config: {
          agent_config: {
            protocol: 'openai_compatible',
            base_url: server.baseUrl,
            api_key: 'sk-h2-messages',
            model_id: 'h2-chat',
          },
        },
      },
    );
  }

  afterEach(async () => {
    if (handle !== undefined && handle !== null) await handle.dispose();
    if (server !== undefined && server !== null) await server.close();
    if (dir !== undefined && dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('两轮组装回合消息链投影（user/assistant 成对、created_at 数值、文本正序）', async () => {
    await bootChat('宿主回复');
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    await send({ input: 'yo', thread_id: first.thread_id }, CTX);

    const view = (await handle.bridge.get('sessions.messages')!(
      { thread_id: first.thread_id },
      CTX,
    )) as { thread_id: string; messages: Array<{ id: string; kind: string; text?: string; role?: string; created_at: number }> };
    expect(view.thread_id).toBe(first.thread_id);
    expect(view.messages).toHaveLength(4);
    expect(view.messages[0]).toMatchObject({ role: 'user', text: 'hi' });
    expect(view.messages[1]).toMatchObject({ role: 'assistant', text: '宿主回复' });
    expect(view.messages[2]).toMatchObject({ role: 'user', text: 'yo' });
    expect(view.messages[3]).toMatchObject({ role: 'assistant', text: '宿主回复' });
    for (const message of view.messages) {
      expect(typeof message.created_at).toBe('number');
      expect(message.id).toBeTruthy();
    }
  });

  it('无记录线程 → 空数组；多轮回合续写消息链（每轮 user 追加 + assistant，不重复回放）', async () => {
    await bootChat('宿主回复');
    const empty = (await handle.bridge.get('sessions.messages')!({ thread_id: 't-none' }, CTX)) as {
      messages: unknown[];
    };
    expect(empty.messages).toEqual([]);

    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'a' }, CTX)) as { thread_id: string };
    await send({ input: 'b', thread_id: first.thread_id }, CTX);
    await send({ input: 'c', thread_id: first.thread_id }, CTX);
    const view = (await handle.bridge.get('sessions.messages')!(
      { thread_id: first.thread_id },
      CTX,
    )) as { messages: Array<{ role?: string; text?: string }> };
    // 每轮 user/assistant 成对追加（user b/c 作为新 user message 续链，无重复回放）
    expect(view.messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
    expect(view.messages.map((m) => m.text)).toEqual([
      'a', '宿主回复', 'b', '宿主回复', 'c', '宿主回复',
    ]);
  });
});

describe('records.ledger（回合账本事实窗口）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('echo 两轮 → 事实行窗口（intent/conclusion + node 行、ts 数值、时间倒序）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: '第一轮' }, CTX)) as { thread_id: string };
    await send({ input: '第二轮', thread_id: first.thread_id }, CTX);

    const ledger = (await handle.bridge.get('records.ledger')!(
      { thread_id: first.thread_id },
      CTX,
    )) as { entries: Array<{ kind: string; action: string; node_id: string | null; ts: number }> };
    expect(ledger.entries.length).toBeGreaterThan(0);
    const kinds = new Set(ledger.entries.map((entry) => entry.kind));
    expect(kinds.has('intent') || kinds.has('conclusion') || kinds.has('node')).toBe(true);
    for (const entry of ledger.entries) {
      expect(typeof entry.ts).toBe('number');
      expect(entry.action).toBeTypeOf('string');
    }
    // limit 窗口生效（截断到最近 1 条）
    const limited = (await handle.bridge.get('records.ledger')!(
      { thread_id: first.thread_id, limit: 1 },
      CTX,
    )) as { entries: unknown[] };
    expect(limited.entries.length).toBeLessThanOrEqual(1);
  });

  it('无账本线程 → 空窗口；limit 非法拒绝', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const ledger = (await handle.bridge.get('records.ledger')!({ thread_id: 't-none' }, CTX)) as {
      entries: unknown[];
    };
    expect(ledger.entries).toEqual([]);
    await expect(
      handle.bridge.get('records.ledger')!({ thread_id: 't', limit: 'x' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('rounds.todos（挂起审批卡待办 + 空态）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('gate 图经兼容静态引擎挂卡 → todos 含 approval 行；裁决后清空', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    // rounds 已走组装；gate 挂卡演示经引擎静态图兼容通道（配方注入后重建）
    const runtime = handle.runtime as unknown as {
      _recipe: { graph_recipe: unknown };
      rebuild_engine(): Promise<unknown>;
    };
    runtime._recipe.graph_recipe = gateGraphRecipe;
    await runtime.rebuild_engine();
    const engine = handle.runtime.engine!;
    const started = { thread_id: `gate-${Math.random().toString(36).slice(2, 10)}` };
    await engine.ainvoke({}, { thread_id: started.thread_id, round_id: `r-${started.thread_id}`, continue_chain: true });
    const cards = (await handle.bridge.get('approval.list')!(
      { thread_id: started.thread_id },
      CTX,
    )) as Array<{ key: string }>;

    const todos = (await handle.bridge.get('rounds.todos')!(
      { thread_id: started.thread_id },
      CTX,
    )) as { todo: Array<{ id: string; label: string; status: string; kind: string }> };
    expect(todos.todo.some((todo) => todo.kind === 'approval' && todo.id === cards[0]!.key)).toBe(
      true,
    );

    await handle.bridge.get('approval.resolve')!(
      { thread_id: started.thread_id, decision: 'accept' },
      CTX,
    );
    const after = (await handle.bridge.get('rounds.todos')!(
      { thread_id: started.thread_id },
      CTX,
    )) as { todo: unknown[] };
    expect(after.todo).toEqual([]);
  });

  it('无挂卡无计划线程 → 空 todo', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const todos = (await handle.bridge.get('rounds.todos')!({ thread_id: 't-idle' }, CTX)) as {
      todo: unknown[];
    };
    expect(todos.todo).toEqual([]);
  });
});

describe('recovery.reset（确认标记 fail-closed）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('缺/错 confirm → invalid_params（危险操作无标记即拒绝）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    await expect(handle.bridge.get('recovery.reset')!({ thread_id: 't' }, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(
      handle.bridge.get('recovery.reset')!({ thread_id: 't', confirm: 'reset' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('单线程重置：链删除 + 会话墓碑 + 事件日志清空；幂等二次调用零删除', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'a' }, CTX)) as { thread_id: string };
    const storage = handle.runtime.storage!;
    expect((await storage.events_after(first.thread_id, 0)).length).toBeGreaterThan(0);
    const reset = handle.bridge.get('recovery.reset')!;
    const outcome = (await reset(
      { thread_id: first.thread_id, confirm: 'factory-reset' },
      CTX,
    )) as { checkpoints_deleted: number; session_removed: boolean; mode: string; events_cleared: boolean; audit_kept: boolean };
    expect(outcome.mode).toBe('thread');
    expect(outcome.checkpoints_deleted).toBeGreaterThan(0);
    expect(outcome.session_removed).toBe(true);
    expect(outcome.events_cleared).toBe(true);
    expect(outcome.audit_kept).toBe(true);
    const chain = await handle.bridge.get('records.chain')!({ thread_id: first.thread_id }, CTX);
    expect((chain as { chain: unknown[] }).chain).toHaveLength(0);
    expect(await storage.events_after(first.thread_id, 0)).toHaveLength(0);
    const sessions = (await handle.bridge.get('records.sessions')!(null, CTX)) as unknown[];
    expect(sessions).toHaveLength(0);
    const second = (await reset(
      { thread_id: first.thread_id, confirm: 'factory-reset' },
      CTX,
    )) as { checkpoints_deleted: number };
    expect(second.checkpoints_deleted).toBe(0);
  });

  it('全量重置：清 host.sessions/ledger/memory 集合 + 全部线程链与事件日志（幂等）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'x' }, CTX)) as { thread_id: string };
    const storage = handle.runtime.storage!;
    expect((await storage.events_after(first.thread_id, 0)).length).toBeGreaterThan(0);
    const reset = handle.bridge.get('recovery.reset')!;
    const outcome = (await reset({ confirm: 'factory-reset' }, CTX)) as {
      mode: string;
      threads: number;
      events_cleared: boolean;
      audit_kept: boolean;
      cleared_collections: Array<{ collection: string; count: number }>;
    };
    expect(outcome.mode).toBe('factory');
    expect(outcome.threads).toBeGreaterThan(0);
    expect(outcome.events_cleared).toBe(true);
    expect(outcome.audit_kept).toBe(true);
    const names = outcome.cleared_collections.map((entry) => entry.collection);
    expect(names).toEqual(expect.arrayContaining(['host.sessions', 'ledger', 'memory']));
    const sessions = (await handle.bridge.get('records.sessions')!(null, CTX)) as unknown[];
    expect(sessions).toHaveLength(0);
    expect(await storage.events_after(first.thread_id, 0)).toHaveLength(0);
    const second = (await reset({ confirm: 'factory-reset' }, CTX)) as { threads: number };
    expect(second.threads).toBe(0);
  });
});

describe('audit.list（只读窗口：kind/after + limit + 倒序）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('kind 过滤 + after 时间窗 + limit 截断', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const storage = handle.runtime.storage!;
    const now = Date.now() / 1000;
    const putAudit = async (kind: string, ts: number): Promise<void> => {
      const scope = storage.allow_mechanism('set_audit');
      scope.enter();
      try {
        await storage.put_record('set_audit', `h2-${kind}-${ts}-${Math.random()}`, {
          kind,
          ts,
          note: kind,
        });
      } finally {
        scope.exit();
      }
    };
    await putAudit('h2_reset', now - 30);
    await putAudit('h2_reset', now - 10);
    await putAudit('h2_other', now - 20);

    const list = handle.bridge.get('audit.list')!;
    const all = (await list({ kind: 'h2_reset' }, CTX)) as { records: Array<{ kind: string }> };
    expect(all.records.length).toBe(2);
    expect(all.records.every((record) => record.kind === 'h2_reset')).toBe(true);

    const afterWindow = (await list({ kind: 'h2_reset', after: now - 20 }, CTX)) as {
      records: unknown[];
    };
    expect(afterWindow.records.length).toBe(1);

    const limited = (await list({ kind: 'h2_reset', limit: 1 }, CTX)) as { records: unknown[] };
    expect(limited.records.length).toBe(1);

    await expect(list({ limit: 0 }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(list({ after: 'bad' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('tools.full + capability.baseline/tier（工具管理面）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('tools.full 全量视图行含布尔旗标；uses_vectors 全局态一致', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const view = (await handle.bridge.get('tools.full')!(null, CTX)) as {
      uses_vectors: boolean;
      tools: Array<{
        name: string;
        uses_vectors: boolean;
        vector: boolean;
        baseline: boolean;
        approved: boolean;
        enabled: boolean;
      }>;
    };
    expect(view.tools.length).toBeGreaterThan(0);
    for (const tool of view.tools) {
      expect(typeof tool.uses_vectors === 'boolean').toBe(true);
      expect(typeof tool.vector).toBe('boolean');
      expect(typeof tool.baseline).toBe('boolean');
      expect(typeof tool.approved).toBe('boolean');
      expect(typeof tool.enabled).toBe('boolean');
      if (tool.baseline) expect(tool.enabled).toBe(true);
    }
    expect(view.uses_vectors).toBe(view.tools[0]!.uses_vectors);
  });

  it('capability.baseline.get/set（运行时单源 + 未知名拒绝）与 tier.set 登记回显', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const baselineGet = handle.bridge.get('capability.baseline.get')!;
    const baselineSet = handle.bridge.get('capability.baseline.set')!;
    const full = (await handle.bridge.get('tools.full')!(null, CTX)) as {
      tools: Array<{ name: string }>;
    };
    const first = full.tools[0]!.name;

    const initial = (await baselineGet(null, CTX)) as { tools: string[] };
    expect(Array.isArray(initial.tools)).toBe(true);

    const applied = (await baselineSet({ tools: [first] }, CTX)) as { tools: string[] };
    expect(applied.tools).toContain(first);
    const reread = (await baselineGet(null, CTX)) as { tools: string[] };
    expect(reread.tools).toContain(first);

    await expect(baselineSet({ tools: ['no_such_tool_zzz'] }, CTX)).rejects.toBeInstanceOf(
      BridgeError,
    );

    const tier = (await handle.bridge.get('capability.tier.set')!(
      { tier_overrides: { demo_tool: 'review' } },
      CTX,
    )) as { tier_overrides: Record<string, unknown> };
    expect(tier.tier_overrides).toEqual({ demo_tool: 'review' });
    await expect(
      handle.bridge.get('capability.tier.set')!({ tier_overrides: { x: 'nuke' } }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    const cap = (await handle.bridge.get('capability.get')!(null, CTX)) as Record<string, unknown>;
    expect((cap['tier_overrides'] as Record<string, unknown>)['demo_tool']).toBe('review');
  });
});

describe('mcp.market（seed 目录 + 挂载态）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('market 读取 seed_data/mcp_market.json → servers 附 mounted=false；未连 server 卸载拒绝', async () => {
    const base = dirs();
    const seed = mkdtempSync(path.join(tmpdir(), 'ink-h2-seed-'));
    writeFileSync(
      path.join(seed, 'mcp_market.json'),
      JSON.stringify({
        premounted: false,
        mount_policy: { required: [] },
        servers: [
          {
            id: 'market.demo',
            name: 'Demo',
            source: 'fixture',
            transport: 'http',
            url: 'https://example.com',
            command: null,
            args: [],
            risk: 'low',
          },
        ],
      }),
    );
    try {
      handle = await createHost(
        { data_dir: base.dir, events_dir: base.events, seed_dir: seed },
      );
      const market = (await handle.bridge.get('mcp.market')!(null, CTX)) as {
        servers: Array<{ id: string; mounted: boolean; name: string }>;
      };
      expect(market.servers).toHaveLength(1);
      expect(market.servers[0]).toMatchObject({ id: 'market.demo', mounted: false });

      await expect(
        handle.bridge.get('mcp.unmount')!({ name: 'market.demo' }, CTX),
      ).rejects.toMatchObject({ code: 'mcp_not_connected' });
      await expect(handle.bridge.get('mcp.unmount')!({}, CTX)).rejects.toMatchObject({
        code: 'invalid_params',
      });
      await expect(
        handle.bridge.get('mcp.mount')!({ config: { transport: 'nope' } }, CTX),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  });
});

describe('knowledge 读面（list/graph/export）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('list 条目视图 + graph 层级概览 + export JSON 串（kind 过滤/全量）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const list = (await handle.bridge.get('knowledge.list')!(null, CTX)) as {
      entries: Array<{ id: string; kind: string; title: string; archived: boolean }>;
    };
    expect(Array.isArray(list.entries)).toBe(true);

    const kindFiltered = (await handle.bridge.get('knowledge.list')!(
      { kind: 'insight' },
      CTX,
    )) as { entries: Array<{ kind: string }> };
    expect(kindFiltered.entries.every((entry) => entry.kind === 'insight')).toBe(true);

    const graph = (await handle.bridge.get('knowledge.graph')!(null, CTX)) as {
      total: number;
      levels: Array<{ level: string; count: number }>;
      nodes: unknown[];
      edges: unknown[];
    };
    expect(graph.total).toBeGreaterThanOrEqual(0);
    expect(graph.total).toBe(list.entries.length);
    expect(Array.isArray(graph.levels)).toBe(true);

    const exported = (await handle.bridge.get('knowledge.export')!(null, CTX)) as string;
    expect(typeof exported).toBe('string');
    const parsed = JSON.parse(exported) as { base?: unknown };
    expect('base' in parsed).toBe(true);

    const kindExport = (await handle.bridge.get('knowledge.export')!(
      { kind: 'weight' },
      CTX,
    )) as string;
    const parsedKind = JSON.parse(kindExport) as { kind: string; entries: unknown[] };
    expect(parsedKind.kind).toBe('weight');
    expect(Array.isArray(parsedKind.entries)).toBe(true);
  });
});

describe('memory 读面（list/invalidate）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('save 后 list 可见（namespace 分组），invalidate 批量失效后清空', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const store = handle.runtime.memory_store;
    if (store === null) throw new Error('测试前置失败：memory_store 未装配');
    const id = await store.save(
      new MemoryEntry({
        namespace: 'user:t-h2',
        kind: 'fact',
        title: '记忆条目',
        content: '第一份记忆内容',
        source: 'decision',
      }),
    );
    await store.save(
      new MemoryEntry({
        namespace: 'user:t-h2',
        kind: 'style',
        title: '第二份',
        content: '风格偏好内容',
      }),
    );

    const view = (await handle.bridge.get('memory.list')!(null, CTX)) as {
      namespaces: Array<{ name: string; count: number }>;
      entries: Array<{ id: string; namespace: string; kind: string; content: string }>;
    };
    expect(view.namespaces).toEqual([{ name: 'user:t-h2', count: 2 }]);
    expect(view.entries).toHaveLength(2);

    const query = (await handle.bridge.get('memory.list')!({ query: '第一份' }, CTX)) as {
      entries: Array<{ id: string }>;
    };
    expect(query.entries).toHaveLength(1);

    const invalidated = (await handle.bridge.get('memory.invalidate')!(
      { ids: [id, 'no-such-id'] },
      CTX,
    )) as { invalidated: number; not_found: string[] };
    expect(invalidated.invalidated).toBe(1);
    expect(invalidated.not_found).toEqual(['no-such-id']);

    const after = (await handle.bridge.get('memory.list')!(null, CTX)) as { entries: unknown[] };
    expect(after.entries).toHaveLength(1);
    await expect(
      handle.bridge.get('memory.invalidate')!({ ids: 'x' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('growth.report（自学习状态面）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('装配态：enabled/config_summary/weights_snapshot?/last_tuned_at? 形态', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const report = (await handle.bridge.get('growth.report')!(null, CTX)) as {
      enabled: boolean;
      config_summary: Record<string, unknown>;
      weights_snapshot?: Record<string, unknown> | null;
      last_tuned_at?: number | null;
    };
    expect(report.enabled).toBe(true);
    expect(report.config_summary['enabled']).toBe(true);
    expect(report.config_summary['reuse_first']).toBe(true);
    if (report.weights_snapshot !== undefined && report.weights_snapshot !== null) {
      expect(typeof report.weights_snapshot).toBe('object');
    }
  });
});

describe('backup 快照面（export/preview/restore + confirm 标记）', () => {
  let handle: HostHandle;
  let root: string;

  afterEach(async () => {
    await handle.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('export → 改文件 → restore 回滚（标记防误触；原目录快照保留）', async () => {
    const made = dirs();
    root = made.dir;
    mkdirSync(path.join(root, 'notes'), { recursive: true });
    const marker = path.join(root, 'notes', 'marker.txt');
    writeFileSync(marker, 'v1');
    // 备份恢复替换整目录会覆盖 sqlite 库文件；Windows 上打开中的 db 无法
    // rename → 本测试显式 memory://（缺省 sqlite 的恢复语义受平台锁限制，
    // 产品级恢复须先停 runtime 再 restore）
    handle = await createHost(
      { data_dir: root, events_dir: made.events, storage_uri: 'memory://' },
    );

    const backupExport = handle.bridge.get('backup.export')!;
    const exported = (await backupExport({}, CTX)) as { file: string; entries: number };
    expect(exported.entries).toBeGreaterThan(0);

    const preview = (await handle.bridge.get('backup.preview')!(
      { path: exported.file },
      CTX,
    )) as { entries_total: number; has_db: boolean };
    expect(preview.entries_total).toBe(exported.entries);
    expect(typeof preview.has_db).toBe('boolean');

    writeFileSync(marker, 'v2');
    await expect(
      handle.bridge.get('backup.restore')!({ path: exported.file }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });

    const restored = (await handle.bridge.get('backup.restore')!(
      { path: exported.file, confirm: 'backup-restore' },
      CTX,
    )) as { restored_entries: number; snapshot: string };
    expect(restored.restored_entries).toBeGreaterThan(0);
    expect(readFileSync(marker, 'utf8')).toBe('v1');
    // 原目录快照保留在 data_dir/snapshots（快照为同一 data_dir 打包产物）
    expect(restored.snapshot.startsWith(path.join(root, 'snapshots'))).toBe(true);
    expect(existsSync(restored.snapshot)).toBe(true);
  });
});

