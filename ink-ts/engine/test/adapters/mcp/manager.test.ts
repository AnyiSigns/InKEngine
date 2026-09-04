/**
 * MCP 客户端管理器单测：导入/分发/断开/连接（含 stdio 自动包监督）、
 * vetting 闸门过滤、观察模式接线（影子探针 + 证据累积）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import {
  DeclarativeToolSpec,
} from '../../../src/core/declarative_tools/declarative_spec.js';
import { DeclarativeToolExecutors } from '../../../src/core/declarative_tools/executors.js';
import { EndpointType } from '../../../src/core/declarative_tools/endpoint_types.js';
import {
  McpClientManager,
  McpServerConfig,
  McpToolImportError,
  McpTransport,
  StdioRestartPolicy,
  SupervisedStdioSession,
  register_mcp_executor,
  convert_mcp_tool,
  type McpSessionHandle,
  type McpToolRecord,
} from '../../../src/adapters/mcp/index.js';
import {
  AcceptVetting,
  FakeSession,
  RejectVetting,
  ReviewVetting,
  mcp_tool,
} from './_helpers.js';

function spec(server_id: string, name = 'tool'): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
    permissions: [`mcp:call:${server_id}`],
    endpoint: EndpointType.MCP,
    endpoint_config: { server_id },
  });
}

/** 假会话：可脚本化失败序列（监督路径用）。 */
class FailOnceSession implements McpSessionHandle {
  name: string;
  calls: string[] = [];
  fail_call_tools: number;
  closed = false;

  constructor(name: string, fail_call_tools: number) {
    this.name = name;
    this.fail_call_tools = fail_call_tools;
  }

  async list_tools() {
    this.calls.push('list_tools');
    return [];
  }

  async call_tool(name: string) {
    this.calls.push(`call:${name}`);
    if (this.fail_call_tools > 0) {
      this.fail_call_tools -= 1;
      throw new Error(`${this.name} process died`);
    }
    return `ok-${name}`;
  }

  async aclose(): Promise<void> {
    this.closed = true;
  }
}

describe('管理器导入（无 vetting）', () => {
  it('导入全部工具为声明式定义（端点 MCP）', async () => {
    const manager = new McpClientManager();
    manager.register_session('s1', new FakeSession([mcp_tool('a'), mcp_tool('b')]));
    const specs = await manager.import_tools('s1');
    expect(specs.map((s) => s.name).sort()).toEqual(['a', 'b']);
    for (const s of specs) expect(s.endpoint).toBe(EndpointType.MCP);
  });

  it('未连接 server 的导入 → McpToolImportError', async () => {
    const manager = new McpClientManager();
    await expect(manager.import_tools('nope')).rejects.toThrow(/未连接/);
  });

  it('协议违规工具（缺 name）逐项跳过并保留合法项', async () => {
    const manager = new McpClientManager();
    manager.register_session(
      's1',
      new FakeSession([mcp_tool('ok'), { description: '无名工具' }, mcp_tool('ok2')]),
    );
    const specs = await manager.import_tools('s1');
    expect(specs.map((s) => s.name).sort()).toEqual(['ok', 'ok2']);
  });
});

describe('管理器导入（vetting 闸门）', () => {
  it('被拒工具不进入工具表（fail-closed 不静默放行）', async () => {
    const manager = new McpClientManager();
    manager.register_session('s1', new FakeSession([mcp_tool('a'), mcp_tool('b')]));
    const specs = await manager.import_tools('s1', {
      vetting: new RejectVetting(['b']),
    });
    expect(specs.map((s) => s.name)).toEqual(['a']);
  });

  it('vetting 返回 REVIEW（静态审查待人工确认）同样不进入工具表', async () => {
    const manager = new McpClientManager();
    manager.register_session('s1', new FakeSession([mcp_tool('a')]));
    const specs = await manager.import_tools('s1', { vetting: new ReviewVetting() });
    expect(specs).toEqual([]);
  });
});

