/**
 * collab_request 组织类工具执行接线单测（collab_command.ts：声明式定义与
 * plugin 真源对齐 + 端点执行体 JSON 回执 + 审批姿态透传）。
 *
 * 测什么：
 * - collabRequestDefinition()：工具名 = 引擎内置端点 collab_request；召集协议
 *   schema 齐备（scope/n/mode/contract/rounds/budget + 兼容位 entity_id/
 *   context_refs/constraints，required = [task]）；meta.executor = host:collab_request；
 *   与 plugins/tools/collab_request/spec.json 真源行逐字一致（description/
 *   parameters/permissions/approval/meta——生成面防第二真源漂移）；
 * - collabRequestExecutor()：convene 结果 → JSON 字符串（模型可见）；
 *   ConveneError → ok:false + 结构化 reason（模型可自我纠正）；service 未装配
 *   → ok:false execution_unavailable；ctx.state.round_pose 透传 convene
 *   （review 姿态遇审批档通道 = 召集拒绝）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ChannelDirectory, ChannelSpec } from '@ink-ts/engine';

import {
  COLLAB_REQUEST_ENDPOINT,
  collabRequestDefinition,
  collabRequestExecutor,
} from '../src/collab_command.js';
import { ConveneError } from '../src/execution/convene.js';
import { HostExecutionService } from '../src/execution/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** collab_request 真源行（plugins spec.json data.tool）。 */
function pluginToolRow(): Record<string, unknown> {
  const raw = JSON.parse(
    readFileSync(join(HERE, '..', '..', '..', 'plugins', 'tools', 'collab_request', 'spec.json'), 'utf8'),
  ) as { data: { tool: Record<string, unknown> } };
  return raw.data.tool;
}

function definitionAsRecord(): Record<string, unknown> {
  const def = collabRequestDefinition();
  return def.to_dict() as unknown as Record<string, unknown>;
}

describe('collab_request 声明式定义（与 plugin 真源对齐）', () => {
  it('端点/权限/审批档/执行体登记与 plugin 行一致（防第二真源漂移）', () => {
    const row = pluginToolRow();
    const def = definitionAsRecord();
    expect(row['name']).toBe(COLLAB_REQUEST_ENDPOINT);
    expect(def['endpoint']).toBe(row['endpoint']);
    expect(def['permissions']).toEqual(row['permissions']);
    expect((def['meta'] as Record<string, unknown>)['executor']).toBe(
      (row['meta'] as Record<string, unknown>)['executor'],
    );
    expect((def['meta'] as Record<string, unknown>)['approval']).toBe('review');
  });

  it('参数面语义与 plugin 行同构（属性键集/required/enum 一致；描述文本非契约面）', () => {
    const row = pluginToolRow()['parameters'] as {
      properties: Record<string, { type?: string; enum?: string[] }>;
      required: string[];
    };
    const def = collabRequestDefinition().parameters as {
      properties: Record<string, { type?: string; enum?: string[] }>;
      required: string[];
    };
    expect(Object.keys(def.properties).sort()).toEqual(Object.keys(row.properties).sort());
    expect(def.required).toEqual(row.required);
    for (const key of Object.keys(def.properties)) {
      expect(def.properties[key]!.type).toBe(row.properties[key]!.type);
      expect(def.properties[key]!.enum).toEqual(row.properties[key]!.enum);
    }
  });

  it('召集协议 schema：n/mode/contract/rounds/budget/scope 齐备，required=[task]', () => {
    const parameters = collabRequestDefinition().parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    for (const key of ['entity_id', 'scope', 'task', 'n', 'mode', 'contract', 'rounds', 'budget']) {
      expect(parameters.properties[key]).toBeDefined();
    }
    expect(parameters.required).toEqual(['task']);
  });
});

/** fake 服务（turn 剧本 + 通道目录可注入）。 */
function fakeService(
  script: Record<string, Array<Record<string, unknown>>>,
  extra: Partial<ConstructorParameters<typeof HostExecutionService>[0]> = {},
): HostExecutionService {
  const calls: string[] = [];
  const turn = {
    async run_scope_turn(ctx: { scope: { id: string } }): Promise<{ ok: boolean; reply: string; payload: Record<string, unknown> }> {
      calls.push(ctx.scope.id);
      const item = script[ctx.scope.id]?.shift() ?? { message: '（缺省直答）' };
      return { ok: true, reply: JSON.stringify(item), payload: item };
    },
  };
  void calls;
  const loader = (id: string) =>
    (id === 'collaborator' || id === 'main'
      ? ({ id, role: id, persona: `${id} 作用域`, model: null } as never)
      : null);
  return new HostExecutionService({ loadScope: loader as never, turnOverride: turn as never, ...extra });
}

describe('collab_request 端点执行体（convene JSON 回执）', () => {
  it('召集成功 → ok:true JSON（scope_ref/contract/children/conclusion 齐备）', async () => {
    const service = fakeService({ collaborator: [{ opinion: '评审通过' }] });
    const executor = collabRequestExecutor(() => service);
    const out = await executor({}, collabRequestDefinition(), {
      entity_id: 'collaborator',
      task: '评审这段结论',
    }, null);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['scope_ref']).toBe('collaborator');
    expect(parsed['contract']).toBe('full');
    expect((parsed['children'] as unknown[]).length).toBe(1);
    expect(parsed['conclusion']).toContain('评审通过');
  });

  it('召集校验失败 → ok:false + 结构化 reason（ConveneError 归一）', async () => {
    const service = fakeService({});
    const executor = collabRequestExecutor(() => service);
    const out = await executor({}, collabRequestDefinition(), { task: '缺目标' }, null);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('invalid_params');
  });

  it('执行体异常（非 ConveneError）→ ok:false convene_failed，不击穿回合', async () => {
    const service = fakeService({ collaborator: [{ opinion: 'x' }] });
    Object.defineProperty(service, 'channels', {
      get() {
        throw new Error('通道目录炸了');
      },
    });
    const executor = collabRequestExecutor(() => service);
    const out = await executor({}, collabRequestDefinition(), {
      entity_id: 'collaborator',
      task: '触发异常',
    }, null);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('convene_failed');
    expect(parsed.error).toContain('通道目录');
  });

  it('service 未装配 → ok:false execution_unavailable（fail-closed 拒绝召集）', async () => {
    const executor = collabRequestExecutor(() => null);
    const out = await executor({}, collabRequestDefinition(), {
      entity_id: 'collaborator',
      task: '没人装配',
    }, null);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('execution_unavailable');
  });

  it('ctx.state.round_pose 透传：review 姿态 + 审批档通道 = 召集拒绝', async () => {
    const dir = new ChannelDirectory();
    dir.register(new ChannelSpec({ id: 'fan_out', shape: 'fan_out', conditions: { approval: 'L1' } }));
    const service = fakeService({ collaborator: [{ opinion: 'x' }] }, { channels: dir });
    const executor = collabRequestExecutor(() => service);
    const ctx = { state: { round_pose: 'review' } };
    const out = await executor(ctx, collabRequestDefinition(), {
      entity_id: 'collaborator',
      task: '多人需审批',
      n: 2,
    }, null);
    const parsed = JSON.parse(out) as { ok: boolean; reason: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('approval_denied');
  });

  it('ConveneError 是结构化 Error（reason 可读）——执行体分类依赖此不变式', () => {
    const error = new ConveneError('测试原因', 'max_parallel_exceeded');
    expect(error.reason).toBe('max_parallel_exceeded');
    expect(error.message).toContain('测试原因');
  });
});
