/**
 * cli 方法面别名层单测（legacy_aliases + buildHandlers + rpc handleRequest）：
 * H2 桥面别名补映射后——扁平旧名可解析到点分方法（参数 camel→snake 适配、
 * 危险操作确认标记不回代），无真源旧名（round_ledger_merge / mcp_market_
 * preview|add|remove / memory.update_frontmatter）不注册 → -32601。
 */

import { describe, expect, it } from 'vitest';

import type { Handler } from '../src/rpc.js';
import { ERROR_CODES, handleRequest, type RpcResponse } from '../src/rpc.js';
import { buildHandlers } from '../src/handlers.js';
import { legacyAliasTable } from '../src/legacy_aliases.js';

const CTX = { autoApprove: false };

interface Captured {
  params: unknown;
  calls: number;
}

/** 用 stub bridge 方法表构建命令面（目标方法捕获入参）。 */
function buildSurface(): {
  handlers: ReadonlyMap<string, Handler>;
  captured: Map<string, Captured>;
} {
  const captured = new Map<string, Captured>();
  const stub = (name: string): Handler => (params: unknown): Record<string, unknown> => {
    const record = captured.get(name) ?? { params, calls: 0 };
    record.calls += 1;
    record.params = params;
    captured.set(name, record);
    return { ok: true, method: name, echo: params };
  };
  const targets = [
    'sessions.messages',
    'records.chain',
    'rounds.todos',
    'rounds.resume',
    'recovery.reset',
    'recovery.checkpoints',
    'recovery.rollback',
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
    'graph.instance',
    'pool.snapshot',
    'pool.evaluate',
    'edge_evidence.list',
    'metrics.snapshot',
    'assemble.stats',
    'cache.stats',
    'path.state',
    'entities.snapshot',
  ];
  const bridge = new Map<string, Handler>();
  for (const name of targets) bridge.set(name, stub(name));
  return { handlers: buildHandlers({ bridge }), captured };
}

describe('legacy 别名表（H2 补桥后）', () => {
  it('别名表含新落点（会话消息/链记录/待办/重置/备份/市场/知识/记忆/成长）', () => {
    const table = legacyAliasTable();
    const rows = Object.fromEntries(table.map(({ flat, dotted }) => [flat, dotted]));
    expect(rows['session_messages']).toBe('sessions.messages');
    expect(rows['round_ledger_chain']).toBe('records.chain');
    expect(rows['todo_get']).toBe('rounds.todos');
    expect(rows['todo.get']).toBe('rounds.todos');
    expect(rows['recovery_factory_reset']).toBe('recovery.reset');
    expect(rows['recovery_snapshots']).toBe('recovery.checkpoints');
    expect(rows['recovery_restore_snapshot']).toBe('recovery.rollback');
    expect(rows['tools_manifest']).toBe('tools.full');
    expect(rows['tools_baseline_get']).toBe('capability.baseline.get');
    expect(rows['tools_baseline_set']).toBe('capability.baseline.set');
    expect(rows['security_tier_overrides_set']).toBe('capability.tier.set');
    expect(rows['backup_export']).toBe('backup.export');
    expect(rows['backup_preview']).toBe('backup.preview');
    expect(rows['backup_restore']).toBe('backup.restore');
    expect(rows['mcp_market_status']).toBe('mcp.market');
    expect(rows['mcp_market_mount']).toBe('mcp.mount');
    expect(rows['mcp_market_unmount']).toBe('mcp.unmount');
    expect(rows['audit.list']).toBe('audit.list');
    expect(rows['knowledge.list']).toBe('knowledge.list');
    expect(rows['growth.report']).toBe('growth.report');
    // H2b 读取类别名落点（写类/越权类不注册）
    expect(rows['graph_instance_snapshot']).toBe('graph.instance');
    expect(rows['pool_snapshot']).toBe('pool.snapshot');
    expect(rows['pool_evaluate']).toBe('pool.evaluate');
    expect(rows['edge_evidence_list']).toBe('edge_evidence.list');
    expect(rows['metrics_snapshot']).toBe('metrics.snapshot');
    expect(rows['assemble_stats']).toBe('assemble.stats');
    expect(rows['cache_stats']).toBe('cache.stats');
    expect(rows['path_state']).toBe('path.state');
    expect(rows['entities_snapshot']).toBe('entities.snapshot');
    expect(rows['graph_snapshot']).toBeUndefined();
    expect(rows['tools_snapshot']).toBeUndefined();
    expect(rows['path_set_multipath']).toBeUndefined();
    expect(rows['path_choose_candidate']).toBeUndefined();
    expect(rows['edge_downgrade_tier']).toBeUndefined();
    expect(rows['edge_restore_tier']).toBeUndefined();
    // 无真源旧名不注册
    expect(rows['round_ledger_list']).toBeUndefined();
    expect(rows['round_ledger_merge']).toBeUndefined();
    expect(rows['mcp_market_preview']).toBeUndefined();
    expect(rows['mcp_market_add']).toBeUndefined();
    expect(rows['mcp_market_remove']).toBeUndefined();
    expect(rows['memory.update_frontmatter']).toBeUndefined();
  });
});

