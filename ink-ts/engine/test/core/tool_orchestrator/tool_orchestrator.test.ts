/**
 * 工具调配器对标测试：候选打分/去重/门槛/预算截断 + 轨迹存储/查询过滤
 * （对标 pytest test_tool_orchestrator.py 语义检查点：工具集 = 带元数据的
 * 候选池；确定性选取零 LLM 调用；工具调用轨迹 = 经验闭环的原始信号，
 * append-only，可按工具/成败过滤）。
 *
 * Deferred（沿用 Python 侧未覆盖或需宿主能力的项，待接线后补）：
 * - 真实存储（sqlite/postgres 宿主实现）——memory_storage fixture 以内存
 *   假存储直测 records 通道 seam 契约；
 * - 执行器/工具执行体接线（引擎侧执行 tool 调用的集成路径）。
 */

import { describe, expect, it } from 'vitest';

import { ToolSpec } from '../../../src/core/llm/tools.js';
import { DEFAULT_UUID_HEX } from '../../../src/core/tool_orchestrator/_types.js';
import type {
  ToolMatchStrategy,
  TraceRecordsStore,
} from '../../../src/core/tool_orchestrator/_types.js';
import {
  ToolCandidate,
  ToolSelector,
  ToolTrace,
  ToolTraceStore,
  WeightedToolScorer,
} from '../../../src/core/tool_orchestrator/tool_orchestrator.js';

function spec(name: string): ToolSpec {
  return new ToolSpec({ name, description: `${name} 工具`, parameters: {} });
}

/** 内存假存储（对标 pytest memory_storage fixture）：records 通道全量记录。 */
class MemRecordsStore implements TraceRecordsStore {
  readonly buckets = new Map<string, Map<string, Record<string, unknown>>>();

