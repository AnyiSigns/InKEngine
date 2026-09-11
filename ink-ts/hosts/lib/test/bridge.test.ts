// gate: 超限(250 行) - host bridge 命令面单测共用同一装置，整链回归可读性优先
/**
 * host bridge 命令面单测（in-process 全绿）。
 *
 * 覆盖：方法表与 BRIDGE_METHODS 声明一致；参数校验（BridgeError）与信封
 * 约定（handler 抛错不吞内部细节，message 可回）；rounds 驱动（execution
 * 主线 + fake llm 回复）+ 簿记；records/sessions/audit/tools/recovery 只读与
 * 簿记查询。审批语义全在 engine（approval/interrupt），bridge 只接线。
 *
 * W7-B 迁移注：组装回退 flag（INK_ROUNDS_ASSEMBLY_FALLBACK）与组装链桥面
 * （rounds.branch/rounds.fork_trial/approval.list/approval.resolve/rounds.todos）
 * 已随组装链路退役；回归位改走 execution 主线默认入口（fake llm），审批挂卡
 * 语义见 bridge/rounds_mainline.test.ts（exec 链挂卡 + rounds.resume 决议注入）。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../src/bridge/index.js';
import { BridgeError } from '../src/bridge/_types.js';
import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import { FakeOpenAIServer } from './_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-bridge-test-'));
  return { dir, events: path.join(dir, 'events') };
}

describe('host bridge 命令面', () => {
  let handle: HostHandle;
  let server: FakeOpenAIServer | null = null;

  beforeAll(async () => {
    server = new FakeOpenAIServer({ content: '桥回复' });
    await server.start();
  });

  afterAll(async () => {
    if (server !== null) await server.close();
  });

  beforeEach(async () => {
    const { dir, events } = dirs();
    handle = await createHost({
      data_dir: dir,
      events_dir: events,
      ...(server === null
        ? {}
        : {
            model_config: {
              agent_config: {
                protocol: 'openai_compatible',
                base_url: server.baseUrl,
                api_key: 'sk-bridge-test',
                model_id: 'bridge-chat',
              },
            },
          }),
    });
  });

  afterEach(async () => {
    await handle.dispose();
  });

  it('方法表与 BRIDGE_METHODS 声明一致（各域方法齐备）', () => {
    expect(BRIDGE_METHODS.length).toBeGreaterThan(8);
    expect([...handle.bridge.keys()].sort()).toEqual([...BRIDGE_METHODS].sort());
    for (const method of [
      'rounds.send',
      'rounds.resume',
      'records.sessions',
      'sessions.create',
      'sessions.tree',
      'audit.export',
      'tools.full',
      'recovery.checkpoints',
      'os.run',
    ]) {
      expect(handle.bridge.get(method)).toBeTypeOf('function');
    }
    // 组装链桥面已退役（无命令位）
    for (const absent of ['rounds.branch', 'rounds.fork_trial', 'approval.list', 'approval.resolve', 'rounds.todos', 'graph.instance', 'skeleton.get', 'skeleton.edit']) {
      expect(handle.bridge.has(absent)).toBe(false);
    }
  });

  it('rounds.send 参数校验：缺 input / 空串 → BridgeError invalid_params', async () => {
    const send = handle.bridge.get('rounds.send')!;
    await expect(send(null, CTX)).rejects.toBeInstanceOf(BridgeError);
    await expect(send({ input: '' }, CTX)).rejects.toBeInstanceOf(BridgeError);
    await expect(send({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('rounds.send model 校验：推理字段类型非法 → BridgeError invalid_params', async () => {
    const send = handle.bridge.get('rounds.send')!;
    await expect(send({ input: 'x', model: { reasoning_effort: 5 } }, CTX))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(send({ input: 'x', model: { enable_thinking: 'yes' } }, CTX))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(send({ input: 'x', model: { thinking_budget: 'big' } }, CTX))
      .rejects.toMatchObject({ code: 'invalid_params' });
  });

  it('rounds.send pose 校验：非法档位 → BridgeError invalid_params；review/auto/deny 通过', async () => {
    const send = handle.bridge.get('rounds.send')!;
    await expect(send({ input: 'x', pose: 'allow' }, CTX))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(send({ input: 'x', pose: 42 }, CTX))
      .rejects.toMatchObject({ code: 'invalid_params' });
    for (const pose of ['review', 'auto', 'deny']) {
      const result = (await send({ input: 'hi', pose }, CTX)) as { thread_id: string };
      expect(result.thread_id).toBeTypeOf('string');
    }
  });

  it('rounds.send 跑通主线回合（fake llm 直答）；abort 无在途 run 返回 aborted:false', async () => {
    const send = handle.bridge.get('rounds.send')!;
    const result = (await send({ input: 'hi' }, CTX)) as { reply: string; reason: string };
    expect(result.reply).toBe('桥回复');
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