describe('管理器分发', () => {
  it('分发执行器按 server_id 反查会话转发调用', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const manager = new McpClientManager();
    manager.register_session('s1', new FakeSession([], calls));
    const definition = convert_mcp_tool('s1', mcp_tool('search'));
    const result = await manager.dispatch(null, definition, { q: 'hi' });
    expect(result).toBe('result-of-search');
    expect(calls).toEqual([['search', { q: 'hi' }]]);
  });

  it('未挂载 server 的调用 → fail-closed 拒绝', async () => {
    const manager = new McpClientManager();
    const definition = convert_mcp_tool('ghost', mcp_tool('search'));
    await expect(manager.dispatch(null, definition, {})).rejects.toThrow(/未连接/);
  });

  it('会话执行异常透传为失败（不伪装成成功文本）', async () => {
    class BrokenSession implements McpSessionHandle {
      async list_tools(): Promise<McpToolRecord[]> {
        return [];
      }
      async call_tool(): Promise<string> {
        throw new Error('远端炸了');
      }
      async aclose(): Promise<void> {
        return undefined;
      }
    }
    const manager = new McpClientManager();
    manager.register_session('s1', new BrokenSession());
    const definition = convert_mcp_tool('s1', mcp_tool('search'));
    await expect(manager.dispatch(null, definition, {})).rejects.toThrow('远端炸了');
  });
});

describe('MCP 端点定义期校验（server_id 路由密钥必填）', () => {
  it('MCP 端点缺 server_id 在定义期被拒绝', () => {
    expect(
      () =>
        new DeclarativeToolSpec({
          name: 't',
          description: 'd',
          parameters: { type: 'object', properties: {} },
          permissions: ['mcp:call:s1'],
          endpoint: EndpointType.MCP,
          endpoint_config: {},
        }),
    ).toThrow(/server_id/);
  });
});

describe('register_mcp_executor 装配', () => {
  it('把 MCP 分发器注册进声明式执行体注册表', () => {
    const executors = new DeclarativeToolExecutors();
    const manager = new McpClientManager();
    register_mcp_executor(executors, manager);
    expect(executors.has(EndpointType.MCP)).toBe(true);
  });
});

describe('管理器生命周期', () => {
  it('断开已登记会话：返回 True 且句柄被关闭（生命周期闭环）', async () => {
    const manager = new McpClientManager();
    const session = new FakeSession([]);
    manager.register_session('s1', session);
    expect(await manager.disconnect('s1')).toBe(true);
    expect(session.closed).toBe(true);
    expect(manager._sessions.has('s1')).toBe(false);
  });

  it('断开不存在的 server 返回 False（不抛错）', async () => {
    const manager = new McpClientManager();
    expect(await manager.disconnect('absent')).toBe(false);
  });

  it('已有活动会话时再次登记显式拒绝（防覆盖不关闭的泄漏）', () => {
    const manager = new McpClientManager();
    manager.register_session('s1', new FakeSession([]));
    expect(() => manager.register_session('s1', new FakeSession([]))).toThrow(
      /已有活动会话/,
    );
  });

  it('close_all 幂等释放全部会话（单个关闭失败不阻断其余）', async () => {
    const closed: string[] = [];
    class NamedSession extends FakeSession {
      label: string;
      constructor(label: string) {
        super([]);
        this.label = label;
      }
      async aclose(): Promise<void> {
        closed.push(this.label);
      }
    }
    const manager = new McpClientManager();
    manager.register_session('a', new NamedSession('a'));
    manager.register_session('b', new NamedSession('b'));
    await manager.close_all();
    expect(closed.sort()).toEqual(['a', 'b']);
    expect(manager._sessions.size).toBe(0);
    await manager.close_all(); // 幂等：空表再关不报错
  });
});

