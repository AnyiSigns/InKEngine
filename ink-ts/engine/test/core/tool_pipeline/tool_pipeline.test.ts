// gate: 超限(390 行) - 审批卡/轨迹脱敏集成用例沿用同一条断言装置，整链回归可读性优先
/**
 * 工具执行流水线本体单测（门禁/沙箱/守卫/审计/轨迹的机制环节）——逐点对标
 * ink_engine/tests/test_tool_pipeline.py。
 *
 * 语义检查点：
 * - 未配置操作提取器且未显式放宽 = 拒绝（fail-closed）；
 * - 权限门禁默认拒绝；显式放宽（default_policy=ALLOW）是明示安全让步；
 * - 沙箱校验结果回写执行参数（执行对象 = 校验对象，防二次拼接）；
 * - 守卫抛异常即拒绝；结果观察截断 + 溢出标记；
 * - 默认审计经 ctx.emit 发 tool_audit 事件；轨迹回调失败不阻断执行；
 * - auto 决议（策略直过）执行结果文本前缀标注；非直过工具仍挂卡。
 *
 * 延后用例：执行体/真实 IO 属宿主 seam——真实执行器实弹（FileSandbox/
 * ProcessSandbox 真实文件读写/进程执行）用例随 sandbox 模块移植后对标；
 * 本文件以纯逻辑假沙箱（FakeFileSandbox，语义对齐 FileSandbox 的解析与
 * 越界拒绝）与注入 lambda 执行体验证流水线机制环节，不触真实文件系统。
 */
import { describe, expect, it } from 'vitest';

import { ToolSpec } from '../../../src/core/llm/tools.js';
import { ALLOW, DENY, REVIEW, PermissionGate } from '../../../src/core/permissions/permissions.js';
import { SandboxViolation } from '../../../src/core/errors.js';
import { InterruptSignal } from '../../../src/core/interrupt/interrupt_types.js';
import { DefaultInterruptPolicy } from '../../../src/core/approval/approval.js';
import { ToolPipeline } from '../../../src/core/tool_pipeline/tool_pipeline.js';
import type { Executor, ToolResult } from '../../../src/core/tool_pipeline/_types.js';

/** FileSandbox 的纯逻辑假体（sandbox 模块未移植时的占位）：根前缀解析 +
 *  越界拒绝（SandboxViolation），操作域声明对齐 FS 操作；真实路径解析
 *  （Path.resolve/symlink 逃逸检测）随 sandbox 移植一并回归。 */
class FakeFileSandbox {
  static readonly FS_OPS = new Set(['read', 'write', 'delete', 'edit']);
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  guards_operation(operation: string): boolean {
    return FakeFileSandbox.FS_OPS.has(operation);
  }

  resolve(path: string): string {
    const joined = path.startsWith('/') ? path : `${this.root}/${path}`;
    if (joined.split('/').includes('..')) {
      throw new SandboxViolation(`路径越界: ${path}`);
    }
    return joined;
  }

  validate(operation: string, target: string): string {
    if (!FakeFileSandbox.FS_OPS.has(operation)) {
      throw new SandboxViolation(`不支持的 fs 操作: ${operation}`);
    }
    return this.resolve(target);
  }
}

/** 鸭子类型节点上下文：emit 收集 tool_audit 事件供断言。 */
class FakeCtx {
  readonly events: Array<[string, Record<string, unknown>]> = [];

  async emit(etype: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push([etype, payload]);
  }
}

function makeSpec(options: { name?: string } = {}): ToolSpec {
  return new ToolSpec({
    name: options.name ?? 't',
    description: '工具',
    parameters: {},
  });
}

/** 恒返回 'ok' 的执行体假体（多数用例共用；执行体属宿主 seam）。 */
const okExecutor: Executor = async () => 'ok';

/** 执行一次调用并转存审计事件（对齐 Python 测试的 _execute 辅助）。 */
async function runPipeline(
  pipeline: ToolPipeline,
  spec: ToolSpec,
  args: Record<string, unknown>,
  transport?: Array<[string, Record<string, unknown>]>,
): Promise<ToolResult> {
  const ctx = new FakeCtx();
  const result = await pipeline.execute(ctx, spec, args);
  if (transport !== undefined) transport.push(...ctx.events);
  return result;
}

