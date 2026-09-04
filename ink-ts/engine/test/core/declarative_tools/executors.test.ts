/**
 * 执行体分发（DeclarativeToolExecutors.dispatch）单测——对标
 * ink_engine/tests/test_declarative_tools.py 的分发用例（按端点路由/
 * 声明式定义反查/受控取回 url 档路由），逐条同名同义移植。
 *
 * 语义检查点：未登记定义 = 显式拒绝（不静默失败）；未注册端点类型执行体
 * = 分发处显式拒绝；受控取回 url 档改走受控执行体（注册键 =
 * meta.retrieval 声明值，声明驱动非按名写死），file/text 档回落端点
 * 执行体；受控执行体未注册 = url 档显式拒绝（不静默回落端点执行体）。
 *
 * 延后用例：make_http_fetch_executor / make_controlled_fetch_executor
 * 的流式读取/截断属真实网络执行体（Python 侧以 monkeypatch 假 httpx
 * 覆盖）——TS core 零 IO，执行体以 HttpStreamClient seam 注入，其
 * 流式截断用例随网络 seam 宿主实现一并回归；本文件只测注册表分发的
 * 纯机制（宿主注入的 lambda 执行体）。
 */
import { describe, expect, it } from 'vitest';

import { ToolSpec } from '../../../src/core/llm/tools.js';
import {
  DeclarativeToolExecutors,
  DeclarativeToolSpec,
  EndpointType,
  RETRIEVAL_CONTROLLED_FETCH,
} from '../../../src/core/declarative_tools/index.js';

/** collect_material 形态声明式定义（endpoint=mcp + 受控取回标记）。 */
function controlledCollect(overrides: Record<string, unknown> = {}): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    name: 'collect_material',
    description: '采集研究素材（text 直取 / url 受控取回）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        text: { type: 'string' },
        max_bytes: { type: 'integer' },
      },
    },
    permissions: ['mcp:call:inkling_exec', 'network:connect:*'],
    endpoint: EndpointType.MCP,
    endpoint_config: { server_id: 'inkling_exec' },
    meta: { retrieval: RETRIEVAL_CONTROLLED_FETCH, domain: 'research' },
    ...(overrides as { permissions?: readonly string[] }),
  });
}

describe('执行体分发', () => {
  it('按端点类型路由；未注册端点/未登记定义 → 显式拒绝', async () => {
    const executors = new DeclarativeToolExecutors();
    const definition = new DeclarativeToolSpec({
      name: 'mytool',
      description: '声明式工具',
      parameters: { type: 'object' },
      permissions: ['process:exec:git'],
      endpoint: EndpointType.PROCESS_EXEC,
      endpoint_config: { allowlist: ['git'] },
    });
    executors.register_definition(definition);
    const calls: string[] = [];

    const processExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push(defn.endpoint);
      return `exec:${String(args['command'])}`;
    };
    executors.register(EndpointType.PROCESS_EXEC, processExecutor);
    const spec = definition.to_spec();
    const result = await executors.dispatch(null, spec, { command: 'git' });
    expect(result).toBe('exec:git');
    expect(calls).toEqual(['process_exec']);

    // 未登记定义的工具 → 拒绝
    await expect(executors.dispatch(null, new ToolSpec({ name: 'ghost' }), {})).rejects.toThrow(
      '无声明式定义',
    );
    // 未注册端点类型的定义 → 拒绝
    executors.register_definition(
      new DeclarativeToolSpec({
        name: 'net',
        description: '声明式工具',
        parameters: { type: 'object' },
        permissions: ['network:connect:*.example.com'],
        endpoint: EndpointType.HTTP_FETCH,
      }),
    );
    await expect(executors.dispatch(null, new ToolSpec({ name: 'net' }), {})).rejects.toThrow(
      '未注册执行体',
    );
  });
});

describe('受控取回分发', () => {
  it('url 档改走受控执行体；file/text 档仍走端点执行体（mcp）', async () => {
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(controlledCollect());
    const calls: string[] = [];

    const mcpExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push(`mcp:${String(args['text'])}`);
      return 'mcp-ok';
    };
    const controlledExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push(`cf:${String(args['url'])}`);
      return '{"ok": true, "source": "url"}';
    };
    executors.register(EndpointType.MCP, mcpExecutor);
    executors.register(RETRIEVAL_CONTROLLED_FETCH, controlledExecutor);
    const spec = controlledCollect().to_spec();
    // url 档 → 受控执行体
    const result = await executors.dispatch(null, spec, { url: 'https://example.com/x' });
    expect(result).toBe('{"ok": true, "source": "url"}');
    expect(calls).toEqual(['cf:https://example.com/x']);
    // file/text 档 → mcp 端点执行体（回落 exec 原路径）
    const textResult = await executors.dispatch(null, spec, { text: '素材' });
    expect(textResult).toBe('mcp-ok');
    expect(calls[1]).toBe('mcp:素材');
  });

  it('受控取回执行体未注册：url 档显式拒绝（不静默回落 mcp/exec）', async () => {
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(controlledCollect());
    const calls: string[] = [];

    const mcpExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push('mcp');
      return 'should-not-run';
    };
    executors.register(EndpointType.MCP, mcpExecutor);
    const spec = controlledCollect().to_spec();
    await expect(executors.dispatch(null, spec, { url: 'https://example.com/x' })).rejects.toThrow(
      '受控取回执行体未注册',
    );
    expect(calls).toEqual([]);
    expect(executors._executors.has(RETRIEVAL_CONTROLLED_FETCH)).toBe(false);
  });
});
