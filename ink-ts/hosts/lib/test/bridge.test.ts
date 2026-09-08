/**
 * host bridge 命令面单测（in-process 全绿）。
 *
 * 覆盖：方法表与 BRIDGE_METHODS 声明一致；参数校验（BridgeError）与信封
 * 约定（handler 抛错不吞内部细节，message 可回）；rounds 驱动（组装回合，
 * 无模型 = 引擎确定性 stub）+ 分支续跑；approval 卡查询 + 裁决；records/
 * sessions/audit/tools/recovery 只读与簿记查询。审批语义全在 engine
 * （approval/interrupt），bridge 只接线。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGINE_STUB_REPLY } from '@ink-ts/engine';

import { BRIDGE_METHODS } from '../src/bridge/index.js';
import { BridgeError } from '../src/bridge/_types.js';
import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import { runGateCard } from './_graphs.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-bridge-test-'));
  return { dir, events: path.join(dir, 'events') };
}

describe('host bridge 命令面', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  it('方法表与 BRIDGE_METHODS 声明一致（各域方法齐备）', () => {
    expect(BRIDGE_METHODS.length).toBeGreaterThan(8);
    expect([...handle.bridge.keys()].sort()).toEqual([...BRIDGE_METHODS].sort());
    for (const method of [
      'rounds.send',
      'rounds.branch',
      'records.sessions',
      'sessions.create',
      'sessions.tree',
      'approval.list',
      'audit.export',
      'tools.full',
      'recovery.checkpoints',
      'os.run',
    ]) {
      expect(handle.bridge.get(method)).toBeTypeOf('function');
    }
  });

  it('rounds.send 参数校验：缺 input / 空串 → BridgeError invalid_params', async () => {
    const send = handle.bridge.get('rounds.send')!;
    await expect(send(null, CTX)).rejects.toBeInstanceOf(BridgeError);
    await expect(send({ input: '' }, CTX)).rejects.toBeInstanceOf(BridgeError);
    await expect(send({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('rounds.send 跑通组装回合（无模型 → 确定性 stub）；abort 无在途 run 返回 aborted:false', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const result = (await send({ input: 'hi' }, CTX)) as { reply: string; reason: string };
    expect(result.reply).toBe(ENGINE_STUB_REPLY);
    expect(result.reason).toBe('reply');
    const aborted = await handle.bridge.get('rounds.abort')!(null, CTX);
    expect(aborted).toEqual({ aborted: false });
  });

  it('records.sessions 簿记递增；chain 只读；audit.export 可用', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const result = (await send({ input: 'again' }, CTX)) as { thread_id: string };
    const sessions = (await handle.bridge.get('records.sessions')!(null, CTX)) as Array<{
      thread_id: string;
      round_count: number;
      created_at: number;
    }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.thread_id).toBe(result.thread_id);
    expect(sessions[0]!.round_count).toBe(1);
    expect(typeof sessions[0]!.created_at).toBe('number');
    const chain = await handle.bridge.get('records.chain')!(
      { thread_id: result.thread_id },
      CTX,
    );
    expect((chain as { chain: unknown[] }).chain.length).toBeGreaterThan(0);
    await expect(handle.bridge.get('records.chain')!({}, CTX)).rejects.toMatchObject({
      code: 'invalid_params',
    });
    const audit = await handle.bridge.get('audit.export')!(null, CTX);
    expect(Array.isArray(audit)).toBe(true);
  });

  it('approval.resolve 无挂起卡 → BridgeError no_pending_approval', async () => {
    await expect(
      handle.bridge.get('approval.resolve')!(
        { thread_id: 't-none', decision: 'reject' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'no_pending_approval' });
  });

  it('approval.list 非法决议（auto 字符串）被拒', async () => {
    await expect(
      handle.bridge.get('approval.resolve')!(
        { thread_id: 't', decision: 'auto' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
  });

  it('sessions.create/rename/delete/refresh 薄簿记闭环', async () => {
    const created = (await handle.bridge.get('sessions.create')!(null, CTX)) as {
      thread_id: string;
      title: string;
      round_count: number;
    };
    expect(created.thread_id).toBeTruthy();
    expect(created.title).toBe('');

    const renamed = (await handle.bridge.get('sessions.rename')!(
      { thread_id: created.thread_id, title: ' 新标题 ' },
      CTX,
    )) as { title: string; rename_count: number };
    expect(renamed.title).toBe('新标题');
    expect(renamed.rename_count).toBe(1);

    await expect(
      handle.bridge.get('sessions.rename')!({ thread_id: created.thread_id, title: '' }, CTX),
    ).rejects.toMatchObject({ code: 'invalid_params' });

    const tree = await handle.bridge.get('sessions.tree')!(
      { thread_id: created.thread_id },
      CTX,
    );
    expect(tree).toMatchObject({ session_id: created.thread_id, nodes: [] });

    const removed = (await handle.bridge.get('sessions.delete')!(
      { thread_id: created.thread_id },
      CTX,
    )) as { deleted: boolean };
    expect(removed.deleted).toBe(true);
    const after = (await handle.bridge.get('records.sessions')!(null, CTX)) as unknown[];
    expect(after.some((record) => (record as { thread_id: string }).thread_id === created.thread_id)).toBe(false);
  });

  it('sessions.create 无参（params=undefined，web 无参调用的线上形态）不崩溃', async () => {
    const created = (await handle.bridge.get('sessions.create')!(undefined, CTX)) as {
      thread_id: string;
    };
    expect(created.thread_id).toBeTruthy();
  });
});

describe('host bridge rounds.branch（组装回合链叶分支续跑）', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  it('连续回合后可对链尾分支：新叶入树、原叶保留为父', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'a' }, CTX)) as {
      thread_id: string;
      checkpoint_id: number;
    };
    await send({ input: 'b', thread_id: first.thread_id }, CTX);
    const treeBefore = (await handle.bridge.get('sessions.tree')!(
      { thread_id: first.thread_id },
      CTX,
    )) as { nodes: Array<{ leaf: number; parent: number | null }> };
    expect(treeBefore.nodes).toHaveLength(1);
    const tailLeaf = treeBefore.nodes[0]!.leaf;

    const branch = (await handle.bridge.get('rounds.branch')!(
      { thread_id: first.thread_id, leaf: tailLeaf },
      CTX,
    )) as { leaf: number; tree: { nodes: Array<{ leaf: number; parent: number | null }> } };
    expect(branch.leaf).not.toBe(tailLeaf);
    const parents = branch.tree.nodes.map((node) => node.parent);
    expect(parents).toContain(tailLeaf);

    await expect(
      handle.bridge.get('rounds.branch')!({ thread_id: 'no-such' }, CTX),
    ).rejects.toMatchObject({ code: 'no_checkpoint' });
  });
});

describe('host bridge approval（数据图引擎挂卡 → 查询 → 裁决续跑）', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  /** 经 runtime 按数据图构建 gate 本轮引擎跑一轮挂卡回合（rounds 走组装，
   *  审批卡演示经数据图引擎触发；approval/checkpoint/恢复全走引擎机制）。 */
  async function startCardThread(): Promise<string> {
    const thread_id = `gate-${Math.random().toString(36).slice(2, 10)}`;
    await runGateCard(handle.runtime, thread_id);
    return thread_id;
  }

  it('挂卡回合触发审批卡；approval.list 可见；resolve reject → 决议原样抵达', async () => {
    const thread_id = await startCardThread();
    const cards = (await handle.bridge.get('approval.list')!(
      { thread_id },
      CTX,
    )) as Array<{ thread_id: string; key: string }>;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]!.key).toMatch(/^gate:/);

    const resolved = (await handle.bridge.get('approval.resolve')!(
      { thread_id, decision: 'reject' },
      CTX,
    )) as { result: { state: Record<string, unknown> } };
    expect((resolved.result.state as Record<string, unknown>)['reply']).toBe('reject');

    // 卡已消费：再次 resolve → no_pending_approval
    await expect(
      handle.bridge.get('approval.resolve')!(
        { thread_id, decision: 'reject' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'no_pending_approval' });
  });

  it('approval.resolve 裸决议正例：accept/terminate/edit 均原样抵达引擎裁决', async () => {
    const resolve = handle.bridge.get('approval.resolve')!;
    const runCard = async (): Promise<string> => {
      const thread_id = await startCardThread();
      const cards = (await handle.bridge.get('approval.list')!(
        { thread_id },
        CTX,
      )) as Array<{ thread_id: string }>;
      expect(cards.some((card) => card.thread_id === thread_id)).toBe(true);
      return thread_id;
    };

    const acceptThread = await runCard();
    const accepted = (await resolve({ thread_id: acceptThread, decision: 'accept' }, CTX)) as {
      result: { state: Record<string, unknown> };
    };
    expect((accepted.result.state as Record<string, unknown>)['reply']).toBe('accept');

    const editThread = await runCard();
    const edited = (await resolve(
      {
        thread_id: editThread,
        decision: { decision: 'edit', edited_content: { tool: 'demo_tool', summary: '已编辑' }, reason: '改摘要' },
      },
      CTX,
    )) as { result: { state: Record<string, unknown> } };
    expect((edited.result.state as Record<string, unknown>)['reply']).toBe('edit');

    const terminateThread = await runCard();
    const terminated = (await resolve(
      { thread_id: terminateThread, decision: 'terminate' },
      CTX,
    )) as { result: { state: Record<string, unknown> } };
    expect((terminated.result.state as Record<string, unknown>)['reply']).toBe('terminate');
  });

  it('approval.list 按 thread_id 过滤查询', async () => {
    const thread_id = await startCardThread();
    const cards = (await handle.bridge.get('approval.list')!(
      { thread_id },
      CTX,
    )) as unknown[];
    expect(cards).toHaveLength(1);
    const none = await handle.bridge.get('approval.list')!({ thread_id: 't-other' }, CTX);
    expect(none).toEqual([]);
  });
});