describe('fail-closed 底线', () => {
  it('未配置操作提取器且未显式放宽 = 拒绝（不触碰执行体）', async () => {
    const calls: Array<Record<string, unknown>> = [];

    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<string> {
      calls.push(args);
      return 'ok';
    }

    const pipeline = new ToolPipeline({ executor });
    const result = await runPipeline(pipeline, makeSpec(), { x: 1 });
    expect(result.ok).toBe(false);
    expect(result.decision).toBe(DENY);
    expect(result.error).toContain('未配置操作提取器');
    expect(calls).toEqual([]);
  });

  it('提取器配置了但本次解析不出目标 = 拒绝（无法判定就不执行）', async () => {
    const calls: Array<Record<string, unknown>> = [];

    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<string> {
      calls.push(args);
      return 'ok';
    }

    const pipeline = new ToolPipeline({
      extractor: () => null, // 恒无判定目标
      executor,
    });
    const result = await runPipeline(pipeline, makeSpec(), {});
    expect(result.ok).toBe(false);
    expect(result.decision).toBe(DENY);
    expect(result.error).toContain('无法判定目标');
    expect(calls).toEqual([]);
  });
});

describe('权限门禁', () => {
  it('显式放宽（default_policy=ALLOW）才是明示安全让步', async () => {
    // 默认策略：未命中权限拒绝
    const strict = new ToolPipeline({
      gate: new PermissionGate(), // 默认 deny
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor: okExecutor,
    });
    const denied = await runPipeline(strict, makeSpec(), { command: 'rm' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe(DENY);

    // 显式放宽：未命中权限也放行（宿主明示让步）
    const relaxed = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor: okExecutor,
    });
    const allowed = await runPipeline(relaxed, makeSpec(), { command: 'rm' });
    expect(allowed.ok).toBe(true);
    expect(allowed.decision).toBe(ALLOW);
  });
});

describe('沙箱守卫', () => {
  it('沙箱校验结果回写执行参数（执行对象 = 校验对象，防二次拼接）', async () => {
    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<unknown> {
      return args['path'];
    }

    const sandbox = new FakeFileSandbox('/root');
    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['write', args['path'] as string],
      sandboxes: [sandbox],
      executor,
    });
    const result = await runPipeline(pipeline, makeSpec(), { path: 'sub/a.md' });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith(sandbox.resolve('sub/a.md'))).toBe(true);
  });

  it('沙箱违规（路径越界）→ 拒绝并留痕原因', async () => {
    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<string> {
      throw new Error('沙箱违规不应触达执行体');
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['write', args['path'] as string],
      sandboxes: [new FakeFileSandbox('/root')],
      executor,
    });
    const result = await runPipeline(pipeline, makeSpec(), { path: '../etc/passwd' });
    expect(result.ok).toBe(false);
    expect(result.decision).toBe(DENY);
    expect(result.error).toContain('路径越界');
  });
});

describe('单调守卫', () => {
  it('守卫抛异常即拒绝（fail-closed）', async () => {
    function guard(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): void {
      throw new Error('同一动作重复执行');
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['exec', args['command'] as string],
      guards: [guard],
      executor: okExecutor,
    });
    const result = await runPipeline(pipeline, makeSpec(), { command: 'git' });
    expect(result.ok).toBe(false);
    expect(result.decision).toBe(DENY);
    expect(result.error).toContain('同一动作重复执行');
  });
});

describe('结果观察', () => {
  it('超限截断 + 溢出标记（全量由宿主按 locator 取回）', async () => {
    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<string> {
      return 'x'.repeat(1000);
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor,
      max_result_chars: 100,
    });
    const result = await runPipeline(pipeline, makeSpec(), { command: 'git' });
    expect(result.ok).toBe(true);
    expect(result.overflow).toBe(true);
    expect(result.output).toBe('x'.repeat(100) + '\n…（溢出截断）');
  });
});

