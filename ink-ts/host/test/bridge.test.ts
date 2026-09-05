/**
 * host bridge 命令面单测（in-process 全绿）。
 *
 * 覆盖：方法表与 BRIDGE_METHODS 声明一致；参数校验（BridgeError）与信封
 * 约定（handler 抛错不吞内部细节，message 可回）；rounds 驱动（echo 图无
 * 模型依赖）+ 分支续跑；approval 卡查询 + 裁决；records/sessions/audit/
 * tools/recovery 只读与簿记查询。审批语义全在 engine（approval/interrupt），
 * bridge 只接线。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../src/bridge/index.js';
import { BridgeError } from '../src/bridge/_types.js';
import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import { echoGraphRecipe, gateGraphRecipe } from './_graphs.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-bridge-test-'));
  return { dir, events: path.join(dir, 'events') };
}

describe('host bridge 命令面', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost(
      { data_dir: dir, events_dir: events },
      { graph_recipe: echoGraphRecipe },
    );
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
      'tools.snapshot',
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

  it('rounds.send 跑通回声回合；abort 无在途 run 返回 aborted:false', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const result = (await send({ input: 'hi' }, CTX)) as { reply: string; reason: string };
    expect(result.reply).toBe('echo:hi');
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

  it('tools.snapshot 只读快照（注册工具 + 向量状态可观测）', async () => {
    const snapshot = (await handle.bridge.get('tools.snapshot')!(null, CTX)) as {
      count: number;
      uses_vectors: boolean;
      tools: Array<{ name: string }>;
    };
    expect(snapshot.count).toBeGreaterThan(0);
    expect(snapshot.tools.length).toBe(snapshot.count);
    expect(snapshot.tools.some((tool) => tool.name === 'search_tools')).toBe(true);
    expect(typeof snapshot.uses_vectors).toBe('boolean');
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
});

describe('host bridge rounds.branch（echo 图链叶分支续跑）', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost(
      { data_dir: dir, events_dir: events },
      { graph_recipe: echoGraphRecipe },
    );
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

describe('host bridge approval（gate 图挂卡 → 查询 → 裁决续跑）', () => {
  let handle: HostHandle;

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost(
      { data_dir: dir, events_dir: events },
      { graph_recipe: gateGraphRecipe },
    );
  });

  afterEach(async () => {
    await handle.dispose();
  });

  it('rounds.send 触发审批卡；approval.list 可见；resolve reject → skipped', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: '触发审批' }, CTX)) as { thread_id: string };
    const cards = (await handle.bridge.get('approval.list')!({}, CTX)) as Array<{
      thread_id: string;
      key: string;
    }>;
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]!.key).toMatch(/^gate:/);

    const resolved = (await handle.bridge.get('approval.resolve')!(
      { thread_id: first.thread_id, decision: 'reject' },
      CTX,
    )) as { result: { state: Record<string, unknown> } };
    expect((resolved.result.state as Record<string, unknown>)['reply']).toBe('skipped');

    // 卡已消费：再次 resolve → no_pending_approval
    await expect(
      handle.bridge.get('approval.resolve')!(
        { thread_id: first.thread_id, decision: 'reject' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'no_pending_approval' });
  });

  it('approval.list 按 thread_id 过滤查询', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'x' }, CTX)) as { thread_id: string };
    const cards = (await handle.bridge.get('approval.list')!(
      { thread_id: first.thread_id },
      CTX,
    )) as unknown[];
    expect(cards).toHaveLength(1);
    const none = await handle.bridge.get('approval.list')!({ thread_id: 't-other' }, CTX);
    expect(none).toEqual([]);
  });
});
