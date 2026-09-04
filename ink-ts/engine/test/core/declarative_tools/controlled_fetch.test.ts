/**
 * collect_material url 档受控取回（meta.retrieval 单声明内拆）单测——
 * 对标 ink_engine/tests/test_declarative_tools.py 的受控取回用例
 * （桥接提取器推导/网络策略门禁/端点路径回落），逐条同名同义移植。
 *
 * 语义检查点：url 档判定目标 = 网络语义（connect/域名，http_fetch 同源
 * 推导，与端点类型正交）；file/text 档回落声明端点原路径（mcp call）——
 * 模式由声明标记驱动（无标记工具不受影响）；url 档网络策略（白名单
 * 命中直取回、白名单外强制转审批：reject 拒绝不执行、accept 放行执行）。
 *
 * 延后用例：make_controlled_fetch_executor 的流式字节截断/产物契约
 * （Python 侧 monkeypatch 假 httpx 覆盖）属真实网络执行体——TS core 零
 * IO，经 HttpStreamClient seam 注入，其流式用例随网络 seam 宿主实现
 * 回归；本文件只测无需 seam 的参数校验分支（url/text 二选一、协议收口）。
 */
import { describe, expect, it } from 'vitest';

import { NetworkPolicy } from '../../../src/core/permissions/networkPolicy.js';
import {
  DeclarativeToolExecutors,
  DeclarativeToolSpec,
  EndpointType,
  RETRIEVAL_CONTROLLED_FETCH,
  build_declarative_pipeline,
  make_controlled_fetch_executor,
  make_declarative_extractor,
  make_declarative_failure_reason,
} from '../../../src/core/declarative_tools/index.js';

/** collect_material 形态声明式定义（endpoint=mcp + 受控取回标记）。 */
function controlledCollect(
  overrides: Partial<{ network_policy: NetworkPolicy | null }> = {},
): DeclarativeToolSpec {
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
    network_policy: overrides.network_policy ?? null,
  });
}

/** 普通节点上下文（对齐 Python emit-only Ctx）。 */
class EmitCtx {
  async emit(): Promise<void> {}
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

describe('url 档桥接判定推导', () => {
  it('url 档判定目标 = 网络语义（connect/域名）；file/text 档回落 mcp', () => {
    const definition = controlledCollect();
    expect(definition.meta['retrieval']).toBe(RETRIEVAL_CONTROLLED_FETCH);
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const extractor = make_declarative_extractor(executors);
    const reason = make_declarative_failure_reason(executors);
    const spec = definition.to_spec();
    // url 档 → connect 域名（审批/审计挂 fetch 语义，工具名不变）
    expect(extractor(spec, { url: 'https://example.com/doc' })).toEqual(['connect', 'example.com']);
    expect(extractor(spec, { url: 'http://example.com/a', max_bytes: 64 })).toEqual([
      'connect',
      'example.com',
    ]);
    // file/text 档 → mcp call 原路径（零变化）
    expect(extractor(spec, { text: '素材' })).toEqual(['call', 'inkling_exec']);
    expect(extractor(spec, {})).toEqual(['call', 'inkling_exec']);
    // url 非法（非 http/https）→ 无法判定目标（fail-closed）+ 结构化原因
    expect(extractor(spec, { url: 'ftp://example.com/x' })).toBeNull();
    expect(reason(spec, { url: 'ftp://example.com/x' })).toContain('仅 http/https');
    expect(extractor(spec, { url: 'not-a-url' })).toBeNull();
  });
});

describe('url 档网络策略门禁', () => {
  it('allow_domains 命中直取回；白名单外强制转审批——reject 拒/accept 放行', async () => {
    const policy = new NetworkPolicy(['*.example.com']);
    const definition = controlledCollect({ network_policy: policy });
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const calls: string[] = [];
    const controlledExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push(String(args['url']));
      return '{"ok": true, "source": "url"}';
    };
    executors.register(RETRIEVAL_CONTROLLED_FETCH, controlledExecutor);
    const pipeline = build_declarative_pipeline(executors, { network_policy: policy });

    const spec = definition.to_spec();
    // allow_domains 命中 → 免审批直取回（网络快速路径）
    const allowed = await pipeline.execute(new ApprovalCtx(), spec, { url: 'https://sub.example.com/doc' });
    expect(allowed.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/doc']);
    // 白名单外域名 → 审批卡裁决：默认 reject → 拒绝且执行体未被调用
    const ctx = new ApprovalCtx();
    const denied = await pipeline.execute(ctx, spec, { url: 'https://other.org/doc' });
    expect(denied.ok).toBe(false);
    expect(denied.decision).toBe('reject');
    expect(ctx.cards.length).toBeGreaterThan(0);
    expect(ctx.cards[0]![0]).toBe('gate:collect_material');
    expect(calls).toEqual(['https://sub.example.com/doc']);
    // 审批 accept → 放行执行（审批即网关，approve 后取回）
    const acceptCtx = new ApprovalCtx({ 'gate:collect_material': { decision: 'accept' } });
    const accepted = await pipeline.execute(acceptCtx, spec, { url: 'https://other.org/doc' });
    expect(accepted.ok).toBe(true);
    expect(calls).toEqual(['https://sub.example.com/doc', 'https://other.org/doc']);
  });

  it('file/text 档回归：text 调用仍走 mcp 端点执行体（不经受控取回）', async () => {
    const definition = controlledCollect();
    const executors = new DeclarativeToolExecutors();
    executors.register_definition(definition);
    const calls: string[] = [];
    const mcpExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push('mcp');
      return 'mcp-ok';
    };
    const controlledExecutor = async (
      ctx: unknown,
      defn: DeclarativeToolSpec,
      args: Record<string, unknown>,
      approval: unknown,
    ): Promise<string> => {
      calls.push('cf');
      return 'cf-ok';
    };
    executors.register(EndpointType.MCP, mcpExecutor);
    executors.register(RETRIEVAL_CONTROLLED_FETCH, controlledExecutor);
    const pipeline = build_declarative_pipeline(executors);

    const spec = definition.to_spec();
    const result = await pipeline.execute(new EmitCtx(), spec, { text: '直接粘贴的素材' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('mcp-ok');
    expect(calls).toEqual(['mcp']);
  });
});

describe('受控取回执行体参数校验（无需网络 seam）', () => {
  it('缺 url / url 与 text 并存 / 非 http(s) 协议 → 显式报错', async () => {
    const executor = make_controlled_fetch_executor();
    const spec = controlledCollect();
    // 协议收口：仅 http/https（与 exec parse_url 同口径）
    await expect(executor(null, spec, { url: 'ftp://example.com/x' }, null)).rejects.toThrow('http(s)');
    // url 与 text 二选一（与 exec 同契约）
    await expect(executor(null, spec, { url: 'https://example.com/x', text: 'y' }, null)).rejects.toThrow(
      '二选一',
    );
    // 缺 url
    await expect(executor(null, spec, {}, null)).rejects.toThrow('缺 url');
  });
});
