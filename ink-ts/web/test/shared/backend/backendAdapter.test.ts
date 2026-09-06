/**
 * 后端适配器契约测试：可注入后端（真实数据源 mock 形态）+ 远端会话存储。
 *
 * 断言面：serve 通道形态（channel.request 直调命令名/参数）、通道不可用
 * 回落、会话 CRUD 经适配器下发、标题/消息刷新落库、危险操作 confirm 标记。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createServeBackend,
  createUnavailableBackend,
  type BackendAdapter,
  type SessionRemoteRecord,
} from '@/shared/backend/backendAdapter';
import { RemoteSessionStore } from '@/shared/backend/remoteSessionStore';
import type { ServeChannel } from '@/shared/backend/transport';

function mockChannel(): { channel: ServeChannel; calls: Array<{ cmd: string; args: unknown }> } {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  const channel: ServeChannel = {
    available: true,
    request: (async (cmd: string, params?: unknown) => {
      calls.push({ cmd, args: params ?? {} });
      return {};
    }) as ServeChannel['request'],
    subscribe: async () => () => undefined,
    upload: async () => null,
  };
  return { channel, calls };
}

const seed: SessionRemoteRecord[] = [
  {
    thread_id: 'thread-a',
    title: '墨引擎调研',
    created_at: 1000,
    updated_at: 2000,
    message_count: 3,
    current_leaf: 5,
    rename_count: 0,
  },
  {
    thread_id: 'thread-b',
    title: '',
    created_at: 1500,
    updated_at: 1500,
    message_count: 0,
    current_leaf: null,
    rename_count: 0,
  },
];

describe('serve 通道适配器', () => {
  it('宿主不可用 = 不可用适配器（调用抛错而非静默）', () => {
    const backend = createUnavailableBackend();
    expect(backend.available).toBe(false);
    expect(() => backend.sessionList()).toThrow(/宿主后端不可用/);
  });

  it('会话命令经 request 直调（命令名/参数形态对齐 serve 通道）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    expect(backend.available).toBe(true);
    await backend.sessionList();
    await backend.sessionCreate();
    await backend.sessionRename('thread-a', '新标题');
    await backend.sessionDelete('thread-a');
    await backend.sessionRefresh('thread-a');
    await backend.sessionTree('thread-a');
    await backend.sessionBranch('thread-a', 'branch', 5, '编辑文本');
    expect(calls.map((call) => call.cmd)).toEqual([
      'session_list',
      'session_create',
      'session_rename',
      'session_delete',
      'session_refresh',
      'session_tree',
      'session_branch',
    ]);
    expect(calls[2].args).toEqual({ threadId: 'thread-a', title: '新标题' });
    expect(calls[6].args).toEqual({ threadId: 'thread-a', action: 'branch', targetLeaf: 5, editText: '编辑文本' });
  });

  it('回合/能力档/备份/崩溃回退命令参数对齐宿主（危险操作带 confirm）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.roundSend('thread-a', 'round-1', '调研', false);
    await backend.roundAbort('round-1');
    await backend.roundResume('thread-a', 'patch.rule', 'accept');
    await backend.capabilityPut({ max_tool_rounds: 8 });
    await backend.securityTierOverridesSet({ shell_exec: 'review' });
    await backend.backupExport('C:\\backup.inkbk');
    await backend.backupPreview('C:\\backup.inkbk');
    await backend.backupRestore('C:\\backup.inkbk');
    await backend.recoverySnapshots('thread-a');
    await backend.recoveryRestoreSnapshot('thread-a', 2);
    await backend.recoveryFactoryReset();
    expect(calls.map((call) => call.cmd)).toEqual([
      'round_send',
      'round_abort',
      'round_resume',
      'capability_put',
      'security_tier_overrides_set',
      'backup_export',
      'backup_preview',
      'backup.restore',
      'recovery_snapshots',
      'recovery_restore_snapshot',
      'recovery.reset',
    ]);
    expect(calls[0].args).toEqual({ threadId: 'thread-a', roundId: 'round-1', text: '调研', autoAcceptReview: false });
    expect(calls[2].args).toEqual({ threadId: 'thread-a', key: 'patch.rule', decision: 'accept' });
    // 危险操作：backup.restore / recovery.reset 须携带固定 confirm 标记
    expect(calls[7].args).toEqual({ path: 'C:\\backup.inkbk', confirm: 'backup-restore' });
    expect(calls[10].args).toEqual({ confirm: 'factory-reset' });
  });

  it('出厂组件启停命令经 request 直调（点分方法 + disabled 直收）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.uiComponentsGet();
    await backend.uiComponentsSetDisabled(['message_list']);
    expect(calls.map((call) => call.cmd)).toEqual(['ui_components.get', 'ui_components.set_disabled']);
    expect(calls[1].args).toEqual({ disabled: ['message_list'] });
  });

  it('命令名对齐点分/别名面（todo/growth/mcp/knowledge/memory/graph/audit 直调）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.todoGet('thread-a');
    await backend.growthReport();
    await backend.modelsRefresh({ base_url: 'http://x', models: [] });
    await backend.modelsConfigPut({ providers: [] });
    await backend.openDirectoryDialog({ title: '选目录', directory: true, multiple: false });
    await backend.mcpMarketStatus();
    await backend.mcpMarketUnmount('market.fs_access');
    await backend.knowledgeList(true);
    await backend.knowledgeExport();
    await backend.memoryList();
    await backend.memoryInvalidate('m-1');
    await backend.graphInstanceSnapshot('thread-a');
    await backend.auditList({ limit: 100 });
    expect(calls.map((call) => call.cmd)).toEqual([
      'rounds.todos',
      'growth.report',
      'models_refresh',
      'models_config_put',
      'dialog.open_directory',
      'mcp.market',
      'mcp.unmount',
      'knowledge.list',
      'knowledge.export',
      'memory.list',
      'memory.invalidate',
      'graph.instance',
      'audit.list',
    ]);
    expect(calls[0].args).toEqual({ thread_id: 'thread-a' });
    expect(calls[1].args).toEqual({});
    expect(calls[2].args).toEqual({ config: { base_url: 'http://x', models: [] } });
    expect(calls[3].args).toEqual({ config: { providers: [] } });
    expect(calls[4].args).toEqual({ options: { title: '选目录', directory: true, multiple: false } });
    expect(calls[5].args).toEqual({});
    expect(calls[6].args).toEqual({ name: 'market.fs_access' });
    expect(calls[7].args).toEqual({ args: { includeArchived: true } });
    expect(calls[8].args).toEqual({});
    expect(calls[9].args).toEqual({});
    expect(calls[10].args).toEqual({ ids: ['m-1'] });
    expect(calls[11].args).toEqual({ thread_id: 'thread-a' });
    expect(calls[12].args).toEqual({ limit: 100 });
  });

  it('mcp.mount config 组装（stdio command/url 透传）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.mcpMarketMount({ id: 'market.fs_access', transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(calls[0].cmd).toBe('mcp.mount');
    expect(calls[0].args).toEqual({
      config: { id: 'market.fs_access', transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
    });
  });

  it('模型配置旧扁平面命令名不回归（get/reload 直调、put/refresh 带 config）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.modelsConfigGet();
    await backend.modelReload();
    await backend.modelsConfigPut({ providers: [] });
    await backend.modelsRefresh({ base_url: 'http://x', models: [] });
    expect(calls.map((call) => call.cmd)).toEqual([
      'models_config_get',
      'model.reload',
      'models_config_put',
      'models_refresh',
    ]);
    expect(calls[0].args).toEqual({});
    expect(calls[1].args).toEqual({});
    expect(calls[2].args).toEqual({ config: { providers: [] } });
    expect(calls[3].args).toEqual({ config: { base_url: 'http://x', models: [] } });
  });

  it('modelsRolePick 直调点分方法 models.config.role_pick（camel → snake 参数）', async () => {
    const { channel, calls } = mockChannel();
    const backend = createServeBackend(channel);
    await backend.modelsRolePick('agent', 'deepseek', 'deepseek-reasoner');
    expect(calls.map((call) => call.cmd)).toEqual(['models.config.role_pick']);
    expect(calls[0].args).toEqual({
      role: 'agent',
      provider_id: 'deepseek',
      model_id: 'deepseek-reasoner',
    });
  });
});

describe('远端会话存储（真实数据源注入 mock 后端）', () => {
  function mockBackend(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
    return {
      available: true,
      sessionList: vi.fn(async () => seed),
      sessionCreate: vi.fn(async () => ({
        thread_id: 'thread-c',
        title: '',
        created_at: 3000,
        updated_at: 3000,
        message_count: 0,
        current_leaf: null,
        rename_count: 0,
      })),
      sessionRename: vi.fn(async (_threadId, title) => ({ ...seed[0], title, rename_count: 1 })),
      sessionDelete: vi.fn(async () => ({ deleted: true })),
      sessionRefresh: vi.fn(async () => ({ ...seed[0], title: '自动标题', message_count: 4 })),
      roundSend: vi.fn(),
      roundAbort: vi.fn(),
      roundResume: vi.fn(),
      routePlan: vi.fn(),
      sessionTree: vi.fn(),
      sessionBranch: vi.fn(),
      authorizationState: vi.fn(),
      workspaceAuthorize: vi.fn(),
      workspaceRevoke: vi.fn(),
      capabilityGet: vi.fn(),
      capabilityPut: vi.fn(),
      securityTierOverridesSet: vi.fn(),
      backupExport: vi.fn(),
      backupPreview: vi.fn(),
      backupRestore: vi.fn(),
      recoverySnapshots: vi.fn(),
      recoveryRestoreSnapshot: vi.fn(),
      recoveryFactoryReset: vi.fn(),
      ...overrides,
    } as BackendAdapter;
  }

  it('reload 拉取宿主清单并按最近活跃排序', async () => {
    const backend = mockBackend();
    const store = new RemoteSessionStore(backend);
    await store.reload();
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('thread-a');
    expect(list[0].title).toBe('墨引擎调研');
    expect(list[0].titleSource).toBe('generated');
    // 空标题会话 = 时间戳降级标题
    const second = store.get('thread-b');
    expect(second?.title).toMatch(/^会话 /);
  });

  it('create 经宿主下发（异步落库后本地镜像替换占位）', async () => {
    const backend = mockBackend();
    const store = new RemoteSessionStore(backend);
    const pending = store.create();
    expect(pending.id).toMatch(/^pending-/);
    await vi.waitFor(() => {
      expect(store.get('thread-c')).toBeDefined();
    });
  });

  it('rename/remove 本地生效并下发宿主', async () => {
    const backend = mockBackend();
    const store = new RemoteSessionStore(backend);
    await store.reload();
    store.rename('thread-a', '手动标题');
    expect(store.get('thread-a')?.title).toBe('手动标题');
    expect(store.get('thread-a')?.titleSource).toBe('manual');
    expect(backend.sessionRename).toHaveBeenCalledWith('thread-a', '手动标题');
    store.remove('thread-b');
    expect(store.get('thread-b')).toBeUndefined();
    expect(backend.sessionDelete).toHaveBeenCalledWith('thread-b');
  });

  it('applyRemote 用宿主记录覆盖本地镜像（回合后标题生成落位）', async () => {
    const backend = mockBackend();
    const store = new RemoteSessionStore(backend);
    await store.reload();
    store.applyRemote({ ...seed[0], title: '自动标题', rename_count: 0 });
    expect(store.get('thread-a')?.title).toBe('自动标题');
    expect(store.get('thread-a')?.titleSource).toBe('generated');
  });

  it('subscribe 在镜像变更时通知', async () => {
    const backend = mockBackend();
    const store = new RemoteSessionStore(backend);
    await store.reload();
    const listener = vi.fn();
    store.subscribe(listener);
    store.touch('thread-a');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