describe('cli 命令面别名解析（H2）', () => {
  it('session_messages / todo_get 适配 camel→snake 后落点', async () => {
    const { handlers, captured } = buildSurface();
    const invoke = async (method: string, params: unknown): Promise<RpcResponse> =>
      await handleRequest({ jsonrpc: '2.0', id: 1, method, params }, handlers, CTX);

    const messages = await invoke('session_messages', { threadId: 't-1' });
    expect(messages.result).toMatchObject({ method: 'sessions.messages' });
    expect(captured.get('sessions.messages')!.params).toEqual({ thread_id: 't-1' });

    await invoke('todo_get', { threadId: 't-3' });
    expect(captured.get('rounds.todos')!.params).toEqual({ thread_id: 't-3' });
  });

  it('recovery_factory_reset 确认标记不回代（缺 confirm 由桥 fail-closed 拒绝）', async () => {
    const { handlers, captured } = buildSurface();
    await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'recovery_factory_reset', params: {} },
      handlers,
      CTX,
    );
    expect(captured.get('recovery.reset')!.params).not.toHaveProperty('confirm');
  });

  it('tools_baseline_set / security_tier_overrides_set 参数适配落点', async () => {
    const { handlers, captured } = buildSurface();
    await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools_baseline_set', params: { tools: ['a'] } },
      handlers,
      CTX,
    );
    expect(captured.get('capability.baseline.set')!.params).toEqual({ tools: ['a'] });
    await handleRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'security_tier_overrides_set',
        params: { overrides: { demo: 'review' } },
      },
      handlers,
      CTX,
    );
    expect(captured.get('capability.tier.set')!.params).toEqual({
      tier_overrides: { demo: 'review' },
    });
  });

  it('未注册旧扁平名 → -32601（round_ledger_list / round_ledger_merge / mcp_market_preview）', async () => {
    const { handlers } = buildSurface();
    for (const method of ['round_ledger_list', 'round_ledger_merge']) {
      const notFound = await handleRequest(
        { jsonrpc: '2.0', id: 1, method, params: {} },
        handlers,
        CTX,
      );
      expect(notFound.error).toMatchObject({ code: ERROR_CODES.methodNotFound });
    }
    const preview = await handleRequest(
      { jsonrpc: '2.0', id: 2, method: 'mcp_market_preview', params: {} },
      handlers,
      CTX,
    );
    expect(preview.error).toMatchObject({ code: ERROR_CODES.methodNotFound });
  });

  it('同点分别名（audit.list / knowledge.list / memory.list）可解析到自身方法', async () => {
    const { handlers, captured } = buildSurface();
    await handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'audit.list', params: { kind: 'x' } },
      handlers,
      CTX,
    );
    expect(captured.get('audit.list')!.params).toEqual({ kind: 'x' });
  });

  it('H2b 读取类别名解析落点（graph_instance_snapshot / pool_evaluate）', async () => {
    const { handlers, captured } = buildSurface();
    const invoke = async (method: string, params: unknown): Promise<RpcResponse> =>
      await handleRequest({ jsonrpc: '2.0', id: 1, method, params }, handlers, CTX);

    await invoke('graph_instance_snapshot', { threadId: 't-a' });
    expect(captured.get('graph.instance')!.params).toEqual({ thread_id: 't-a' });

    await invoke('pool_evaluate', {
      proposal: { node_id: 'candidate', fields: ['a'] },
      snapshot: { pool_count: 10, used_this_week: 0, pool_nodes: [] },
    });
    expect(captured.get('pool.evaluate')!.params).toEqual({
      proposal: { node_id: 'candidate', fields: ['a'] },
      snapshot: { pool_count: 10, used_this_week: 0, pool_nodes: [] },
    });

    await invoke('metrics_snapshot', {});
    await invoke('assemble_stats', {});
    await invoke('cache_stats', {});
    await invoke('entities_snapshot', {});
    await invoke('path_state', {});
    expect(captured.get('metrics.snapshot')!.calls).toBe(1);
    expect(captured.get('assemble.stats')!.calls).toBe(1);
    expect(captured.get('cache.stats')!.calls).toBe(1);
    expect(captured.get('entities.snapshot')!.calls).toBe(1);
    expect(captured.get('path.state')!.calls).toBe(1);
  });

  it('round_resume 决议重入：accept/reject 裸决议原样、edit 编辑内容映射为 edited_content', async () => {
    const { handlers, captured } = buildSurface();
    const invoke = async (method: string, params: unknown): Promise<RpcResponse> =>
      await handleRequest({ jsonrpc: '2.0', id: 1, method, params }, handlers, CTX);

    await invoke('round_resume', { threadId: 't-1', key: 'gate:1', decision: 'accept' });
    expect(captured.get('rounds.resume')!.params).toEqual({
      thread_id: 't-1',
      decision: { decision: 'accept' },
    });

    await invoke('round_resume', {
      threadId: 't-2',
      key: 'gate:2',
      decision: 'reject',
      reason: '人工核对不符',
    });
    expect(captured.get('rounds.resume')!.params).toEqual({
      thread_id: 't-2',
      decision: { decision: 'reject', reason: '人工核对不符' },
    });

    await invoke('round_resume', {
      threadId: 't-3',
      key: 'gate:3',
      decision: 'edit',
      editedContent: '改成这句',
    });
    expect(captured.get('rounds.resume')!.params).toEqual({
      thread_id: 't-3',
      decision: { decision: 'edit', edited_content: '改成这句' },
    });
  });

  it('H2b 不提供的干预扁平名 → -32601（path_set_multipath / edge_downgrade_tier / snapshot 别名）', async () => {
    const { handlers } = buildSurface();
    for (const method of [
      'path_set_multipath',
      'path_choose_candidate',
      'edge_downgrade_tier',
      'tools_snapshot',
      'graph_snapshot',
    ]) {
      const response = await handleRequest(
        { jsonrpc: '2.0', id: 1, method, params: {} },
        handlers,
        CTX,
      );
      expect(response.error).toMatchObject({ code: ERROR_CODES.methodNotFound });
    }
  });
});
