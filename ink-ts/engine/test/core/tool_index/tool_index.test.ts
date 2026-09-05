// gate: 超限(380 行) - seam 收窄（同步直返）与降级可观测用例并入同一条检索语义断言装置
/**
 * 工具向量索引（search_tools 后端检索引擎）对标测试。
 *
 * 覆盖范围：构建/刷新/检索/降级/权限档判定/参数摘要。Python 端
 * ``engine-executor`` 路径走 Rust 嵌入层（host spawn bridge），TS 侧属宿主
 * 注入能力，本测试不模拟；改写需在 ``host`` 层做嵌入层接线。
 *
 * Deferred（待引擎执行体 seam 接入后再补）：
 * - ``test_uses_engine_embedder_when_available`` — Rust embedder.rs 桥接测试
 *   （需 host spawn + PYO3/进程 IPC，本测试仅验证 seam 契约）。
 */

import { describe, expect, it } from 'vitest';

import { ToolSpec } from '../../../src/core/llm/tools.js';
import { ToolVectorIndex } from '../../../src/core/tool_index/tool_index.js';
import { MAX_RESULTS } from '../../../src/core/tool_index/_types.js';
import type { AsyncEmbedder } from '../../../src/core/tool_index/_types.js';

function spec(name: string, description: string, parameters?: unknown): ToolSpec {
  return new ToolSpec({ name, description, parameters });
}

function fake_embedder(
  impl: (texts: readonly string[]) => readonly number[][],
): AsyncEmbedder {
  return {
    aembed_documents: (texts) => impl(texts),
    aembed_query: (q) => {
      const v = impl([q])[0] ?? [];
      return v;
    },
  };
}

describe('ToolVectorIndex / 构建与刷新', () => {
  it('build 全量构建条目，端点未登记走 declarative', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([
      spec('inspect_x', '查看内部状态'),
      spec('search_tools', '检索工具'),
      spec('read_file', '读文件'),
    ]);
    expect(idx.size()).toBe(3);
    expect(idx.has('inspect_x')).toBe(true);
    expect(idx.spec('read_file')?.name).toBe('read_file');
    expect(idx.uses_vectors()).toBe(false);
    expect(idx.all_specs().length).toBe(3);
  });

  it('build 端点映射生效；endpoints 缺省取 declarative', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([spec('a', 'A'), spec('b', 'B')], { a: 'mcp' });
    const ea = idx.entries.get('a');
    expect(ea?.endpoint).toBe('mcp');
    expect(idx.entries.get('b')?.endpoint).toBe('declarative');
  });

  it('refresh 未变更条目不重嵌（vector 复用）', () => {
    const embed = fake_embedder((texts) => texts.map(() => [0.1, 0.2, 0.3]));
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('a', 'A'), spec('b', 'B')]);
    const aVecBefore = idx.entries.get('a')?.vector;
    idx.refresh([spec('a', 'A'), spec('b', 'B')]);
    expect(idx.entries.get('a')?.vector).toEqual(aVecBefore);
    expect(idx.uses_vectors()).toBe(true);
  });

  it('refresh 新增条目重嵌；描述空走重嵌路径', () => {
    const calls: string[][] = [];
    const embed = fake_embedder((texts) => {
      calls.push([...texts]);
      return texts.map(() => [0.1, 0.2, 0.3]);
    });
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('a', 'A')]);
    expect(calls[0]?.length).toBe(1);
    idx.refresh([spec('a', 'A'), spec('b', 'B')]);
    expect(calls.length >= 2 && calls[1]?.length === 1).toBe(true);
    expect(idx.has('b')).toBe(true);
  });

  it('refresh 端点变更走重嵌（endpoints 表驱动）', () => {
    const calls: string[][] = [];
    const embed = fake_embedder((texts) => {
      calls.push([...texts]);
      return texts.map(() => [0.1, 0.2, 0.3]);
    });
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('a', 'A')], { a: 'declarative' });
    const before = calls.length;
    idx.refresh([spec('a', 'A')], { a: 'mcp' });
    expect(calls.length).toBe(before + 1);
    expect(idx.entries.get('a')?.endpoint).toBe('mcp');
  });
});

