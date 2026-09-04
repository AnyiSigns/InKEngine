/**
 * 自指层观察原语单测：内省元工具流水线（权限门禁 + 敏感键剥离 + 审计留痕）
 * （对标 Python test_introspection.py 流水线段）。
 *
 * 覆盖：流水线执行返回 JSON 快照、快照出口统一剥离敏感键（api_key/token/
 * secret…，观察通道与落库通道同规格）、未声明权限拒绝（fail-closed）、
 * 审计留痕（成功与拒绝都经 audit 通道记录）、未知工具名拒绝。
 *
 * 延后（defer）：引擎/运行时集成用例——introspection 是对运行时对象
 * 反射，TS 侧以 seam/注册表映射表达（不反射 JS 对象）；把内省工具接入
 * 引擎运行时工具表、经真跑图执行体整链调用的用例待引擎运行时接线后补
 * （随 tool_pipeline / tool_index 先例，本套件只验证 seam 契约）。
 */
import { describe, expect, it } from 'vitest';

import {
  build_introspection_pipeline,
  INTROSPECTION_PERMISSION,
  introspection_tool_specs,
} from '../../../src/core/introspection/index.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import type { AuditSink } from '../../../src/core/tool_pipeline/_types.js';
import { DENY } from '../../../src/core/tool_pipeline/tool_pipeline.js';
import { data_graph, make_service } from './helpers.js';

/** 鸭子类型节点上下文：emit 无操作（TS ToolPipeline 缺省审计经 ctx.emit
 *  发 tool_audit 事件，Python 侧传 None ctx 在 TS 侧以 emit 钩子表达）。 */
const noop_ctx = {
  emit: async (_etype: string, _payload: Record<string, unknown>): Promise<void> => undefined,
};

describe('内省流水线执行', () => {
  it('只读判定直过：执行返回 JSON 快照（图名可解析）', async () => {
    const service = make_service({ graph: data_graph() });
    const pipeline = build_introspection_pipeline(service);
    const spec = introspection_tool_specs()[0]!;
    const result = await pipeline.execute(noop_ctx, spec, {});
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('allow');
    const data = JSON.parse(result.output) as { graph: { name: string } };
    expect(data.graph.name).toBe('intro');
  });

  it('快照出口统一剥离敏感键：凭据不进入模型上下文', async () => {
    const graph = data_graph();
    graph.add_node_type('llm', 'llm', { api_key: 'sk-LIVE-SECRET', model_id: 'm1' });
    const service = make_service({ graph });
    const pipeline = build_introspection_pipeline(service);
    const result = await pipeline.execute(noop_ctx, introspection_tool_specs()[0]!, {});
    expect(result.ok).toBe(true);
    const output = JSON.parse(result.output) as {
      graph: { nodes: Record<string, { config: Record<string, unknown> }> };
    };
    const config = output.graph.nodes['llm']!.config;
    expect(config['api_key']).toBe('');
    expect(result.output).not.toContain('sk-LIVE-SECRET');
  });

  it('未声明内省权限的工具经同一流水线被拒绝（fail-closed）', async () => {
    const service = make_service({ graph: data_graph() });
    const pipeline = build_introspection_pipeline(service);
    const bare = new ToolSpec({
      name: 'inspect_graph',
      description: '无权限声明',
      parameters: {},
    });
    const result = await pipeline.execute(noop_ctx, bare, {});
    expect(result.ok).toBe(false);
    expect(result.decision).toBe(DENY);
  });

  it('审计留痕：成功调用与拒绝调用都经 audit 通道记录', async () => {
    const service = make_service({ graph: data_graph() });
    const pipeline = build_introspection_pipeline(service);
    const records: string[] = [];
    // TS ToolPipeline.audit 为构造注入的只读 seam；测试沿用 Python 侧
    // 装配后覆写 audit 的语义，经类型擦除后的运行期覆写注入记录钩子
    (pipeline as unknown as { audit: AuditSink | null }).audit = (_ctx, record) => {
      records.push(String(record['decision']));
    };
    const ok_spec = introspection_tool_specs()[0]!;
    await pipeline.execute(noop_ctx, ok_spec, {});
    const deny_spec = new ToolSpec({
      name: 'inspect_graph',
      description: '无权限声明',
      parameters: {},
    });
    await pipeline.execute(noop_ctx, deny_spec, {});
    expect(records).toEqual(['ok', 'deny']);
  });

  it('未知内省工具：执行期显式拒绝（错误文案携带原因）', async () => {
    const service = make_service({ graph: data_graph() });
    const pipeline = build_introspection_pipeline(service);
    const spec = new ToolSpec({
      name: 'inspect_nothing',
      description: '未知工具',
      parameters: {},
      permissions: [INTROSPECTION_PERMISSION],
    });
    const result = await pipeline.execute(noop_ctx, spec, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未知内省工具');
  });
});