describe('管理器连接接线', () => {
  it('connect 对 stdio 自动包监督（崩溃 → 拉起新会话）', async () => {
    let calls = 0;
    const manager = new McpClientManager();
    manager._sdk_open = async () => {
      calls += 1;
      if (calls === 1) return new FailOnceSession('stdio', 1);
      return new FailOnceSession('fresh', 0);
    };
    const config = new McpServerConfig({
      id: 'stdio-srv',
      transport: McpTransport.STDIO,
      command: 'cmd',
      restart_policy: new StdioRestartPolicy({ backoff: 0 }),
    });
    const handle = await manager.connect(config);
    expect(handle).toBeInstanceOf(SupervisedStdioSession);
    await expect(manager.dispatch(null, spec('stdio-srv'), {})).rejects.toThrow();
    expect(calls).toBe(2);
    await expect(manager.dispatch(null, spec('stdio-srv'), {})).resolves.toBe('ok-tool');
  });

  it('connect 对 http 不包监督', async () => {
    const manager = new McpClientManager();
    manager._sdk_open = async () => new FakeSession([]);
    const config = new McpServerConfig({
      id: 'http-srv',
      transport: McpTransport.HTTP,
      url: 'http://x',
    });
    const handle = await manager.connect(config);
    expect(handle).not.toBeInstanceOf(SupervisedStdioSession);
  });
});

describe('观察模式接线（shadow_run 生产调用）', () => {
  it('VERIFIED 工具经影子探针 + 观察证据累积（untrusted 恒标）', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const manager = new McpClientManager();
    manager.register_session('s1', new FakeSession([mcp_tool('search')], calls));
    const specs = await manager.import_tools('s1', { vetting: new AcceptVetting() });
    expect(specs.map((s) => s.name)).toEqual(['search']);
    // 探针 = 空参（无默认值参数不臆造）经影子工作区执行一次远端调用
    expect(calls).toContainEqual(['search', {}]);
    const evidence = manager.shadow_evidence('s1');
    expect(evidence['s1:search']).toBeDefined();
    expect(evidence['s1:search']!['untrusted']).toBe(true);
    expect(evidence['s1:search']!['ok']).toBe(true);
    // 全量查询视角
    expect(manager.shadow_evidence()['s1:search']).toBeDefined();
  });

  it('探针参数派生：只取带默认值的可选字段（不猜测必填参数）', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const manager = new McpClientManager();
    manager.register_session(
      's1',
      new FakeSession(
        [
          {
            name: 'search',
            description: '搜索',
            input_schema: {
              type: 'object',
              properties: {
                q: { type: 'string' },
                limit: { type: 'number', default: 10 },
              },
            },
          },
        ],
        calls,
      ),
    );
    const specs = await manager.import_tools('s1', { vetting: new AcceptVetting() });
    expect(specs[0]!.name).toBe('search');
    expect(calls).toContainEqual(['search', { limit: 10 }]);
  });

  it('观察探针失败只记证据（ok=False），不阻断导入（观察不作门禁）', async () => {
    class FailingCallSession implements McpSessionHandle {
      async list_tools(): Promise<McpToolRecord[]> {
        return [mcp_tool('search')];
      }
      async call_tool(): Promise<string> {
        throw new Error('远端拒绝探针（必填参数缺失）');
      }
      async aclose(): Promise<void> {
        return undefined;
      }
    }
    const manager = new McpClientManager();
    manager.register_session('s1', new FailingCallSession());
    const specs = await manager.import_tools('s1', { vetting: new AcceptVetting() });
    expect(specs.map((s) => s.name)).toEqual(['search']);
    expect(manager.shadow_evidence('s1')['s1:search']!['ok']).toBe(false);
  });

  it('提供 shadow_workdir：影子探针在工作目录副本执行，真实目录零触碰', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-shadow-ws-'));
    try {
      fs.writeFileSync(path.join(workdir, 'keep.txt'), 'original');
      const calls: Array<[string, Record<string, unknown>]> = [];
      const manager = new McpClientManager();
      manager.register_session('s1', new FakeSession([mcp_tool('search')], calls));
      const specs = await manager.import_tools('s1', {
        vetting: new AcceptVetting(),
        shadow_workdir: workdir,
      });
      expect(specs.map((s) => s.name)).toEqual(['search']);
      // 远端探针不触碰本地工作区（观察零副作用）
      expect(fs.readFileSync(path.join(workdir, 'keep.txt'), 'utf-8')).toBe('original');
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  });
});