  async put_record(
    collection: string,
    key: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    let bucket = this.buckets.get(collection);
    if (bucket === undefined) {
      bucket = new Map();
      this.buckets.set(collection, bucket);
    }
    bucket.set(key, JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  }

  async list_records(collection: string): Promise<Record<string, unknown>[]> {
    const bucket = this.buckets.get(collection);
    if (bucket === undefined) return [];
    return [...bucket.values()];
  }
}

/** 顺序自增 uuid 注入（seam 使然：多轨迹记录须 id 各异才互不覆盖）。 */
function seq_uuid(): () => string {
  let n = 0;
  return () => `test-uuid-${n++}`;
}

describe('ToolSpec 数据往返', () => {
  it('序列化/还原：参数 schema 与权限声明无损，未知键容忍', () => {
    const src = new ToolSpec({
      name: 'write_file',
      description: '写文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      permissions: ['filesystem:write:/book/**'],
    });
    const rebuilt = ToolSpec.from_dict(src.to_dict());
    expect(rebuilt.name).toBe('write_file');
    expect(rebuilt.description).toBe('写文件');
    const properties = (
      rebuilt.parameters as { properties: Record<string, { type: string }> }
    ).properties;
    expect(properties['path']?.type).toBe('string');
    expect(rebuilt.permissions).toEqual(['filesystem:write:/book/**']);
    expect(ToolSpec.from_dict({ name: 'x', future: 1 }).name).toBe('x');
  });
});

describe('ToolCandidate 校验', () => {
  it('负权重/越界相关度 → 拒绝（配置错误声明期暴露）', () => {
    expect(() => new ToolCandidate({ spec: spec('a'), weight: -1 })).toThrow(/权重/);
    expect(() => new ToolCandidate({ spec: spec('a'), relevance: 1.5 })).toThrow(/相关度/);
  });
});

describe('WeightedToolScorer 调配语义', () => {
  it('调配分排序 + 预算截断：高分入选、超预算截断', () => {
    const scorer = new WeightedToolScorer();
    const candidates = [
      new ToolCandidate({ spec: spec('low'), weight: 1.0, relevance: 0.2 }),
      new ToolCandidate({ spec: spec('high'), weight: 2.0, relevance: 0.9 }),
      new ToolCandidate({ spec: spec('mid'), weight: 1.0, relevance: 0.6 }),
    ];
    const selected = scorer.select(candidates, 2);
    expect(selected.map((s) => s.name)).toEqual(['high', 'mid']);
  });

  it('门槛丢弃：调配分低于下限 = 近似噪音，不入选', () => {
    const scorer = new WeightedToolScorer({ min_score: 0.5 });
    const candidates = [
      new ToolCandidate({ spec: spec('noise'), weight: 1.0, relevance: 0.1 }),
      new ToolCandidate({ spec: spec('good'), weight: 1.0, relevance: 0.9 }),
    ];
    expect(scorer.select(candidates, 10).map((s) => s.name)).toEqual(['good']);
  });

  it('同名去重：同工具重复注册取调配分最高者（平局保留先注册）', () => {
    const scorer = new WeightedToolScorer();
    const candidates = [
      new ToolCandidate({ spec: spec('dup'), weight: 1.0, relevance: 0.3 }),
      new ToolCandidate({ spec: spec('dup'), weight: 1.0, relevance: 0.9 }),
    ];
    const selected = scorer.select(candidates, 10);
    expect(selected.length).toBe(1);
    expect(selected[0]?.name).toBe('dup');
    expect(selected[0]?.description).toBe('dup 工具');
  });

  it('预算硬上界：0 = 空集，负预算拒绝，超量截断', () => {
    const scorer = new WeightedToolScorer();
    const candidates = Array.from(
      { length: 10 },
      (_, i) => new ToolCandidate({ spec: spec(`t${i}`), relevance: 1.0 }),
    );
    expect(scorer.select(candidates, 0)).toEqual([]);
    expect(() => scorer.select(candidates, -1)).toThrow(/预算/);
    expect(scorer.select(candidates, 3).length).toBe(3);
  });
});

describe('ToolSelector 门面', () => {
  it('缺省预算取构造值（成本护栏配置化）', () => {
    const selector = new ToolSelector({ max_tools: 2 });
    const candidates = Array.from(
      { length: 5 },
      (_, i) => new ToolCandidate({ spec: spec(`t${i}`), relevance: 1.0 }),
    );
    expect(selector.select(candidates).length).toBe(2);
    expect(selector.max_tools).toBe(2);
  });

  it('保底工具加成：基线名 priority+10 / weight×2 优先入选', () => {
    const selector = new ToolSelector({ baseline_names: ['a'] });
    const candidates = [
      new ToolCandidate({ spec: spec('a'), weight: 0.5, relevance: 1.0 }),
      new ToolCandidate({ spec: spec('b'), weight: 0.9, relevance: 1.0 }),
    ];
    expect(selector.select(candidates, 1)[0]?.name).toBe('a');
  });

  it('匹配策略注入：基线加成后、最终排序前介入，换策略不改装配', () => {
    const boost_a: ToolMatchStrategy = {
      apply: (candidates) =>
        candidates.map((c) =>
          c.spec.name === 'a'
            ? new ToolCandidate({
                spec: c.spec,
                relevance: 1.0,
                weight: c.weight,
                priority: c.priority + 1,
              })
            : c,
        ),
    };
    const selector = new ToolSelector({ match_strategy: boost_a });
    const candidates = [
      new ToolCandidate({ spec: spec('a'), weight: 1.0, relevance: 0.4 }),
      new ToolCandidate({ spec: spec('b'), weight: 1.0, relevance: 0.6 }),
    ];
    expect(selector.select(candidates, 1)[0]?.name).toBe('a');
  });
});

describe('ToolTrace 序列化', () => {
  it('from_dict 缺省兜底（ok=true / decision=allow / 空 args / now=0）', () => {
    const trace = ToolTrace.from_dict({ tool: 'x' });
    expect(trace.ok).toBe(true);
    expect(trace.decision).toBe('allow');
    expect(trace.args).toEqual({});
    expect(trace.error).toBeNull();
    expect(trace.duration_ms).toBe(0);
    expect(trace.thread_id).toBe('-');
    expect(trace.created_at).toBe(0);
    expect(trace.id).toBeNull();
  });

  it('to_dict/from_dict 往返：字段完整（持久化契约）', () => {
    const full = new ToolTrace({
      tool: 'fetch',
      ok: false,
      decision: 'deny',
      args: { url: 'https://example.com' },
      error: '域名不在白名单',
      duration_ms: 3.5,
      thread_id: 't-1',
      created_at: 100,
      id: 'fetch:abc',
    });
    expect(ToolTrace.from_dict(full.to_dict())).toEqual(full);
  });

  it('时间 seam：created_at 缺省取时钟（未注入 now=0）', () => {
    expect(new ToolTrace({ tool: 'x' }).created_at).toBe(0);
    expect(new ToolTrace({ tool: 'x', clock: { now: () => 42 } }).created_at).toBe(42);
  });
});

describe('ToolTraceStore 轨迹存储', () => {
  it('追加/按工具过滤/按成败过滤/时间倒序', async () => {
    const store = new ToolTraceStore(new MemRecordsStore(), { uuid: seq_uuid() });
    await store.record(new ToolTrace({ tool: 'write', ok: true, duration_ms: 10.0 }));
    await store.record(new ToolTrace({ tool: 'write', ok: false, error: '权限拒绝' }));
    await store.record(new ToolTrace({ tool: 'read', ok: true, duration_ms: 5.0 }));

    expect((await store.list()).length).toBe(3);
    expect((await store.list({ tool: 'write' })).length).toBe(2);
    const failed = await store.list({ tool: 'write', ok: false });
    expect(failed.length).toBe(1);
    expect(failed[0]?.error).toBe('权限拒绝');
    expect((await store.list({ tool: 'read', ok: true })).length).toBe(1);
    expect((await store.list({ limit: 2 })).length).toBe(2);
  });

  it('轨迹数据往返：字段完整（持久化契约）', async () => {
    const store = new ToolTraceStore(new MemRecordsStore(), { uuid: seq_uuid() });
    const trace = new ToolTrace({
      tool: 'fetch',
      ok: false,
      decision: 'deny',
      args: { url: 'https://example.com' },
      error: '域名不在白名单',
    });
    const trace_id = await store.record(trace);
    const traces = await store.list({ tool: 'fetch' });
    expect(traces[0]?.id).toBe(trace_id);
    expect(traces[0]?.decision).toBe('deny');
    expect(traces[0]?.ok).toBe(false);
    expect(traces[0]?.error).toBe('域名不在白名单');
    expect(traces[0]?.args).toEqual({ url: 'https://example.com' });
  });

  it('落库前参数脱敏：凭据键不得随轨迹持久化（strip_sensitive 清洗）', async () => {
    const store = new ToolTraceStore(new MemRecordsStore(), { uuid: seq_uuid() });
    await store.record(
      new ToolTrace({ tool: 'fetch', args: { url: 'https://example.com', api_key: 'sk-123' } }),
    );
    const traces = await store.list({ tool: 'fetch' });
    expect(traces[0]?.args).toEqual({ url: 'https://example.com', api_key: '' });
  });

  it('uuid seam 缺省确定值：未注入时同 id 覆写 = 补录（幂等安全）', async () => {
    const store = new ToolTraceStore(new MemRecordsStore());
    const id1 = await store.record(new ToolTrace({ tool: 'write' }));
    const id2 = await store.record(new ToolTrace({ tool: 'write', ok: false }));
    expect(id1).toBe(`write:${DEFAULT_UUID_HEX}`);
    expect(id2).toBe(id1);
    expect((await store.list()).length).toBe(1);
    expect((await store.list())[0]?.ok).toBe(false);
  });
});