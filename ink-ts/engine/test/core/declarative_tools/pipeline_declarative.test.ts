/**
 * 声明式工具完整流水线（声明式装配路径）单测——对标 ink_engine/tests/
 * test_declarative_tools.py 的流水线机制用例，逐条同名同义移植。
 *
 * 语义检查点：声明式工具经桥走完整流水线（登记 → 推导 → 门禁 → 沙箱
 * → 分发执行 → 审计 → 轨迹）；判定目标推导失败（非法/缺参）与「未配置
 * 提取器」同语义 fail-closed 拒绝（allow_unchecked=False，不直通执行）；
 * 未注入门禁 = 默认拒绝策略兜底（权限未命中不得直通执行）。
 *
 * 延后用例：真实子进程/文件系统 IO 与存储落库（ToolTraceStore/memory_
 * storage fixture）属宿主 seam——本文件以内存数组收轨迹、纯词法沙箱
 * 验证机制环节；FileSandbox/ProcessSandbox 的真实路径解析/进程执行
 * 随 sandbox 模块移植回归。
 */
import { describe, expect, it } from 'vitest';

import { PermissionGate } from '../../../src/core/permissions/permissions.js';
import { ProcessSandbox } from '../../../src/core/sandbox/index.js';
import { ToolPipeline } from '../../../src/core/tool_pipeline/tool_pipeline.js';
import {
  DeclarativeToolExecutors,
  DeclarativeToolSpec,
  EndpointType,
  build_declarative_pipeline,
  endpoint_operation,
} from '../../../src/core/declarative_tools/index.js';

/** 鸭子类型节点上下文：emit 收集 tool_audit 事件供断言（对齐 Python Ctx）。 */
class EmitCtx {
  readonly events: Array<[string, Record<string, unknown>]> = [];

  async emit(etype: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push([etype, payload]);
  }
}

/** 声明式定义构建（对齐 Python 测试 _declarative 辅助）。 */
function declarative(
  endpoint: string = EndpointType.HTTP_FETCH,
  overrides: Partial<{
    name: string;
    parameters: Record<string, unknown>;
    permissions: readonly string[];
    endpoint_config: Record<string, unknown>;
  }> = {},
): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    name: 'mytool',
    description: '声明式工具',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    permissions: ['network:connect:*.example.com'],
    endpoint,
    ...overrides,
  });
}

describe('声明式工具完整流水线', () => {
  it('操作推导 → 门禁 → 沙箱 → 执行 → 审计 → 轨迹（权限未命中留失败轨迹）', async () => {
    const definition = new DeclarativeToolSpec({
      name: 'mytool',
      description: '声明式工具',
      parameters: { type: 'object' },
      permissions: ['process:exec:git'],
      endpoint: EndpointType.PROCESS_EXEC,
      endpoint_config: { allowlist: ['git'] },
    });
    const spec = definition.to_spec();
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const processExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      return 'git status';
    };
    executors.register(EndpointType.PROCESS_EXEC, processExecutor);
    const traces: unknown[] = [];
    const pipeline = new ToolPipeline({
      gate: new PermissionGate(),
      extractor: (specIn, argsIn) => endpoint_operation(definition.endpoint, argsIn),
      sandboxes: [new ProcessSandbox(['git'], 30.0, null, undefined, null, '/dummy')],
      executor: executors.dispatch.bind(executors),
      trace_sink: (trace) => {
        traces.push(trace);
      },
    });

    const result = await pipeline.execute(new EmitCtx(), spec, { command: 'git', args: ['status'] });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('git status');
    expect(traces.length).toBe(1);
    expect((traces[0] as { ok: boolean }).ok).toBe(true);

    // 权限未命中（命令不在权限声明内）→ fail-closed 拒绝 + 失败轨迹
    const denied = await pipeline.execute(new EmitCtx(), spec, { command: 'rm' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('deny');
    expect(traces.length).toBe(2);
    expect((traces[1] as { ok: boolean }).ok).toBe(false);
  });

  it('判定目标推导失败（非法/缺参）→ fail-closed 拒绝（不触碰执行体）', async () => {
    // 回归：修复前 extractor 返回 null 时门禁与沙箱整段跳过、仍执行
    // executor——受沙箱守卫的端点可绕过越界操作；现在与「未配置提取器」
    // 同语义拒绝。
    const definition = new DeclarativeToolSpec({
      name: 'mytool',
      description: '声明式工具',
      parameters: { type: 'object' },
      permissions: ['process:exec:git'],
      endpoint: EndpointType.PROCESS_EXEC,
      endpoint_config: { allowlist: ['git'], path: '/dummy' },
    });
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const processExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      throw new Error('不应执行：目标不可判定必须被门禁拦截');
    };
    executors.register(EndpointType.PROCESS_EXEC, processExecutor);
    const pipeline = build_declarative_pipeline(executors, {
      gate: null,
      sandboxes: [new ProcessSandbox(['git'])],
    });

    // 缺 command（process_exec 目标推导失败）→ 拒绝且执行体未被调用
    const spec = definition.to_spec();
    const result = await pipeline.execute(new EmitCtx(), spec, {});
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.error).toContain('无法判定目标');
    // fail-closed 文案携带结构化原因（指引模型自我纠正）
    expect(result.error).toContain('command');
  });

  it('引擎侧桥装配：声明式工具经桥走完整流水线（登记 → 推导 → 分发）', async () => {
    // 回归：修复前声明式工具无生产接线（to_spec 丢端点、定义不登记），
    // 桥补齐 extractor/executor 后同一注册表即可执行。
    const definition = new DeclarativeToolSpec({
      name: 'mytool',
      description: '声明式工具',
      parameters: { type: 'object' },
      permissions: ['process:exec:git'],
      endpoint: EndpointType.PROCESS_EXEC,
      endpoint_config: { allowlist: ['git'], path: '/dummy' },
    });
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const processExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      return 'ok';
    };
    executors.register(EndpointType.PROCESS_EXEC, processExecutor);
    const traces: unknown[] = [];
    const pipeline = build_declarative_pipeline(executors, {
      gate: new PermissionGate(),
      sandboxes: [],
      trace_sink: (trace) => {
        traces.push(trace);
      },
    });

    const spec = definition.to_spec();
    const result = await pipeline.execute(new EmitCtx(), spec, { command: 'git' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('ok');
    expect(traces.length).toBe(1);
    expect((traces[0] as { ok: boolean }).ok).toBe(true);
  });

  it('未注入门禁时按默认拒绝策略兜底：权限未命中的调用不得直通执行', async () => {
    const definition = declarative(); // http_fetch，权限 network:connect:*.example.com
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const calls: string[] = [];
    const httpExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push(String(args['url']));
      return 'body';
    };
    executors.register(EndpointType.HTTP_FETCH, httpExecutor);
    const pipeline = build_declarative_pipeline(executors); // 不传 gate

    const spec = definition.to_spec();
    // 权限声明命中白名单 → 放行
    const allowed = await pipeline.execute(new EmitCtx(), spec, { url: 'https://api.example.com/v1' });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual(['https://api.example.com/v1']);
    // 未命中域名 → 默认门禁拒绝（修复前 gate=None 会直通执行）
    const denied = await pipeline.execute(new EmitCtx(), spec, { url: 'https://evil.com/x' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('deny');
    expect(calls).toEqual(['https://api.example.com/v1']);
  });
});
