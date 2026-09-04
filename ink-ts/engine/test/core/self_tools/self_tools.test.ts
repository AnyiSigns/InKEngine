// gate: 超限(376 行) - 自指元工具操作用例共享同一 spec/存储/上下文夹具，拆文件降操作面回归可读性
/**
 * 契约自指元工具单测（对标 Python ink_engine/tests/test_self_tools.py）：
 * 6 契约工具的 ToolSpec/判定/执行行为（内核侧）。
 *
 * 覆盖：契约工具清单与权限声明；操作判定（propose/apply × patch）；
 * 提案校验（形态非法/合法 + 集版本）；L0 直过落链；L1 挂卡 → 决议注入
 * 重入；收敛管制前置闸门（可选钩子拒绝）；回退（仅链尾 + 审批）；领域
 * 生成器（重名拒绝/工具形态预校验/相关经验检索）；未知名显式拒绝。
 *
 * deferred（引擎执行器集成面另行覆盖）：引擎执行器跑完整回合闭环的
 * 集成用例（host 侧 test_self_round 为闭环回归线；含真实存储后端/中断
 * checkpoint 持久化/工具索引与端点探活装配）对应 Python 宿主集成面，
 * 待引擎执行器/宿主装配面迁入后补测；本文件以内存假存储 + 假节点
 * 上下文驱动纯机制语义，零执行器依赖。
 */

import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { HarnessDefinition } from '../../../src/core/harness/index.js';
import { InterruptSignal } from '../../../src/core/interrupt/interrupt_types.js';
import {
  KnowledgeEntry,
  SOURCE_MODEL,
} from '../../../src/core/knowledge_set/index.js';
import { ToolSpec } from '../../../src/core/llm/tools.js';
import {
  PERMISSION_APPLY,
  PERMISSION_PROPOSE,
  SELF_TOOL_CONTRACT,
  operation_of,
  self_tool_specs,
} from '../../../src/core/self_tools/index.js';
import type { ConvergenceHook } from '../../../src/core/self_tools/index.js';
import { PatchKind } from '../../../src/core/self_proposal/index.js';

import { MemStorage, StubCtx, _make_tools, _specs } from './helpers.js';