describe('审计与轨迹', () => {
  it('默认审计经 ctx.emit 发 tool_audit 事件（拒绝路径留痕）', async () => {
    const pipeline = new ToolPipeline({
      gate: new PermissionGate(), // 默认 deny（借拒绝路径验审计）
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor: okExecutor,
    });

    const ctx = new FakeCtx();
    const denied = await pipeline.execute(ctx, makeSpec(), { command: 'rm' });
    expect(denied.ok).toBe(false);
    expect(ctx.events.length).toBeGreaterThan(0);
    expect(ctx.events[0]![0]).toBe('tool_audit');
    expect(ctx.events[0]![1]['decision']).toBe('deny');
  });

  it('轨迹回调失败只忽略不阻断（观测不阻断执行）', async () => {
    function badSink(trace: unknown): void {
      throw new Error('轨迹落库失败');
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor: okExecutor,
      trace_sink: badSink,
    });
    const result = await runPipeline(pipeline, makeSpec(), { command: 'git' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('ok');
  });

  it('轨迹回调收到调用结果（成败/决议/耗时——经验闭环信号源）', async () => {
    const traces: unknown[] = [];

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor: okExecutor,
      trace_sink: (trace) => traces.push(trace),
    });
    const result = await runPipeline(pipeline, makeSpec(), { command: 'git' });
    expect(result.ok).toBe(true);
    expect(traces.length).toBe(1);
    const trace = traces[0] as { tool: string; ok: boolean; decision: string; duration_ms: number };
    expect(trace.tool).toBe('t');
    expect(trace.ok).toBe(true);
    expect(trace.decision).toBe(ALLOW);
    expect(trace.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('审批决议', () => {
  it('auto 决议（策略直过）执行结果前缀标注（审批语义可观测）', async () => {
    const calls: string[] = [];

    async function executor(
      ctx: unknown,
      spec: ToolSpec,
      args: Record<string, unknown>,
      approval: { decision: string } | null,
    ): Promise<string> {
      calls.push(String(approval?.decision));
      return 'done';
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(REVIEW),
      extractor: (spec, args) => ['write', args['path'] as string],
      executor,
      approval_policy: new DefaultInterruptPolicy(new Set(), new Set(['t'])),
    });
    const result = await runPipeline(pipeline, makeSpec(), { path: 'a.md' });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe(ALLOW);
    expect(result.approval).not.toBeNull();
    expect(result.approval?.decision).toBe('auto');
    expect(result.output.startsWith('【已自动批准执行】')).toBe(true);
    expect(result.output.endsWith('done')).toBe(true);
    expect(calls).toEqual(['auto']);
  });

  it('auto 直过即使执行输出为空也标注放行语义（模型不误判 interrupted）', async () => {
    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<null> {
      return null; // 执行成功但无输出
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(REVIEW),
      extractor: (spec, args) => ['write', args['path'] as string],
      executor,
      approval_policy: new DefaultInterruptPolicy(new Set(), new Set(['t'])),
    });
    const result = await runPipeline(pipeline, makeSpec(), { path: 'a.md' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('【已自动批准执行】');
  });

  it('非直过工具（review 未在 auto 名单）仍挂卡：auto 名单是明示让步', async () => {
    async function executor(ctx: unknown, spec: ToolSpec, args: Record<string, unknown>): Promise<string> {
      throw new Error('挂卡路径不应执行');
    }

    const pipeline = new ToolPipeline({
      gate: new PermissionGate(REVIEW),
      extractor: (spec, args) => ['write', args['path'] as string],
      executor,
      approval_policy: new DefaultInterruptPolicy(new Set(), new Set()), // 空名单
    });

    class HangingCtx {
      async interrupt(key: string, payload: Record<string, unknown>): Promise<never> {
        throw new InterruptSignal(key, payload);
      }
    }

    await expect(pipeline.execute(new HangingCtx(), makeSpec(), { path: 'a.md' })).rejects.toThrow(
      InterruptSignal,
    );
  });
});

describe('审批卡与轨迹值级脱敏', () => {
  it('审批卡负载：url 参数内嵌 query token 不扩散到卡面', async () => {
    const captured: Array<[string, Record<string, unknown>]> = [];
    const cardCtx = {
      async interrupt(key: string, payload: Record<string, unknown>): Promise<string> {
        captured.push([key, payload]);
        return 'reject';
      },
      async get_interrupt_payload(): Promise<unknown> {
        return null;
      },
      async emit(): Promise<void> {},
    };
    const pipeline = new ToolPipeline({
      gate: new PermissionGate(REVIEW), // 全部转审批 → 借拒绝路径验卡负载
      extractor: (spec, args) => ['write', args['path'] as string],
      executor: okExecutor,
    });
    const result = await pipeline.execute(cardCtx as never, makeSpec(), {
      path: 'a.md',
      url: 'https://host/p?token=sk-embed-9',
      body: '{"api_key":"sk-body"}',
    });
    expect(result.ok).toBe(false);
    expect(captured.length).toBeGreaterThan(0);
    const action = captured[0]![1]['action'] as Record<string, unknown>;
    const args = action['args'] as Record<string, unknown>;
    expect(args['url']).not.toContain('sk-embed-9');
    expect(args['body']).not.toContain('sk-body');
    expect(args['path']).toBe('a.md');
  });

  it('轨迹落库：字符串体内嵌凭据同样不随轨迹持久化', async () => {
    const traces: Array<{ args: Record<string, unknown> }> = [];
    const pipeline = new ToolPipeline({
      gate: new PermissionGate(ALLOW),
      extractor: (spec, args) => ['exec', args['command'] as string],
      executor: okExecutor,
      trace_sink: (trace) => traces.push(trace as { args: Record<string, unknown> }),
    });
    await pipeline.execute(new FakeCtx(), makeSpec(), {
      command: 'git',
      note: 'https://a.b?access_token=live-secret',
    });
    expect(traces.length).toBe(1);
    expect(traces[0]!.args['note']).not.toContain('live-secret');
    expect(traces[0]!.args['command']).toBe('git');
  });
});