/** 从 checkpoint state 的 _round_graph 取 llm_decider 节点 config（数据形态）。 */
function llmDeciderConfig(graphData: unknown): Record<string, unknown> | null {
  const graph = graphData as {
    nodes?: Record<string, { type?: string; config?: Record<string, unknown> }>;
  };
  const node = Object.values(graph.nodes ?? {}).find((entry) => entry.type === 'llm_decider');
  return node?.config ?? null;
}

describe('host bridge capability.max_tool_rounds → 组装回合 llm_decider config 生效', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost({ data_dir: dir, events_dir: events });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  it('capability.put 改动 → 下轮组装图 llm_decider config 生效（每次 send 活读）', async () => {
    const put = handle.bridge.get('capability.put')!;
    const send = handle.bridge.get('rounds.send')!;
    await put({ max_tool_rounds: 3 }, CTX);
    const first = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    const latest = await handle.runtime.storage!.get_latest_checkpoint(first.thread_id);
    expect(latest).not.toBeNull();
    expect(llmDeciderConfig(latest!.state['_round_graph'])?.['max_tool_rounds']).toBe(3);
    // 活读面：put 改 5 → 下轮回合即换新值
    await put({ max_tool_rounds: 5 }, CTX);
    await send({ input: 'again', thread_id: first.thread_id }, CTX);
    const latest2 = await handle.runtime.storage!.get_latest_checkpoint(first.thread_id);
    expect(latest2).not.toBeNull();
    expect(llmDeciderConfig(latest2!.state['_round_graph'])?.['max_tool_rounds']).toBe(5);
  });

  it('无记录 → 不传覆写：组装图 llm_decider 无 max_tool_rounds（引擎缺省 8）', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const result = (await send({ input: 'hi' }, CTX)) as { thread_id: string };
    const latest = await handle.runtime.storage!.get_latest_checkpoint(result.thread_id);
    expect(latest).not.toBeNull();
    const config = llmDeciderConfig(latest!.state['_round_graph']);
    expect(config).not.toBeNull();
    expect(config!['max_tool_rounds']).toBeUndefined();
  });
});