describe('ToolVectorIndex / 检索语义', () => {
  it('空 query / 空 entries → 返回空', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    expect(idx.search('')).toEqual([]);
    idx.build([spec('a', 'A')]);
    expect(idx.search('   ')).toEqual([]);
  });

  it('关键词基线：子串命中加分 + token 命中密度', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([
      spec('read_file', '读文件内容'),
      spec('inspect_state', '检查内部状态'),
      spec('propose_patch', '提案补丁'),
    ]);
    const res = idx.search('file');
    expect(res[0]?.name).toBe('read_file');
    expect(res[0]?.score).toBeGreaterThan(0);
  });

  it('中文逐字 token + 子串匹配命中', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([
      spec('read_file', '读取文件内容'),
      spec('inspect_state', '检查内部状态'),
    ]);
    const res = idx.search('读取');
    expect(res.length).toBeGreaterThan(0);
    expect(res[0]?.name).toBe('read_file');
  });

  it('向量检索：query 与条目向量余弦排序', () => {
    const embed = fake_embedder((texts) =>
      texts.map((t) => {
        if (t.includes('read')) return [1, 0, 0];
        if (t.includes('inspect')) return [0, 1, 0];
        return [0.1, 0.1, 0.1];
      }),
    );
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([
      spec('read_file', '读取文件'),
      spec('inspect_state', '检查状态'),
      spec('propose_patch', '提案补丁'),
    ]);
    const res = idx.search('read_file');
    expect(res[0]?.name).toBe('read_file');
    expect(res[0]?.score).toBeGreaterThan(0);
  });

  it('query 嵌入失败 → 回落关键词基线', () => {
    const embed: AsyncEmbedder = {
      aembed_documents: (texts) => texts.map(() => [0, 0, 0]),
      aembed_query: () => {
        throw new Error('model missing');
      },
    };
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('read_file', '读文件'), spec('inspect_state', '检查')]);
    const res = idx.search('read');
    expect(res[0]?.name).toBe('read_file');
  });

  it('向量检索 score > 0 才返回（score 0 截断）', () => {
    const embed = fake_embedder((texts) =>
      texts.map(() => [0, 0, 0]),
    );
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('a', 'A'), spec('b', 'B')]);
    const res = idx.search('a');
    for (const r of res) expect(r.score).toBeGreaterThan(0);
  });

  it('limit 默认 8 且不超 MAX_RESULTS', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    const items: ToolSpec[] = [];
    for (let i = 0; i < 20; i++) items.push(spec(`t_${i}`, `描述 ${i}`));
    idx.build(items);
    const res = idx.search('描述');
    expect(res.length).toBeLessThanOrEqual(MAX_RESULTS);
  });

  it('自定义 limit 截断', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    const items: ToolSpec[] = [];
    for (let i = 0; i < 5; i++) items.push(spec(`t_${i}`, `描述 ${i}`));
    idx.build(items);
    expect(idx.search('描述', 2).length).toBe(2);
  });
});

describe('ToolVectorIndex / 降级与契约', () => {
  it('embedder=null 走纯关键词基线', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([spec('a', 'A')]);
    expect(idx.uses_vectors()).toBe(false);
    const res = idx.search('A');
    expect(res.length).toBeGreaterThan(0);
  });

  it('嵌入全失败（vectors=null）→ vectors_built=false', () => {
    const embed = fake_embedder(() => []);
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('a', 'A')]);
    expect(idx.uses_vectors()).toBe(false);
    const res = idx.search('A');
    expect(res.length).toBeGreaterThan(0);
  });

  it('关键词检索永不明返回空（无命中也走空数组而非抛错）', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([spec('a', 'A')]);
    expect(idx.search('完全无关的内容 xyz123')).toEqual([]);
  });
});

describe('ToolVectorIndex / 权限档与参数摘要', () => {
  it('inspect_ 前缀走 allow', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([spec('inspect_x', 'X')]);
    expect(idx.entries.get('inspect_x')?.tier).toBe('allow');
  });

  it('self 工具白名单走 allow', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([
      spec('propose_patch', 'P'),
      spec('apply_patch', 'A'),
      spec('revert_patch', 'R'),
      spec('propose_domain_manifest', 'D'),
      spec('search_tools', 'S'),
      spec('request_tool', 'Q'),
    ]);
    for (const n of [
      'propose_patch',
      'apply_patch',
      'revert_patch',
      'propose_domain_manifest',
      'search_tools',
      'request_tool',
    ]) {
      expect(idx.entries.get(n)?.tier).toBe('allow');
    }
  });

  it('声明式默认走 review', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([spec('read_file', 'R'), spec('inspect_x', 'X')]);
    expect(idx.entries.get('read_file')?.tier).toBe('review');
  });

  it('parameters_summary：必填 / 可选 / 无参数', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([
      spec('a', 'A', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      }),
      spec('b', 'B', {
        type: 'object',
        properties: { x: {}, z: {}, w: {}, q: {} },
      }),
      spec('c', 'C', { type: 'object', properties: {} }),
      spec('d', 'D', null),
      spec('e', 'E'),
    ]);
    const res = idx.search('A B C D E');
    const byName: Record<string, string> = {};
    for (const r of res) byName[r.name] = r.parameters_summary;
    expect(byName['a']).toBe('必填: path');
    expect(byName['b']).toBe('可选: x/z/w/q');
    expect(byName['c']).toBe('无参数');
    expect(byName['d']).toBe('无参数');
    expect(byName['e']).toBe('无参数');
  });
});

