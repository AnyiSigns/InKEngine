// gate: 超限(207 行) - W8D 宿主接线 E2E（execution.branch 分叉命令 + rounds 会话记忆 session_context 收口）场景多、头注详尽，拆分会伤可读性
/**
 * W8D 宿主接线测试：①execution.branch 桥命令（从挂起 checkpoint 分叉新
 * run_id，原 run 链零触碰、可另行恢复，两 run 互不污染；参数校验与锚点
 * fail-closed）；②rounds.send 会话记忆收口（宿主 history 摘要切片经
 * session_context 受控注入——main 作用域轮次模型请求携带「会话记忆」标注段，
 * 子执行零注入；W7A 缺口④ 收口）。
 *
 * 测什么：
 * - 方法面：execution.branch 经 EXECUTION_COMMANDS 声明挂载；
 * - execution.branch 参数校验：缺 source_run_id / 非法 checkpoint_id / 非法
 *   pose / run_id 非字符串 → invalid_params；
 * - execution.branch E2E：execution.run（pose=review+hang）挂起 → 分支
 *   （pose=auto）独立续跑出结论（回执新 run 树 + run_start 带 branch_from）；
 *   原 run 链尾仍挂起卡（零触碰）→ execution.resume 决议续跑也成功——两 run
 *   互不污染；锚点不存在 → no_such_checkpoint；
 * - rounds 会话记忆：同线程二次 send → main 轮次模型请求携带「会话记忆」段
 *   （首轮问答摘要）；子代理请求零注入（不进子执行）；每个 main 轮次均注入。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelSpec, exec_checkpoint_thread } from '@ink-ts/engine';

import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-w8d-'));
  return { dir, events: path.join(dir, 'events') };
}

async function bootHost(server: FakeOpenAIServer, dir: string): Promise<HostHandle> {
  return await createHost({
    data_dir: dir,
    events_dir: path.join(dir, 'events'),
    model_config: {
      agent_config: {
        protocol: 'openai_compatible',
        base_url: server.baseUrl,
        api_key: 'sk-w8d',
        model_id: 'w8d-model',
      },
    },
  });
}

interface RunReceipt {
  run_id: string;
  blocked: boolean;
  block_reason: string | null;
  outcome: string;
  final_product: Record<string, unknown>;
  pending_approval?: boolean;
  pending?: { key: string | null; payload: Record<string, unknown>; checkpoint_id: number | null; run_id: string } | null;
  runs?: Array<{ run_id: string; outcome: string }>;
  events?: Array<{ action: string; detail: Record<string, unknown> | null }>;
}

describe('execution.branch 桥命令（挂载 + 参数校验）', () => {
  it('方法面：execution.branch 经 EXECUTION_COMMANDS 声明并挂载', () => {
    expect(BRIDGE_METHODS).toContain('execution.branch');
  });

  it('参数校验：缺 source_run_id / 非法 checkpoint_id / 非法 pose → invalid_params', async () => {
    const made = dirs();
    const handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    try {
      const branch = handle.bridge.get('execution.branch')!;
      await expect(branch({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(branch({ source_run_id: 'r' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        branch({ source_run_id: 'r', checkpoint_id: 0 }, CTX),
      ).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        branch({ source_run_id: 'r', checkpoint_id: 1, pose: 'yolo' }, CTX),
      ).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        branch({ source_run_id: 'r', checkpoint_id: 1, run_id: 7 }, CTX),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await handle.dispose();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});

describe('execution.branch E2E：挂起 run 分叉独立续跑，原 run 零触碰可另行恢复', () => {
  let handle: HostHandle;
  let dir = '';
  let server: FakeOpenAIServer;

  beforeEach(async () => {
    const made = dirs();
    dir = made.dir;
    server = new FakeOpenAIServer({
      content: [
        '{"__next":{"kind":"channel","channel":"guarded","target":"subagent"}}',
        'FORK 子代理结论',
        'FORK 分支结论',
        'A 子代理结论',
        'A 恢复结论',
      ],
    });
    await server.start();
    handle = await bootHost(server, made.dir);
    handle.execution.channels.register(
      new ChannelSpec({ id: 'guarded', shape: 'delegate', conditions: { approval: 'L2' } }),
    );
  });

  afterEach(async () => {
    await handle.dispose();
    await server.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('run 挂起 → branch（pose=auto）续跑出结论；resume 原 run 也成功；链互不触碰', async () => {
    const run = handle.bridge.get('execution.run')!;
    const first = (await run({ task: '委托并汇总', pose: 'review' }, CTX)) as RunReceipt;
    expect(first.pending_approval).toBe(true);
    expect(first.pending?.checkpoint_id).toBeGreaterThan(0);
    const sourceRunId = first.run_id;

    // 分叉：新 run_id 独立续跑（pose=auto = 新 run 自己的审批生命周期）
    const branch = handle.bridge.get('execution.branch')!;
    const fork = (await branch(
      { source_run_id: sourceRunId, checkpoint_id: first.pending!.checkpoint_id, run_id: 'w8d_fork_1', pose: 'auto' },
      CTX,
    )) as RunReceipt;
    expect(fork.blocked).toBe(false);
    expect(fork.pending_approval).toBe(false);
    expect(fork.outcome).toBe('success');
    expect(fork.run_id).toBe('w8d_fork_1');
    expect(fork.final_product['message']).toBe('FORK 分支结论');
    // 回执新 run 树：根 + 子执行；run_start 带 branch_from 决策留痕
    expect(fork.runs?.map((r) => r.run_id)).toContain('w8d_fork_1');
    expect(fork.events?.some((e) => e.action === 'run_start' && e.detail?.['branch_from'] !== undefined)).toBe(true);

    // 原 run 链零触碰：链尾仍是挂起卡（分支不写原链）
    const aTail = await handle.runtime.storage!.get_latest_checkpoint(exec_checkpoint_thread(sourceRunId));
    expect(aTail?.reason).toBe('interrupted');
    expect(aTail?.checkpoint_id).toBe(first.pending!.checkpoint_id);

    // 原 run 另行恢复：决议 accept 续跑出结论（互不污染）
    const resume = handle.bridge.get('execution.resume')!;
    const resumed = (await resume(
      { run_id: sourceRunId, checkpoint_id: first.pending!.checkpoint_id, decision: 'accept' },
      CTX,
    )) as RunReceipt;
    expect(resumed.outcome).toBe('success');
    expect(resumed.final_product['message']).toBe('A 恢复结论');
    const aTailAfter = await handle.runtime.storage!.get_latest_checkpoint(exec_checkpoint_thread(sourceRunId));
    expect(aTailAfter?.reason).toBe('success');
  });

  it('锚点不存在 → blocked 显式拒绝（block_reason 含恢复锚点；同源 run_id 拒绝）', async () => {
    const branch = handle.bridge.get('execution.branch')!;
    // 锚点不存在 = 引擎 fail-closed blocked 回执（与 execution.resume 同口径）
    const ghost = (await branch({ source_run_id: 'r-ghost', checkpoint_id: 99999 }, CTX)) as RunReceipt;
    expect(ghost.blocked).toBe(true);
    expect(ghost.block_reason).toContain('恢复锚点不存在');
    // 同源 run_id 拒绝（新 run 须独立命名空间）
    const run = handle.bridge.get('execution.run')!;
    const first = (await run({ task: '委托', pose: 'review' }, CTX)) as RunReceipt;
    const same = (await branch(
      { source_run_id: first.run_id, checkpoint_id: first.pending!.checkpoint_id, run_id: first.run_id },
      CTX,
    )) as RunReceipt;
    expect(same.blocked).toBe(true);
    expect(same.block_reason).toContain('不得与源 run 相同');
  });
});

describe('rounds 会话记忆收口：session_context 仅注入 main 轮次', () => {
  it('同线程二次 send：main 请求携带「会话记忆」段；子代理请求零注入', async () => {
    const made = dirs();
    const server = new FakeOpenAIServer({
      content: ['主线直答', '{"__next":{"kind":"scope","target":"subagent"}}', '子代理结果', '第二轮回合结论'],
    });
    await server.start();
    const handle = await bootHost(server, made.dir);
    try {
      const send = handle.bridge.get('rounds.send')!;
      const first = (await send({ input: '第一问' }, CTX)) as { thread_id: string; reason: string };
      expect(first.reason).toBe('reply');
      const second = (await send(
        { input: '第二问', thread_id: first.thread_id },
        CTX,
      )) as { reason: string; reply: string | null };
      expect(second.reason).toBe('reply');
      expect(second.reply).toBe('第二轮回合结论');
      expect(server.requests.length).toBe(4);
      // round2 main 首轮请求携带会话记忆标注段（首轮问答摘要受控注入）
      const round2Main = JSON.stringify(server.requests[1]!.body);
      expect(round2Main).toContain('## 会话记忆');
      expect(round2Main).toContain('第一问');
      expect(round2Main).toContain('主线直答');
      // 子代理请求零注入（session_context 不进子执行）
      const subagentBody = JSON.stringify(server.requests[2]!.body);
      expect(subagentBody).not.toContain('## 会话记忆');
      expect(subagentBody).not.toContain('第一问');
      // round2 main 收口轮次仍注入（每个 main 轮次均携带）
      expect(JSON.stringify(server.requests[3]!.body)).toContain('## 会话记忆');
    } finally {
      await handle.dispose();
      await server.close();
      rmSync(made.dir, { recursive: true, force: true });
    }
  });
});
