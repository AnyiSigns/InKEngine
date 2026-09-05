// gate: 超限(415 行) - 网络策略流水线用例共享同一组接线条断言，拆文件降低整链回归可读性
/**
 * 声明式工具流水线的网络/沙箱/权限接线单测——对标 ink_engine/tests/
 * test_declarative_tools.py 的网络策略、自动沙箱接线、定义权限收口与
 * 轨迹脱敏用例，逐条同名同义移植。
 *
 * 语义检查点：network_policy 并入流水线——白名单 = 免审批快速路径，
 * 白名单外域名 review 档强制转审批（审批 accept 放行、reject 拒绝），
 * deny 档 fail-closed 硬拒；三类端点沙箱自动接线（process/file 从
 * endpoint_config 构造守卫并生效，越界/白名单外命令被拒）；门禁按定义
 * 声明权限判定（调用方伪造宽松 spec 不生效）；轨迹落库前参数脱敏。
 *
 * 延后用例：真实 tmp_path/子进程（test_auto_sandbox_uses_calling_tool_
 * own_definition 等）属宿主 IO——本文件以纯词法沙箱验证机制环节。
 */
import { describe, expect, it } from 'vitest';

import { PermissionGate } from '../../../src/core/permissions/permissions.js';
import { NetworkPolicy } from '../../../src/core/permissions/networkPolicy.js';
import { ProcessSandbox } from '../../../src/core/sandbox/index.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import {
  DeclarativeToolExecutors,
  DeclarativeToolSpec,
  EndpointType,
  build_declarative_pipeline,
} from '../../../src/core/declarative_tools/index.js';

/** 普通节点上下文：emit 收集（对齐 Python 的 emit-only Ctx）。 */
class EmitCtx {
  readonly events: Array<[string, Record<string, unknown>]> = [];

  async emit(etype: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push([etype, payload]);
  }
}

/** 审批卡上下文：未预设注入值 = 拒绝（fail-closed 兜底）。 */
class ApprovalCtx {
  private readonly injects: Map<string, unknown>;
  readonly cards: Array<[string, Record<string, unknown>]> = [];

  constructor(inject: Record<string, unknown> = {}) {
    this.injects = new Map(Object.entries(inject));
  }

  async interrupt(key: string, payload: Record<string, unknown>): Promise<unknown> {
    this.cards.push([key, payload]);
    if (this.injects.has(key)) {
      const value = this.injects.get(key);
      this.injects.delete(key);
      return value;
    }
    return 'reject';
  }

  async get_interrupt_payload(key: string): Promise<unknown> {
    return null;
  }

  async emit(): Promise<void> {}
}