function jsonLoads(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('契约工具与权限声明', () => {
  it('契约工具清单 = 6 个工具（4 演化 + 2 自指发现，与 seeds/boot 契约同源）', () => {
    const names = new Set(self_tool_specs().map((spec) => spec.name));
    expect(names).toEqual(new Set(SELF_TOOL_CONTRACT));
    expect([...names].sort()).toEqual([...SELF_TOOL_CONTRACT].sort());
    const byName = _specs();
    // 权限声明（自定义域：propose/apply）
    expect([...byName['propose_patch']!.permissions]).toEqual([PERMISSION_PROPOSE]);
    expect([...byName['propose_domain_manifest']!.permissions]).toEqual([PERMISSION_PROPOSE]);
    expect([...byName['apply_patch']!.permissions]).toEqual([PERMISSION_APPLY]);
    expect([...byName['revert_patch']!.permissions]).toEqual([PERMISSION_APPLY]);
  });
});

describe('操作判定', () => {
  it('operation_of：propose/apply × patch 目标（单一判定来源）', () => {
    const specs = _specs();
    expect(operation_of(specs['propose_patch']!)).toEqual(['propose', 'patch']);
    expect(operation_of(specs['propose_domain_manifest']!)).toEqual(['propose', 'patch']);
    expect(operation_of(specs['apply_patch']!)).toEqual(['apply', 'patch']);
    expect(operation_of(specs['revert_patch']!)).toEqual(['apply', 'patch']);
  });
});

describe('提案校验（propose_patch）', () => {
  it('形态非法：显式报错（结构化拒绝，不击穿执行）', async () => {
    const { executor } = _make_tools(new MemStorage());
    const specs = _specs();
    // 非法类型
    const badKind = jsonLoads(
      await executor(new StubCtx(), specs['propose_patch']!, { kind: 'bogus', payload: {} }, null),
    );
    expect(badKind['ok']).toBe(false);
    expect((badKind['violations'] as string[]).join('')).toContain('补丁类型非法');
    // 非法 payload 形态
    const badPayload = jsonLoads(
      await executor(new StubCtx(), specs['propose_patch']!, { kind: 'theme', payload: 'nope' }, null),
    );
    expect(badPayload['ok']).toBe(false);
    expect((badPayload['violations'] as string[]).join('')).toContain('payload 须为对象');
  });

  it('合法提案：返回当前集版本（供 apply_patch 引用基准）', async () => {
    const { pipeline, executor } = _make_tools(new MemStorage());
    const data = jsonLoads(
      await executor(
        new StubCtx(),
        _specs()['propose_patch']!,
        { kind: 'theme', payload: { tokens: { bg: '#123456' } }, rationale: '换色' },
        null,
      ),
    );
    expect(data['ok']).toBe(true);
    expect(data['current_version']).toBe(1);
    expect(await pipeline.chain.current_version()).toBe(1); // 只校验不落链
  });
});

describe('应用（apply_patch）', () => {
  it('L0（主题）直过：校验 → 审批直过 → 落链，不挂卡', async () => {
    const { pipeline, executor } = _make_tools(new MemStorage());
    const ctx = new StubCtx();
    const data = jsonLoads(
      await executor(
        ctx,
        _specs()['apply_patch']!,
        { kind: 'theme', payload: { tokens: { bg: '#123456' } } },
        null,
      ),
    );
    expect(ctx.suspended).toEqual([]); // 无挂起
    // 集版本语义：补丁数 + 1（首条补丁 = 版本 2）
    expect(data['ok']).toBe(true);
    expect(data['patch_id']).toBe(2);
    const state = await pipeline.chain.assemble();
    expect(state['theme']).toEqual({ bg: '#123456' });
    const log = await pipeline.audit_log();
    expect(log[log.length - 1]!['status']).toBe('applied');
  });

  it('L1（工具）挂卡：回合挂起（InterruptSignal），决议注入 accept 后落链', async () => {
    const { pipeline, executor } = _make_tools(new MemStorage(), {
      approval_levels: { [PatchKind.TOOL]: 'L1' },
    });
    const specs = _specs();
    const args = {
      kind: 'tool',
      payload: {
        name: 'listworkspace',
        description: '列出工作区文件',
        permissions: ['filesystem:read:/workspace'],
        endpoint: 'file_ops',
        endpoint_config: { root: '/workspace' },
      },
      rationale: '注册工作区查看工具',
    };
    let caught: unknown = null;
    try {
      await executor(new StubCtx(), specs['apply_patch']!, args, null);
    } catch (exc) {
      caught = exc;
    }
    expect(caught).toBeInstanceOf(InterruptSignal);
    const signal = caught as InterruptSignal;
    expect(signal.key).toBe('patch:tool');
    const card = signal.payload;
    expect(card['review_type']).toBe('gate');
    expect((card['patch'] as Record<string, unknown>)['kind']).toBe('tool');
    // 挂起期间未落链
    const suspendedState = await pipeline.chain.assemble();
    expect(suspendedState['tools']).toBeUndefined();
    // 决议注入重入
    const ctx2 = new StubCtx({ injections: { 'patch:tool': 'accept' } });
    const data = jsonLoads(await executor(ctx2, specs['apply_patch']!, args, null));
    expect(data['ok']).toBe(true);
    expect(data['patch_id']).toBe(2);
    const state = await pipeline.chain.assemble();
    expect((state['tools'] as Record<string, Record<string, unknown>>)['listworkspace']!['name']).toBe('listworkspace');
  });

  it('L1 拒绝决议：不落链，审计留痕 rejected', async () => {
    const { pipeline, executor } = _make_tools(new MemStorage(), {
      approval_levels: { [PatchKind.TOOL]: 'L1' },
    });
    const specs = _specs();
    const args = {
      kind: 'tool',
      payload: {
        name: 'listworkspace',
        description: '列出工作区文件',
        permissions: ['filesystem:read:/workspace'],
        endpoint: 'file_ops',
        endpoint_config: { root: '/workspace' },
      },
    };
    const ctx = new StubCtx({ injections: { 'patch:tool': 'reject' } });
    const data = jsonLoads(await executor(ctx, specs['apply_patch']!, args, null));
    expect(data['ok']).toBe(false);
    expect(data['status']).toBe('rejected');
    const state = await pipeline.chain.assemble();
    expect(state['tools']).toBeUndefined();
    const log = await pipeline.audit_log();
    expect(log[log.length - 1]!['status']).toBe('rejected');
  });

  it('收敛管制前置闸门（可选钩子）：冷却期显式拒绝，AI 据此换方向', async () => {
    const calls: string[] = [];
    const convergence: ConvergenceHook = {
      assess: async (_records, kind, _payload) => {
        calls.push(kind);
        return {
          allowed: false,
          state: 'cooldown',
          target: `${kind}:theme`,
          reason: '近窗口重写过频，冷却中',
        };
      },
    };
    const { pipeline, executor } = _make_tools(new MemStorage(), { convergence });
    const data = jsonLoads(
      await executor(
        new StubCtx(),
        _specs()['apply_patch']!,
        { kind: 'theme', payload: { tokens: { bg: '#000000' } } },
        null,
      ),
    );
    expect(calls).toEqual(['theme']);
    expect(data['ok']).toBe(false);
    expect(data['status']).toBe('cooldown');
    expect(await pipeline.chain.current_version()).toBe(1); // 未落链
  });

  it('前置闸门未装配（convergence=null）：走正常审批管线', async () => {
    const { pipeline, executor } = _make_tools(new MemStorage());
    const data = jsonLoads(
      await executor(
        new StubCtx(),
        _specs()['apply_patch']!,
        { kind: 'theme', payload: { tokens: { bg: '#abcdef' } } },
        null,
      ),
    );
    expect(data['ok']).toBe(true);
    const state = await pipeline.chain.assemble();
    expect(state['theme']).toEqual({ bg: '#abcdef' });
  });
});

describe('回退（revert_patch）', () => {
  it('回退：先落一条 L0 补丁，回退走审批（挂卡注入 accept 后链级回退）', async () => {
    const { pipeline, executor } = _make_tools(new MemStorage());
    const specs = _specs();
    await executor(
      new StubCtx(),
      specs['apply_patch']!,
      { kind: 'theme', payload: { tokens: { bg: '#123456' } } },
      null,
    );
    expect(await pipeline.chain.current_version()).toBe(2);
    // 回退挂卡（revert key），注入 accept
    const ctx = new StubCtx({ injections: { 'revert:2': 'accept' } });
    const data = jsonLoads(
      await executor(ctx, specs['revert_patch']!, { patch_id: 2, reason: '不喜欢' }, null),
    );
    expect(data['ok']).toBe(true);
    const state = await pipeline.chain.assemble();
    expect(state['theme']).toBeUndefined(); // 回退后回到基线
    const log = await pipeline.audit_log();
    expect(
      log.some(
        (entry) => entry['kind'] === 'revert' && entry['status'] === 'reverted',
      ),
    ).toBe(true);
  });

  it('回退非链尾补丁：结构化拒绝（仅允许链尾）', async () => {
    const { executor } = _make_tools(new MemStorage());
    const specs = _specs();
    await executor(
      new StubCtx(),
      specs['apply_patch']!,
      { kind: 'theme', payload: { tokens: { bg: '#123456' } } },
      null,
    );
    const data = jsonLoads(
      await executor(new StubCtx(), specs['revert_patch']!, { patch_id: 5 }, null),
    );
    expect(data['ok']).toBe(false);
    expect(data['reason']).toContain('仅允许回退链尾补丁');
  });
});

describe('领域生成器（propose_domain_manifest）', () => {
  it('高层描述 → 最小 harness 提案（校验通过 + 相关经验检索）', async () => {
    const { executor, context } = _make_tools(new MemStorage());
    context.knowledge_set!.add(
      new KnowledgeEntry({
        id: 'k1',
        level: 'project',
        kind: 'rule',
        data: { rule: { id: 'r1', description: '现代诗创作与润色：诗歌用词需凝练' } },
        source: SOURCE_MODEL,
        credibility: 0.9,
        title: '现代诗创作与润色规范',
        tags: ['诗歌', '润色'],
      }),
    );
    const data = jsonLoads(
      await executor(
        new StubCtx(),
        _specs()['propose_domain_manifest']!,
        {
          domain_name: 'poetry',
          description: '现代诗创作与润色',
          keywords: ['诗歌', '润色'],
          rationale: '新增诗歌领域',
        },
        null,
      ),
    );
    expect(data['ok']).toBe(true);
    expect(data['kind']).toBe('harness');
    expect((data['definition'] as Record<string, unknown>)['name']).toBe('poetry');
    expect(data['current_version']).toBe(1);
    // 相关经验检索（复用优先于从头发明）
    const related = data['related_knowledge'] as Array<Record<string, unknown>>;
    expect(related.some((item) => item['id'] === 'k1')).toBe(true);
  });

  it('与既有 harness 重名显式拒绝（改名覆盖职责不归生成器）', async () => {
    const { executor, context } = _make_tools(new MemStorage());
    context.harness_registry!.register(
      new HarnessDefinition({
        name: 'poetry',
        description: '既有诗歌领域',
        keywords: ['诗歌'],
      }),
    );
    const data = jsonLoads(
      await executor(
        new StubCtx(),
        _specs()['propose_domain_manifest']!,
        {
          domain_name: 'poetry',
          description: '现代诗创作',
          keywords: ['诗歌'],
        },
        null,
      ),
    );
    expect(data['ok']).toBe(false);
    expect((data['violations'] as string[]).join('')).toContain('领域名已存在');
  });

  it('工具清单逐项形态预校验（产出保证可被 apply_patch 复用）', async () => {
    const { executor } = _make_tools(new MemStorage());
    const data = jsonLoads(
      await executor(
        new StubCtx(),
        _specs()['propose_domain_manifest']!,
        {
          domain_name: 'poetry',
          description: '现代诗创作',
          keywords: ['诗歌'],
          tools: [{ name: 123 }], // 非法工具定义
        },
        null,
      ),
    );
    expect(data['ok']).toBe(false);
    expect((data['violations'] as string[]).join('')).toContain('工具定义非法');
  });
});

describe('未知名自指工具', () => {
  it('未知名显式拒绝（fail-closed：契约外工具不在内核执行范围）', async () => {
    const { executor } = _make_tools(new MemStorage());
    const unknown = new ToolSpec({
      name: 'harvest_seed',
      description: '宿主扩展工具',
      parameters: { type: 'object', properties: {} },
      permissions: [PERMISSION_APPLY],
    });
    await expect(executor(new StubCtx(), unknown, {}, null)).rejects.toThrow(
      /未知自指工具/,
    );
    await expect(executor(new StubCtx(), unknown, {}, null)).rejects.toBeInstanceOf(
      GraphDefinitionError,
    );
  });
});
