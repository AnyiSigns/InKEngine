/**
 * host bridge H2 补桥命令面单测（sessions.messages / rounds.todos / recovery.reset / audit.list / tools.full / capability
 * baseline+tier / mcp.status / knowledge / memory / growth / backup）。
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
import { packStoreZip } from '../../src/backup/zip_codec.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { runGateCard } from '../_graphs.js';
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
      'mcp.status',
      'mcp.enable',
      'mcp.disable',
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

  it('rounds.todos / sessions.messages 入参校验（缺 thread_id → invalid_params）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    await expect(handle.bridge.get('rounds.todos')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(handle.bridge.get('sessions.messages')!({}, CTX)).rejects.toMatchObject({
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

  it('展示态正文行 round 归属透传（assistant 行 round_id = 该轮 round_id；auto 轮徽标刷新重建数据源）', async () => {
    await bootChat('宿主回复');
    const send = handle.bridge.get('rounds.send')!;
    const result = (await send({ input: 'hi' }, CTX)) as { thread_id: string; round_id: string };
    const view = (await handle.bridge.get('sessions.messages')!(
      { thread_id: result.thread_id },
      CTX,
    )) as { messages: Array<{ role?: string; text?: string; round_id?: string }> };
    const assistant = view.messages.find((m) => m.role === 'assistant');
    expect(assistant?.round_id).toBe(result.round_id);
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

describe('rounds.todos（挂起审批卡待办 + 空态）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('gate 数据图经 runtime 本轮引擎挂卡 → todos 含 approval 行；裁决后清空', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const started = { thread_id: `gate-${Math.random().toString(36).slice(2, 10)}` };
    await runGateCard(handle.runtime, started.thread_id);
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

describe('mcp.status/enable/disable（B5 工具型插件启停）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('status 读 plugins 源候选 → 出厂零启用；未知候选启用/停用显式拒绝', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const status = (await handle.bridge.get('mcp.status')!(null, CTX)) as {
      source: string;
      servers: Array<{ id: string; enabled: boolean; connected: boolean }>;
    };
    expect(Array.isArray(status.servers)).toBe(true);
    expect(status.servers.every((row) => row.enabled === false && row.connected === false)).toBe(true);

    await expect(
      handle.bridge.get('mcp.enable')!({}, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      handle.bridge.get('mcp.enable')!({ id: 'no_such_server' }, CTX),
    ).rejects.toMatchObject({ code: 'mcp_enable_failed' });
    await expect(
      handle.bridge.get('mcp.disable')!({ id: 'no_such_server' }, CTX),
    ).rejects.toMatchObject({ code: 'mcp_disable_failed' });
  });
});

describe('recovery.settings_reset（B6 恢复设置默认逃生）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('缺 confirm 拒绝；带 settings-default 标记执行成功（capability 回缺省/常驻集复位）', async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
    const settingsReset = handle.bridge.get('recovery.settings_reset')!;

    await expect(settingsReset({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      settingsReset({ confirm: 'factory-reset' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });

    const out = (await settingsReset({ confirm: 'settings-default' }, CTX)) as {
      mode: string;
      reset: boolean;
      baseline_reset: string[];
      ui_disabled: string[];
      mcp_disabled: string[];
    };
    expect(out).toMatchObject({ mode: 'settings', reset: true });
    expect(out.baseline_reset).toContain('search_tools');
    expect(out.ui_disabled).toEqual([]);
    expect(out.mcp_disabled).toEqual([]);
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

describe('backup 快照面（export/preview/restore + confirm 标记；sqlite 后端）', () => {
  let handle: HostHandle;
  let root: string;
  let marker: string;

  afterEach(async () => {
    await handle.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  async function bootHost(): Promise<void> {
    const made = dirs();
    root = made.dir;
    mkdirSync(path.join(root, 'notes'), { recursive: true });
    marker = path.join(root, 'notes', 'marker.txt');
    writeFileSync(marker, 'v1');
    // 缺省 storage_uri = sqlite 落 data_dir/ink.sqlite（B2：restore 先停
    // runtime 再整目录替换，Windows 不再依赖显式 memory:// 规避 rename）
    handle = await createHost({ data_dir: root, events_dir: made.events });
    expect(handle.config.storage_uri).toContain('sqlite://');
  }

  it('sqlite 后端 export → 改动 → restore 恢复一致（先停 runtime 换库；快照保留）', async () => {
    await bootHost();
    const send = handle.bridge.get('rounds.send')!;
    const chainView = handle.bridge.get('records.chain')!;
    const first = (await send({ input: '恢复前' }, CTX)) as { thread_id: string };
    const before = (await chainView({ thread_id: first.thread_id }, CTX)) as {
      chain: unknown[];
    };
    expect(before.chain.length).toBeGreaterThan(0);
    const backupExport = handle.bridge.get('backup.export')!;
    const exported = (await backupExport({}, CTX)) as { file: string; entries: number };
    expect(exported.entries).toBeGreaterThan(0);

    // 改动：追加一轮 + 改文件
    await send({ input: '改动后', thread_id: first.thread_id }, CTX);
    const modified = (await chainView({ thread_id: first.thread_id }, CTX)) as {
      chain: unknown[];
    };
    expect(modified.chain.length).toBeGreaterThan(before.chain.length);
    writeFileSync(marker, 'v2');

    const preview = (await handle.bridge.get('backup.preview')!(
      { path: exported.file },
      CTX,
    )) as { entries_total: number; has_db: boolean };
    expect(preview.entries_total).toBe(exported.entries);
    expect(preview.has_db).toBe(true);

    await expect(handle.bridge.get('backup.restore')!({ path: exported.file }, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });

    const restored = (await handle.bridge.get('backup.restore')!(
      { path: exported.file, confirm: 'backup-restore' },
      CTX,
    )) as { restored_entries: number; has_db: boolean; snapshot: string };
    expect(restored.restored_entries).toBeGreaterThan(0);
    expect(restored.has_db).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('v1');
    // 原目录快照保留在 data_dir/snapshots（快照为同一 data_dir 打包产物）
    expect(restored.snapshot.startsWith(path.join(root, 'snapshots'))).toBe(true);
    expect(existsSync(restored.snapshot)).toBe(true);

    // restore 后 runtime 已重新装配：链回到备份时形态且可继续驱动回合
    const after = (await chainView({ thread_id: first.thread_id }, CTX)) as {
      chain: unknown[];
    };
    expect(after.chain.length).toBe(before.chain.length);
    const resumed = (await send({ input: '恢复后', thread_id: first.thread_id }, CTX)) as {
      reason: string;
    };
    expect(resumed.reason).toMatch(/^(ok|reply)$/);
  });

  it('restore 期间并发请求被拒（维护闸 restore_in_progress）', async () => {
    await bootHost();
    const backupExport = handle.bridge.get('backup.export')!;
    const exported = (await backupExport({}, CTX)) as { file: string };

    const restoring = handle.bridge.get('backup.restore')!(
      { path: exported.file, confirm: 'backup-restore' },
      CTX,
    );
    await expect(
      handle.bridge.get('rounds.send')!({ input: '并发请求' }, CTX),
    ).rejects.toMatchObject({ code: 'restore_in_progress' });
    await expect(
      handle.bridge.get('backup.restore')!({ path: exported.file, confirm: 'backup-restore' }, CTX),
    ).rejects.toMatchObject({ code: 'restore_in_progress' });

    await restoring;
    expect(readFileSync(marker, 'utf8')).toBe('v1');
    expect(handle.config.storage_uri).toContain('sqlite://');
  });

  it('restore 错误路径不留半替换态（坏包拒绝后原数据可查、host 可继续）', async () => {
    await bootHost();
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: '原数据' }, CTX)) as { thread_id: string };
    // 恶意包：含 snapshots 首段条目 → applyRestore 预检拒绝（未动任何文件）
    mkdirSync(path.join(root, 'backups'), { recursive: true });
    const evil = path.join(root, 'backups', 'evil.zip');
    writeFileSync(
      evil,
      packStoreZip([{ path: 'snapshots/evil.txt', data: Buffer.from('x') }]),
    );

    await expect(
      handle.bridge.get('backup.restore')!({ path: evil, confirm: 'backup-restore' }, CTX),
    ).rejects.toMatchObject({ code: 'backup_failed' });

    // 错误路径不留半替换态：原文件仍在、链记录仍在、host 仍可驱动
    expect(readFileSync(marker, 'utf8')).toBe('v1');
    const chain = (await handle.bridge.get('records.chain')!(
      { thread_id: first.thread_id },
      CTX,
    )) as { chain: unknown[] };
    expect(chain.chain.length).toBeGreaterThan(0);
    const resumed = (await send({ input: '恢复后仍可跑', thread_id: first.thread_id }, CTX)) as {
      reason: string;
    };
    expect(resumed.reason).toMatch(/^(ok|reply)$/);
  });
});