describe('ToolVectorIndex / 接口契约', () => {
  it('has / spec / all_specs / size / uses_vectors 正常', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([spec('a', 'A'), spec('b', 'B')]);
    expect(idx.has('a')).toBe(true);
    expect(idx.has('z')).toBe(false);
    expect(idx.spec('a')?.name).toBe('a');
    expect(idx.spec('z')).toBeNull();
    expect(idx.all_specs().length).toBe(2);
    expect(idx.size()).toBe(2);
    expect(idx.uses_vectors()).toBe(false);
  });

  it('SearchResult 字段：name/description/parameters_summary/tier/endpoint/score', () => {
    const idx = new ToolVectorIndex({ embedder: null });
    idx.build([
      spec('read_file', '读文件', { type: 'object', properties: { p: {} }, required: ['p'] }),
    ]);
    const res = idx.search('read_file');
    expect(res[0]).toMatchObject({
      name: 'read_file',
      description: '读文件',
      parameters_summary: '必填: p',
      tier: 'review',
      endpoint: 'declarative',
    });
    expect(typeof res[0]?.score).toBe('number');
  });

  it('namespace 字段保留（架构层语义，TS 仅持有）', () => {
    const idx = new ToolVectorIndex({ embedder: null, namespace: 'tools' });
    expect(idx.namespace).toBe('tools');
  });
});

describe('ToolVectorIndex / seam 同步契约与降级可观测', () => {
  it('同步直返 seam：文档/query 向量可获取，degraded_reason 保持 null', () => {
    const embed = fake_embedder((texts) =>
      texts.map((t) => (t.includes('read') ? [1, 0] : [0, 1])),
    );
    const idx = new ToolVectorIndex({ embedder: embed });
    idx.build([spec('read_file', '读文件'), spec('write_file', '写文件')]);
    expect(idx.uses_vectors()).toBe(true);
    expect(idx.degraded_reason).toBeNull();
    const res = idx.search('read');
    expect(res[0]?.name).toBe('read_file');
    expect(res[0]?.score).toBeGreaterThan(0);
  });

  it('宿主未先 await（嵌入器返回 Promise）= seam 契约违规：降级关键词 + 明确原因上报（不静默）', () => {
    // 运行时仍返回 thenable = 宿主未按同步契约 await 收口（类型层为违规，
    // 测试以 untyped 注入模拟宿主绕开契约的形态）
    const unawaited = {
      aembed_documents: () => Promise.resolve([[1, 0], [0, 1]]),
      aembed_query: () => Promise.resolve([1, 0]),
    } as unknown as AsyncEmbedder;
    const reasons: string[] = [];
    const idx = new ToolVectorIndex({ embedder: unawaited, on_degraded: (r) => reasons.push(r) });
    idx.build([spec('a', 'A'), spec('b', 'B')]);
    // 不崩 + 明确降级标记（曾为静默恒 null → 关键词基线无信号）
    expect(idx.uses_vectors()).toBe(false);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(';')).toContain('await');
    expect(idx.degraded_reason).toContain('await');
    const res = idx.search('A');
    expect(res.length).toBeGreaterThan(0); // 关键词基线兜底仍可检索
  });

  it('嵌入失败不崩：降级关键词基线且降级原因经 on_degraded 上报', () => {
    const failing: AsyncEmbedder = {
      aembed_documents: () => {
        throw new Error('model missing');
      },
      aembed_query: () => {
        throw new Error('model missing');
      },
    };
    const reasons: string[] = [];
    const idx = new ToolVectorIndex({ embedder: failing, on_degraded: (r) => reasons.push(r) });
    idx.build([spec('read_file', '读文件')]);
    expect(idx.uses_vectors()).toBe(false);
    expect(reasons.some((r) => r.includes('model missing'))).toBe(true);
    expect(idx.degraded_reason).toContain('model missing');
    const res = idx.search('read_file');
    expect(res.length).toBeGreaterThan(0); // 失败不崩
  });
});