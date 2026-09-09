// gate: 超限(398 行) - skeleton 命令面（skeleton.get/edit + rounds.fork_trial 含消息基线复制 + rounds.branch）多命令组同文件防命令面语义漂移
/**
 * skeleton 命令面（P4-B-2 目标 1：读/声明式修改/沿新骨架推进）bridge 单测——
 * 测的是：
 * - skeleton.get：无链 = present:false 空态；回合建立后读回投影 + 当前池校验态；
 * - skeleton.edit：入参/动作畸形 invalid_params；池外类型/缺出口校验拒绝不落草稿
 *   （唯一写口纪律：未校验通过不写 host 簿记）；dry 预览不落草稿；合法编辑落
 *   草稿（skeleton_draft）→ 下一轮 rounds.send 消费（引擎沿新骨架推进）并清除；
 * - rounds.fork_trial：以源会话骨架为蓝图在新线程试跑 1 轮（主线不动）；源无
 *   骨架显式拒绝；源线程 2+ 轮历史消息链经引擎投影 seam 复制进试跑首轮
 *   （真 LLM 请求断言上下文完整）；
 * - rounds.branch 分支续跑携带锚点骨架（分支叶骨架不丢，会话尺度数据随分支延续）。
 *
 * 机制语义（结构/池校验/沿骨架推进）在 engine（P4-A/runtime_skeleton_seed 已测），
 * 本文件只验宿主命令面接线与数据写纪律。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BOOT_SYSTEM_PROMPT,
  ENGINE_STUB_REPLY,
  FIELD_STRING,
  NodeContract,
  SchemaField,
  SchemaSpec,
  THREAD_SKELETON_STATE_KEY,
} from '@ink-ts/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-skeleton-'));
  return { dir, events: path.join(dir, 'events') };
}

/** 取线程最新 checkpoint 的骨架 dict（无 = null）。 */
async function latestSkeleton(
  handle: HostHandle,
  thread_id: string,
): Promise<Record<string, unknown> | null> {
  const storage = handle.runtime.storage;
  if (storage === null) return null;
  const latest = await storage.get_latest_checkpoint(thread_id).catch(() => null);
  if (latest === null) return null;
  const raw = latest.state[THREAD_SKELETON_STATE_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
}

/** 会话骨架测试专用终态类型（host.test 注册；经 node_registry_store 受控写）。 */
const TAKEOVER_TYPE = 'host.skeleton_takeover';

/** 注册「接管」终态类型（骨架编辑后沿其推进的验证载体；无 LLM 依赖直出回复）。 */
async function registerTakeoverNode(handle: HostHandle, reply: string): Promise<void> {
  const runtime = handle.runtime;
  const factory = () => async () => ({ reply });
  const contract = new NodeContract({
    input_schema: null,
    output_schema: new SchemaSpec({
      name: 'host.skeleton_takeover.output',
      fields: [new SchemaField({ name: 'reply', required: true, kind: FIELD_STRING })],
    }),
    safety_tier: 0,
    version: 1,
  });
  const store = runtime.node_registry_store;
  if (store === null) throw new Error('需要 node_registry_store（boot 后可用）');
  await store.register(
    {
      type_name: TAKEOVER_TYPE,
      contract,
      executor: 'host.test.skeleton_takeover',
      provenance: 'agent',
      status: 'active',
      flags: { terminal: true },
    },
    'host.test:register skeleton takeover node',
  );
  runtime.graph_registries!.nodes.register(TAKEOVER_TYPE, factory, contract);
}

/** 单节点接管骨架（编辑器整份替换形态）。 */
function takeoverSketch(thread_id: string): Record<string, unknown> {
  return {
    version: 1,
    thread_id,
    status: 'active',
    entry: TAKEOVER_TYPE,
    nodes: { [TAKEOVER_TYPE]: { type: TAKEOVER_TYPE, config: {} } },
    edges: {},
    exits: [TAKEOVER_TYPE],
    active_target: null,
    created_at: 0,
    updated_at: 0,
  };
}

describe('skeleton.get（读当前会话骨架投影）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('无链/无骨架 → present:false 结构化空态；参数校验缺 thread_id 拒绝', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const get = handle.bridge.get('skeleton.get')!;
    const view = (await get({ thread_id: 't-none' }, CTX)) as {
      present: boolean;
      skeleton: unknown;
      reasons: string[];
    };
    expect(view.present).toBe(false);
    expect(view.skeleton).toBeNull();
    expect(view.reasons.length).toBeGreaterThan(0);
    await expect(get({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(get({ thread_id: '' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('回合建立骨架后 → present:true + 当前池校验态 + 骨架投影', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    const view = (await handle.bridge.get('skeleton.get')!({ thread_id: first.thread_id }, CTX)) as {
      present: boolean;
      valid: boolean;
      skeleton: Record<string, unknown> | null;
    };
    expect(view.present).toBe(true);
    expect(view.valid).toBe(true);
    expect(view.skeleton?.['entry']).toBe('llm_decider');
    expect((view.skeleton?.['nodes'] as Record<string, unknown>)['llm_decider']).toBeTruthy();
  });
});

describe('skeleton.edit（声明式修改 → 校验 → 挂载草稿 → 下轮消费）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('入参/动作畸形：缺 thread_id、无 actions/sketch、双给、不支持的 op → invalid_params', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const edit = handle.bridge.get('skeleton.edit')!;
    await expect(edit({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(edit({ thread_id: 't' }, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(
      edit({ thread_id: 't', sketch: {}, actions: [{ op: 'upsert_node', id: 'a' }] }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      edit({ thread_id: 't', actions: [{ op: 'explode' }] }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    // 线程尚无骨架 + 空 actions = 无可编辑对象 → 结构化拒绝（校验失败，不抛错）
    const emptyEdit = (await edit({ thread_id: 't-noskel', actions: [] }, CTX)) as {
      ok: boolean;
      reasons: string[];
    };
    expect(emptyEdit.ok).toBe(false);
    expect(emptyEdit.reasons.join('；')).toContain('entry');
  });

  it('拒绝池外类型 / 缺出口：校验不过不落草稿（写口纪律：peek 仍为空）', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    const edit = handle.bridge.get('skeleton.edit')!;
    // 池外类型（执行体只能来自池）
    const foreign = await edit(
      {
        thread_id: first.thread_id,
        sketch: {
          thread_id: first.thread_id,
          entry: 'agent',
          nodes: { agent: { type: 'host.not.in.pool' } },
          edges: {},
          exits: ['agent'],
        },
      },
      CTX,
    );
    expect(foreign).toMatchObject({ ok: false, mounted: false });
    // 缺出口（骨架不可终止）
    const noExit = await edit(
      {
        thread_id: first.thread_id,
        actions: [{ op: 'set_exits', exits: [] }],
      },
      CTX,
    );
    expect(noExit).toMatchObject({ ok: false, mounted: false });
    const raw = (noExit as { reasons: string[] }).reasons;
    expect(raw.join('；')).toContain('出口');
    // 草稿未被写（校验拒绝 = 不落写）
    const session = handle.runtime.storage!;
    const record = await session
      .get_record('host.sessions', first.thread_id)
      .catch(() => null);
    const draft = record === null ? null : record['skeleton_draft'];
    expect(draft === undefined || draft === null).toBe(true);
  });

  it('dry 预览：校验通过但不落草稿；真执行合法编辑 → 草稿落库待下轮消费', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    await registerTakeoverNode(handle, 'takeover-reply');
    const send = handle.bridge.get('rounds.send')!;
    const edit = handle.bridge.get('skeleton.edit')!;
    const first = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    // dry：预览合法接管骨架，不写草稿
    const dryView = (await edit(
      { thread_id: first.thread_id, sketch: takeoverSketch(first.thread_id), dry: true },
      CTX,
    )) as { ok: boolean; mounted: boolean; skeleton: Record<string, unknown> | null };
    expect(dryView.ok).toBe(true);
    expect(dryView.mounted).toBe(false);
    expect(dryView.skeleton?.['entry']).toBe(TAKEOVER_TYPE);
    // 真执行：挂载草稿 → 下一次 rounds.send 消费（引擎沿新骨架推进）并清除
    const applied = (await edit(
      { thread_id: first.thread_id, sketch: takeoverSketch(first.thread_id) },
      CTX,
    )) as { ok: boolean; mounted: boolean };
    expect(applied.ok).toBe(true);
    expect(applied.mounted).toBe(true);
    const next = (await send({ input: '沿新骨架推进', thread_id: first.thread_id }, CTX)) as {
      reply: string;
    };
    expect(next.reply).toBe('takeover-reply');
    const leaf = await latestSkeleton(handle, first.thread_id);
    expect((leaf?.['nodes'] as Record<string, unknown>)[TAKEOVER_TYPE]).toBeTruthy();
    // 草稿已被消费清除
    const after = await handle.runtime.storage!.get_record('host.sessions', first.thread_id);
    expect(after === null || after['skeleton_draft'] === null || after['skeleton_draft'] === undefined).toBe(true);
  });
});

describe('rounds.fork_trial（以会话骨架为蓝图的新线程试跑）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('源无骨架 → 显式拒绝（no_skeleton）', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    await expect(
      handle.bridge.get('rounds.fork_trial')!({ thread_id: 't-noskeleton', input: '试跑' }, CTX),
    ).rejects.toMatchObject({ code: 'no_skeleton' });
    await expect(handle.bridge.get('rounds.fork_trial')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });

  it('有骨架会话 fork 试跑：新线程首轮沿骨架蓝图跑 1 轮，主线链不动', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const source = (await send({ input: 'hi' }, CTX)) as { thread_id: string; checkpoint_id: number };
    const mainBefore = await handle.runtime.storage!.chain_index(source.thread_id);
    const out = (await handle.bridge.get('rounds.fork_trial')!(
      { thread_id: source.thread_id, input: '换个方向试跑' },
      CTX,
    )) as { trial_thread_id: string; reply: string; reason: string };
    expect(out.trial_thread_id).toMatch(new RegExp(`^${source.thread_id}:trial:`));
    expect(out.reply).toBe(ENGINE_STUB_REPLY);
    expect(out.reason).toBe('reply');
    // 主线链不动（试跑只在新线程）
    const mainAfter = await handle.runtime.storage!.chain_index(source.thread_id);
    expect(mainAfter.length).toBe(mainBefore.length);
    // 试跑叶落骨架（蓝图已随 checkpoint 持久，供试跑会话后续回合沿其推进）
    const forkSkeleton = await latestSkeleton(handle, out.trial_thread_id);
    expect(forkSkeleton).not.toBeNull();
    expect(forkSkeleton?.['thread_id']).toBe(out.trial_thread_id);
    expect((forkSkeleton?.['nodes'] as Record<string, unknown>)['llm_decider']).toBeTruthy();
    // 试跑线程有自己的链（不借用主线）
    const trialChain = await handle.runtime.storage!.chain_index(out.trial_thread_id);
    expect(trialChain.length).toBeGreaterThan(0);
  });
});

describe('rounds.fork_trial 消息基线复制（checkpoint 存储态 → 试跑首轮上下文）', () => {
  let handle: HostHandle;
  let server: FakeOpenAIServer;

  afterEach(async () => {
    if (handle !== undefined && handle !== null) {
      await handle.dispose();
    }
    if (server !== undefined && server !== null) {
      await server.close();
    }
  });

  it('源线程 2+ 轮历史：试跑 LLM 请求含完整基线（system + 两轮 user/assistant + 试跑 input）', async () => {
    const made = dirs();
    server = new FakeOpenAIServer({ content: 'host-ok' });
    await server.start();
    handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: server.baseUrl,
          api_key: 'sk-fork-baseline',
          model_id: 'host-chat',
        },
      },
    });
    const send = handle.bridge.get('rounds.send')!;
    const fork = handle.bridge.get('rounds.fork_trial')!;
    const first = (await send({ input: '问题甲' }, CTX)) as { thread_id: string };
    await send({ input: '问题乙', thread_id: first.thread_id }, CTX);
    const before = server.requestCount;
    const out = (await fork({ thread_id: first.thread_id, input: '换个方向试跑' }, CTX)) as {
      trial_thread_id: string;
      reply: string;
      reason: string;
    };
    expect(out.reply).toBe('host-ok');
    expect(out.reason).toBe('reply');
    // 试跑触发第三次 LLM 请求（源两轮 + 试跑一轮）
    expect(server.requestCount).toBe(before + 1);
    const trialReq = server.requests[server.requests.length - 1]!;
    const messages = trialReq.body['messages'] as Array<{ role: string; content: string }>;
    // 基线 = 链首 system（boot）+ 源两轮 user/assistant 文本链 + 试跑 input 收尾 user；
    // 证明 2+ 轮历史被复制（非只带 input 的新会话）
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]!.content).toBe(BOOT_SYSTEM_PROMPT);
    expect(messages[1]!.content).toBe('问题甲');
    expect(messages[2]!.content).toBe('host-ok');
    expect(messages[3]!.content).toBe('问题乙');
    expect(messages[4]!.content).toBe('host-ok');
    expect(messages[5]!.content).toBe('换个方向试跑');
  });
});

