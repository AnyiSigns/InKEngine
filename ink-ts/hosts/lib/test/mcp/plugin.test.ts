/**
 * McpPluginService 装载单测（B5）：候选解析 → enable（连接+导入+注册+索引刷新+
 * 台账）→ disable（注销+索引摘除+断连+台账摘除）→ 重启 restore 自动拉起。
 *
 * 用假 MCP 会话 seam（manager._sdk_open 注入假 handle：list_tools 返回 echo_text）
 * 零网络/进程；持久化走真实 capability store（capability.json）；host 接缝
 * （声明式注册/索引刷新/摘除）用记录桩断言。
 * // gate: 超限(351 行) - 启停/幂等/归属冲突/幽灵台账整链用例同文件保持可读
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpClientManager, type DeclarativeToolSpec } from '@ink-ts/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { createCapabilityStore } from '../../src/capability/store.js';
import {
  MCP_PLUGINS_ENABLED_KEY,
  McpPluginService,
  type McpPluginDeclarativeSeam,
  type McpPluginHostSeam,
} from '../../src/mcp/plugin.js';

function makeSessionHandle(toolNames: readonly string[] = ['echo_text']): {
  list_tools(): Promise<Array<Record<string, unknown>>>;
  call_tool?(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  ping?(): Promise<void>;
  aclose(): Promise<void>;
} {
  return {
    list_tools: async () =>
      toolNames.map((name) => ({
        name,
        description: '回显文本',
        input_schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      })),
    call_tool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    ping: async () => undefined,
    aclose: async () => undefined,
  };
}

function writeEchoServerSpec(root: string, serverId = 'demo.server'): void {
  const dir = join(root, 'mcp', serverId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'spec.json'),
    JSON.stringify(
      {
        id: serverId,
        kind: 'mcp',
        capability: 'external_tool',
        actions: [],
        depends: [],
        data: {
          server: {
            id: serverId,
            name: 'Demo Echo',
            source: 'fixture',
            transport: 'http',
            url: 'https://example.com',
            command: null,
            args: [],
            risk: 'low',
            category: 'echo',
            premounted: false,
          },
        },
      },
      null,
      2,
    ),
  );
}

function makeDeclarativeSpy(): {
  declarative: McpPluginDeclarativeSeam;
  registered: string[];
  unregistered: string[];
} {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const defs: Record<string, { endpoint_config?: Record<string, unknown> | null }> = {};
  return {
    registered,
    unregistered,
    declarative: {
      register_definition: (definition: DeclarativeToolSpec) => {
        registered.push(definition.name);
        const config = definition.endpoint_config;
        defs[definition.name] = {
          endpoint_config:
            config !== null && config !== undefined ? { ...config } : null,
        };
      },
      unregister_definition: (name: string) => {
        unregistered.push(name);
        delete defs[name];
      },
      get definitions(): Readonly<Record<string, { endpoint_config?: Record<string, unknown> | null }>> {
        return defs;
      },
    },
  };
}

function makeHostSeam(
  spy: ReturnType<typeof makeDeclarativeSpy>,
): { host: McpPluginHostSeam; refreshed: string[]; removed: string[] } {
  const refreshed: string[] = [];
  const removed: string[] = [];
  return {
    refreshed,
    removed,
    host: {
      harness_registry: { declarative: spy.declarative },
      refresh_tool_index: (specs: readonly unknown[]) => {
        for (const spec of specs as Array<{ name?: string }>) refreshed.push(spec?.name ?? '');
      },
      remove_tool_index: (name: string) => {
        removed.push(name);
      },
    },
  };
}

function newManager(opener: unknown): McpClientManager {
  const manager = new McpClientManager();
  (manager as unknown as { _sdk_open: unknown })._sdk_open = opener;
  return manager;
}

describe('McpPluginService（B5 工具型插件装载）', () => {
  const cleanupDirs: string[] = [];
  const managers: McpClientManager[] = [];

  afterEach(async () => {
    for (const manager of managers) {
      await manager.close_all();
    }
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
    managers.length = 0;
  });

  function setup(): {
    root: string;
    dataDir: string;
    capFile: string;
    store: ReturnType<typeof createCapabilityStore>;
    opener: unknown;
  } {
    const root = mkdtempSync(join(tmpdir(), 'ink-mcp-plugin-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'ink-mcp-plugin-data-'));
    cleanupDirs.push(root, dataDir);
    const capFile = join(dataDir, 'capability.json');
    const store = createCapabilityStore(dataDir);
    const handle = makeSessionHandle();
    const opener = async (): Promise<ReturnType<typeof makeSessionHandle>> => handle;
    return { root, dataDir, capFile, store, opener };
  }

  it('enable → 注册+索引刷新+台账；status 可见；disable → 注销+摘除+台账清除', async () => {
    const { root, capFile, store, opener } = setup();
    writeEchoServerSpec(root);
    const spy = makeDeclarativeSpy();
    const seam = makeHostSeam(spy);
    const manager = newManager(opener);
    managers.push(manager);
    const service = new McpPluginService({ pluginsRoot: root, host: seam.host, manager, store });

    const initial = service.list();
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ id: 'demo.server', enabled: false, connected: false });

    const outcome = await service.enable('demo.server');
    expect(outcome.ok).toBe(true);
    expect(outcome).toMatchObject({
      server_id: 'demo.server',
      enabled: true,
      connected: true,
      tool_count: 1,
    });
    expect(outcome.tools).toEqual(['echo_text']);

    expect(spy.registered).toEqual(['echo_text']);
    expect(seam.refreshed).toEqual(['echo_text']);
    const cap = JSON.parse(readFileSync(capFile, 'utf8')) as Record<string, unknown>;
    expect(cap[MCP_PLUGINS_ENABLED_KEY]).toEqual(['demo.server']);

    const statusRow = service.status('demo.server');
    expect(statusRow).toMatchObject({ enabled: true, connected: true, tool_count: 1 });

    const disabled = await service.disable('demo.server');
    expect(disabled.ok).toBe(true);
    expect(spy.unregistered).toEqual(['echo_text']);
    expect(seam.removed).toEqual(['echo_text']);
    expect(service.status('demo.server')).toMatchObject({
      enabled: false,
      connected: false,
      tool_count: 0,
    });
    const capAfter = JSON.parse(readFileSync(capFile, 'utf8')) as Record<string, unknown>;
    expect(capAfter[MCP_PLUGINS_ENABLED_KEY]).toEqual([]);
  });

  it('restore 重启自动拉起台账启用集（fail-closed 只记状态不击穿）', async () => {
    const { root, capFile, store, opener } = setup();
    writeEchoServerSpec(root);
    const spy = makeDeclarativeSpy();
    const seam = makeHostSeam(spy);
    const firstManager = newManager(opener);
    managers.push(firstManager);
    const first = new McpPluginService({ pluginsRoot: root, host: seam.host, manager: firstManager, store });
    await first.enable('demo.server');
    expect((JSON.parse(readFileSync(capFile, 'utf8')) as Record<string, unknown>)[MCP_PLUGINS_ENABLED_KEY]).toEqual([
      'demo.server',
    ]);

    const secondManager = newManager(opener);
    managers.push(secondManager);
    const second = new McpPluginService({ pluginsRoot: root, host: seam.host, manager: secondManager, store });
    const failures = await second.restore();
    expect(failures).toEqual([]);
    expect(second.status('demo.server')).toMatchObject({ enabled: true, connected: true, tool_count: 1 });
    expect(spy.registered).toEqual(['echo_text', 'echo_text']);
  });

  it('enable 幂等：已启用已连接重复调用短路，不销毁健康会话', async () => {
    const { root, store, opener } = setup();
    writeEchoServerSpec(root);
    const spy = makeDeclarativeSpy();
    const seam = makeHostSeam(spy);
    const manager = newManager(opener);
    managers.push(manager);
    const service = new McpPluginService({ pluginsRoot: root, host: seam.host, manager, store });
    const first = await service.enable('demo.server');
    expect(first.ok).toBe(true);
    const registeredAfterFirst = spy.registered.length;

    const again = await service.enable('demo.server');
    expect(again.ok).toBe(true);
    expect(again.tool_count).toBe(1);
    // 幂等短路：不重连、不重复注册/刷新
    expect(spy.registered).toHaveLength(registeredAfterFirst);
    expect(seam.refreshed).toEqual(['echo_text']);
    expect(service.status('demo.server')).toMatchObject({ enabled: true, connected: true, tool_count: 1 });
  });

  it('工具名冲突：跨 server 同名整批拒绝，不覆盖持方', async () => {
    const { root, store, opener } = setup();
    writeEchoServerSpec(root, 'demo.server');
    writeEchoServerSpec(root, 'demo.conflict');
    const spy = makeDeclarativeSpy();
    const seam = makeHostSeam(spy);
    const manager = newManager(opener);
    managers.push(manager);
    const service = new McpPluginService({ pluginsRoot: root, host: seam.host, manager, store });

    const first = await service.enable('demo.server');
    expect(first.ok).toBe(true);
    expect(spy.registered).toEqual(['echo_text']);

    const conflicted = await service.enable('demo.conflict');
    expect(conflicted.ok).toBe(false);
    expect(conflicted.error).toContain('工具名冲突');
    expect(spy.registered).toEqual(['echo_text']);
    // 冲突 server 不落台账、不留会话；持方不受影响
    expect(manager.list_servers()).toEqual(['demo.server']);
    expect(service.status('demo.server')).toMatchObject({ enabled: true, connected: true, tool_count: 1 });
    expect(service.status('demo.conflict')).toMatchObject({ enabled: false, connected: false });

    const disabled = await service.disable('demo.server');
    expect(disabled.ok).toBe(true);
    expect(spy.unregistered).toEqual(['echo_text']);
    expect(seam.removed).toEqual(['echo_text']);
  });

  it('幽灵台账：候选目录移除 → restore 剪除清账 + list 残影行可停用清理', async () => {
    const { root, store, capFile } = setup();
    writeEchoServerSpec(root);
    const spy = makeDeclarativeSpy();
    const seam = makeHostSeam(spy);
    const manager = newManager(
      async (): Promise<ReturnType<typeof makeSessionHandle>> => makeSessionHandle(),
    );
    managers.push(manager);
    const service = new McpPluginService({ pluginsRoot: root, host: seam.host, manager, store });
    await service.enable('demo.server');
    expect((JSON.parse(readFileSync(capFile, 'utf8')) as Record<string, unknown>)[MCP_PLUGINS_ENABLED_KEY]).toEqual([
      'demo.server',
    ]);

    // 目录运行中被移除（升级/插件废弃）→ list 暴露残影行；disable 幂等清账成功
    rmSync(join(root, 'mcp'), { recursive: true, force: true });
    const ghostRow = service.list().find((row) => row.id === 'demo.server');
    expect(ghostRow).toMatchObject({ enabled: true, error: expect.stringContaining('候选目录缺失') });
    const cleaned = await service.disable('demo.server');
    expect(cleaned.ok).toBe(true);
    expect((JSON.parse(readFileSync(capFile, 'utf8')) as Record<string, unknown>)[MCP_PLUGINS_ENABLED_KEY]).toEqual([]);

    // 重启 restore：候选缺失的台账 id 直接剪除，不再重试/报失败
    const dataDirGhost = mkdtempSync(join(tmpdir(), 'ink-mcp-plugin-ghost-'));
    cleanupDirs.push(dataDirGhost);
    const ghostStore = createCapabilityStore(dataDirGhost);
    ghostStore.put({ [MCP_PLUGINS_ENABLED_KEY]: ['ghost.server'] });
    const third = new McpPluginService({
      pluginsRoot: root,
      host: seam.host,
      manager: newManager(async (): Promise<ReturnType<typeof makeSessionHandle>> => makeSessionHandle()),
      store: ghostStore,
    });
    const ghostFailures = await third.restore();
    expect(ghostFailures).toEqual([]);
    const ghostCap = JSON.parse(readFileSync(join(dataDirGhost, 'capability.json'), 'utf8')) as Record<string, unknown>;
    expect(ghostCap[MCP_PLUGINS_ENABLED_KEY]).toEqual([]);
    expect(third.list()).toEqual([]);
  });

  it('enable 失败（连接抛错）→ 显式结果 + 台账不落；disable 未知候选显式拒绝', async () => {
    const { root, opener } = setup();
    writeEchoServerSpec(root);
    const spy = makeDeclarativeSpy();
    const seam = makeHostSeam(spy);
    const dataDir = mkdtempSync(join(tmpdir(), 'ink-mcp-plugin-fail-'));
    cleanupDirs.push(dataDir);
    const store = createCapabilityStore(dataDir);
    const manager = new McpClientManager();
    managers.push(manager);
    (manager as unknown as { _sdk_open: unknown })._sdk_open = async () => {
      throw new Error('connect boom');
    };
    const service = new McpPluginService({ pluginsRoot: root, host: seam.host, manager, store });

    const failed = await service.enable('demo.server');
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('MCP 连接失败');
    expect(existsSync(join(dataDir, 'capability.json'))).toBe(false);
    const badDisable = await service.disable('nope');
    expect(badDisable.ok).toBe(false);
    void opener;
  });
});