/** 声明式定义构建（对齐 Python 测试 _declarative 辅助）。 */
function declarative(
  endpoint: string = EndpointType.HTTP_FETCH,
  overrides: Partial<{
    name: string;
    parameters: Record<string, unknown>;
    permissions: readonly string[];
    endpoint_config: Record<string, unknown>;
    network_policy: NetworkPolicy | null;
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

describe('network_policy 并网', () => {
  it('白名单 = 免审批快速路径；白名单外转审批（accept 放行/reject 拒绝）', async () => {
    // 审批即网关：非白名单域名强制挂卡，审批 accept 后放行、reject 后
    // 拒绝——不再 fail-closed 硬拒。
    const definition = declarative(EndpointType.HTTP_FETCH, {
      permissions: ['network:connect:*'], // 宽权限：域名收口归网络守卫/审批
    });
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
    const pipeline = build_declarative_pipeline(executors, {
      network_policy: new NetworkPolicy(['*.example.com']),
    });

    const spec = definition.to_spec();
    // 白名单域名 → 门禁放行、沙箱放行（免审批快速路径）
    const allowed = await pipeline.execute(new ApprovalCtx(), spec, { url: 'https://sub.example.com/a' });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/a']);
    // 非白名单域名 → 审批卡裁决（默认 reject → 拒绝，不执行）
    const ctx = new ApprovalCtx();
    const denied = await pipeline.execute(ctx, spec, { url: 'https://other.org/a' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('reject');
    expect(ctx.cards.length).toBeGreaterThan(0); // 非白名单域名必须挂审批卡
    expect(calls).toEqual(['https://sub.example.com/a']);
    // 审批 accept → 放行执行（审批即网关，白名单不再是执行期硬边界）
    const acceptCtx = new ApprovalCtx({ 'gate:mytool': { decision: 'accept' } });
    const accepted = await pipeline.execute(acceptCtx, spec, { url: 'https://other.org/a' });
    expect(accepted.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/a', 'https://other.org/a']);
    expect(acceptCtx.cards.length).toBeGreaterThan(0);
  });

  it('unlisted_policy=deny：白名单外域名保持 fail-closed 硬拒（收紧面）', async () => {
    const definition = declarative(EndpointType.HTTP_FETCH, {
      permissions: ['network:connect:*'], // 宽权限：沙箱层做域名收口
    });
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
    const pipeline = build_declarative_pipeline(executors, {
      network_policy: new NetworkPolicy(['*.example.com']),
      network_unlisted_policy: 'deny',
    });

    const spec = definition.to_spec();
    const allowed = await pipeline.execute(new EmitCtx(), spec, { url: 'https://sub.example.com/a' });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/a']);
    // 非白名单域名 → 沙箱硬拒（NetworkPolicySandbox 违规，权限层已放行）
    const denied = await pipeline.execute(new EmitCtx(), spec, { url: 'https://other.org/a' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('deny');
    expect(denied.error).toContain('域名不在白名单');
    expect(calls).toEqual(['https://sub.example.com/a']);
  });

  it('定义级 network_policy 自动消费：仅定义声明 allow_domains（无宿主策略）也逐工具生效', async () => {
    // 目标：工具声明自带 network_policy 时，无宿主 build 级配置同样获得守卫——
    // 名单内直过、名单外转审批（审批 accept 放行 / reject 拒绝）
    const definition = declarative(EndpointType.HTTP_FETCH, {
      permissions: ['network:connect:*'], // 宽权限：域名收口归定义级策略/审批
      network_policy: new NetworkPolicy(['*.example.com']),
    });
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
    // 关键：不传 network_policy（宿主级策略缺失）——策略只来自定义声明
    const pipeline = build_declarative_pipeline(executors);

    const spec = definition.to_spec();
    // 名单内 → 免审批直过
    const allowed = await pipeline.execute(new ApprovalCtx(), spec, { url: 'https://sub.example.com/a' });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/a']);
    // 名单外 → 强制挂审批卡（默认 reject → 拒绝且不执行）
    const ctx = new ApprovalCtx();
    const denied = await pipeline.execute(ctx, spec, { url: 'https://other.org/a' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('reject');
    expect(ctx.cards.length).toBeGreaterThan(0);
    expect(calls).toEqual(['https://sub.example.com/a']);
    // 审批 accept → 放行（审批即网关）
    const acceptCtx = new ApprovalCtx({ 'gate:mytool': { decision: 'accept' } });
    const accepted = await pipeline.execute(acceptCtx, spec, { url: 'https://other.org/a' });
    expect(accepted.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/a', 'https://other.org/a']);
  });

  it('定义级策略按工具隔离：未声明策略的并发工具不受他人定义策略约束', async () => {
    const executors = new DeclarativeToolExecutors();
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
    const withPolicy = declarative(EndpointType.HTTP_FETCH, {
      name: 'guarded_tool',
      permissions: ['network:connect:*'],
      network_policy: new NetworkPolicy(['*.example.com']),
    });
    const bareTool = declarative(EndpointType.HTTP_FETCH, {
      name: 'bare_tool',
      permissions: ['network:connect:*.open.org'],
    });
    executors.register_definition(withPolicy);
    executors.register_definition(bareTool);
    const pipeline = build_declarative_pipeline(executors);

    // 未声明定义级策略的工具按其权限判定放行（不受 guarded_tool 的策略约束）
    const ok = await pipeline.execute(new ApprovalCtx(), bareTool.to_spec(), {
      url: 'https://sub.open.org/x',
    });
    expect(ok.ok).toBe(true);
    expect(calls).toEqual(['https://sub.open.org/x']);
    // 带定义级策略的工具名单外域名挂卡（reject 拒绝）
    const ctx = new ApprovalCtx();
    const denied = await pipeline.execute(ctx, withPolicy.to_spec(), { url: 'https://other.org/a' });
    expect(denied.ok).toBe(false);
    expect(ctx.cards.length).toBeGreaterThan(0);
  });
});

describe('file_ops 检索操作流水线', () => {
  it('权限动作命中 → 沙箱边界解析 → 执行体分发；非法操作 fail-closed', async () => {
    // 全域检索（无 path）判定目标 = 根目录本身：权限模式含根目录条目
    // （filesystem:search:root|root/**）才放行——越界 path 由沙箱拒绝。
    const definition = new DeclarativeToolSpec({
      name: 'grep',
      description: '检索',
      parameters: {
        type: 'object',
        properties: { operation: { enum: ['search'] }, pattern: { type: 'string' } },
      },
      permissions: ['filesystem:search:/ws|/ws/**'],
      endpoint: EndpointType.FILE_OPS,
      endpoint_config: { root: '/ws' },
    });
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const calls: Array<Record<string, unknown>> = [];
    const fileExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push(args);
      return 'ok';
    };
    executors.register(EndpointType.FILE_OPS, fileExecutor);
    const pipeline = build_declarative_pipeline(executors);

    const spec = definition.to_spec();
    // 全域检索：目标回落根目录 → 权限命中 + 沙箱解析通过
    const allowed = await pipeline.execute(new EmitCtx(), spec, { operation: 'search', pattern: 'foo' });
    expect(allowed.ok).toBe(true);
    expect(calls[calls.length - 1]!['pattern']).toBe('foo');
    // 非法操作（chmod）→ 提取器无法判定目标 → fail-closed 拒绝
    const denied = await pipeline.execute(new EmitCtx(), spec, { operation: 'chmod', path: '/ws/x' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('deny');
    expect(denied.error).toContain('无法判定');
  });
});

describe('沙箱自动接线', () => {
  it('process/file 从 endpoint_config 构造守卫并生效（越界被拒）', async () => {
    const executors = new DeclarativeToolExecutors();
    const processDef = new DeclarativeToolSpec({
      name: 'runtool',
      description: '执行',
      parameters: { type: 'object' },
      permissions: ['process:exec:*'], // 宽权限：沙箱白名单做命令收口
      endpoint: EndpointType.PROCESS_EXEC,
      endpoint_config: { allowlist: ['git'], path: '/dummy' },
    });
    const fileDef = new DeclarativeToolSpec({
      name: 'fstool',
      description: '文件',
      parameters: { type: 'object' },
      permissions: ['filesystem:write:*'], // 宽权限：沙箱根目录做路径收口
      endpoint: EndpointType.FILE_OPS,
      endpoint_config: { root: '/book' },
    });
    executors.register_definition(processDef);
    executors.register_definition(fileDef);

    const processExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      return `exec:${String(args['command'])}`;
    };
    const fileExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      return `fs:${String(args['path'])}`;
    };
    executors.register(EndpointType.PROCESS_EXEC, processExecutor);
    executors.register(EndpointType.FILE_OPS, fileExecutor);
    const pipeline = build_declarative_pipeline(executors, { gate: null });

    // process_exec：白名单命令放行，白名单外命令被沙箱拒绝
    const ok = await pipeline.execute(new EmitCtx(), processDef.to_spec(), { command: 'git' });
    expect(ok.ok).toBe(true);
    expect(ok.output).toBe('exec:git');
    const denied = await pipeline.execute(new EmitCtx(), processDef.to_spec(), { command: 'rm' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('deny');
    expect(denied.error).toContain('命令不在白名单');

    // file_ops：根目录内放行，越界被沙箱拒绝（无需宿主手动注入沙箱）
    const fsOk = await pipeline.execute(new EmitCtx(), fileDef.to_spec(), {
      operation: 'write',
      path: '/book/ch1.md',
    });
    expect(fsOk.ok).toBe(true);
    expect(fsOk.output).toContain('ch1.md');
    const fsDenied = await pipeline.execute(new EmitCtx(), fileDef.to_spec(), {
      operation: 'write',
      path: '/etc/passwd',
    });
    expect(fsDenied.ok).toBe(false);
    expect(fsDenied.decision).toBe('deny');
    expect(fsDenied.error).toContain('路径越界');
  });
});

describe('定义权限收口', () => {
  it('门禁按定义声明权限判定：调用方伪造的宽松 spec 权限不生效', async () => {
    // 回归：修复前门禁消费 spec.permissions——构造 name 命中已登记定义、
    // 但权限更宽松的 ToolSpec 可绕过定义的白名单约束。
    const executors = new DeclarativeToolExecutors();
    const definition = declarative(EndpointType.HTTP_FETCH, {
      permissions: ['network:connect:*.example.com'],
    });
    executors.register_definition(definition);
    const httpExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      return 'body';
    };
    executors.register(EndpointType.HTTP_FETCH, httpExecutor);
    const pipeline = build_declarative_pipeline(executors);

    // 伪造宽松权限的 spec：定义只允许 *.example.com
    const forged = new ToolSpec({
      name: 'mytool',
      description: '伪造',
      parameters: {},
      permissions: ['network:connect:*'],
    });
    const allowed = await pipeline.execute(new EmitCtx(), forged, { url: 'https://api.example.com/v1' });
    expect(allowed.ok).toBe(true);
    const denied = await pipeline.execute(new EmitCtx(), forged, { url: 'https://evil.example.org/x' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('deny');
  });
});

describe('轨迹脱敏', () => {
  it('凭据类参数不随轨迹落库（strip_sensitive 纯函数，无敏感键零拷贝）', async () => {
    const definition = new DeclarativeToolSpec({
      name: 'mytool',
      description: '执行',
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
    const traces: Array<{ args: Record<string, unknown> }> = [];
    const pipeline = build_declarative_pipeline(executors, {
      gate: new PermissionGate(),
      trace_sink: (trace) => {
        traces.push(trace as { args: Record<string, unknown> });
      },
    });

    const spec = definition.to_spec();
    const result = await pipeline.execute(
      new EmitCtx(),
      spec,
      { command: 'git', api_key: 'sk-secret', keep: 1 },
    );
    expect(result.ok).toBe(true);
    expect(traces.length).toBe(1);
    expect(traces[0]!.args['api_key']).toBe('');
    expect(traces[0]!.args['keep']).toBe(1);
    expect(traces[0]!.args['command']).toBe('git');
  });
});