describe('rounds.branch 携带锚点骨架（分支会话尺度数据不丢）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('分支续跑后：新叶 checkpoint 含 _thread_skeleton（骨架随分支延续）', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const source = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    const before = await latestSkeleton(handle, source.thread_id);
    expect(before).not.toBeNull();
    const branched = (await handle.bridge.get('rounds.branch')!(
      { thread_id: source.thread_id, input: '分支续跑' },
      CTX,
    )) as { leaf: number; skeleton_carried: boolean };
    expect(branched.skeleton_carried).toBe(true);
    const storage = handle.runtime.storage!;
    const leaf = await storage.get_checkpoint(branched.leaf);
    expect(leaf).not.toBeNull();
    const raw = leaf!.state[THREAD_SKELETON_STATE_KEY];
    expect(typeof raw).toBe('object');
    const carried = raw as Record<string, unknown>;
    expect(carried['entry']).toBe(before!['entry']);
    const nodesAfter = (carried['nodes'] as Record<string, unknown>) ?? {};
    const nodesBefore = (before!['nodes'] as Record<string, unknown>) ?? {};
    expect(Object.keys(nodesAfter)).toEqual(Object.keys(nodesBefore));
    // 沿分支叶骨架推进（下一轮分支会话不丢会话尺度数据）
    const again = (await send({ input: '分支下一轮', thread_id: source.thread_id }, CTX)) as {
      reply: string;
    };
    expect(again.reply).toBe(ENGINE_STUB_REPLY);
    const skeletonAfter = await latestSkeleton(handle, source.thread_id);
    expect((skeletonAfter?.['nodes'] as Record<string, unknown>)['llm_decider']).toBeTruthy();
  });
});
