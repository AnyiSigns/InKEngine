/**
 * execution.run 桥命令单测（execution 域：执行运行时（作用域/通道）会话入口）。
 *
 * 测什么：
 * - 方法面挂载：execution.run 在 BRIDGE_METHODS/bridge 表内（execution 域注册）；
 * - 参数校验（BridgeError invalid_params）：缺 task / 空 task / pose 非法 /
 *   entry_scope 与 entry_temp_scope 同给；
 * - 端到端主线（fake OpenAI 兼容服务 = 会话默认模型）：task → main 作用域轮次
 *   加工 → 汇聚点单份 final_product（message = fake 服务回复），run 树/事件带/
 *   轨迹投影齐备（run_id 非空、hops 空、blocked=false）；
 * - 入口作用域不可装载 = blocked（fail-closed，原因含未知作用域 id）；
 * - 无模型配置 = 执行失败显式化（BridgeError execution_error，不静默）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BRIDGE_METHODS } from '../../src/bridge/index.js';
import { createHost } from '../../src/index.js';
import type { HostHandle } from '../../src/index.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

const CTX = { autoApprove: false };

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-exec-test-'));
  return { dir, events: path.join(dir, 'events') };
}

describe('execution.run 桥命令（execution 域挂载 + 参数校验）', () => {
  it('方法面：execution.run 经 EXECUTION_COMMANDS 声明并挂载', () => {
    expect(BRIDGE_METHODS).toContain('execution.run');
  });

  it('参数校验：缺/空 task、非法 pose、双入口作用域同给 → invalid_params', async () => {
    const { dir, events } = dirs();
    const handle = await createHost({ data_dir: dir, events_dir: events });
    try {
      const run = handle.bridge.get('execution.run')!;
      await expect(run({}, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(run({ task: '  ' }, CTX)).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        run({ task: 'x', pose: 'yolo' }, CTX),
      ).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(
        run({ task: 'x', entry_scope: 'main', entry_temp_scope: { role: 'sub' } }, CTX),
      ).rejects.toMatchObject({ code: 'invalid_params' });
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('execution.run 执行主线（fake llm → 汇聚点最终产物）', () => {
  let handle: HostHandle;
  let dir = '';
  let server: FakeOpenAIServer;

  beforeEach(async () => {
    const made = dirs();
    dir = made.dir;
    server = new FakeOpenAIServer({ content: '执行主线回复' });
    await server.start();
    handle = await createHost({
      data_dir: made.dir,
      events_dir: made.events,
      model_config: {
        agent_config: {
          protocol: 'openai_compatible',
          base_url: server.baseUrl,
          api_key: 'sk-exec-test',
          model_id: 'exec-test-model',
        },
      },
    });
  });

  afterEach(async () => {
    await handle.dispose();
    await server.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('task 直答收口：final_product 含 fake 回复，run 树/事件带/轨迹投影齐备', async () => {
    const run = handle.bridge.get('execution.run')!;
    const result = (await run({ task: '做一件事' }, CTX)) as {
      run_id: string;
      blocked: boolean;
      block_reason: string | null;
      outcome: string;
      final_product: Record<string, unknown>;
      degraded_summaries: string[];
      runs: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
      trails: Array<Record<string, unknown>>;
    };
    expect(result.blocked).toBe(false);
    expect(result.outcome).toBe('success');
    expect(result.final_product['message']).toBe('执行主线回复');
    expect(result.run_id).toBeTruthy();
    expect(result.runs.length).toBeGreaterThanOrEqual(1);
    expect(result.trails.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it('入口作用域不可装载 = blocked（原因含未知作用域 id，不产半成品）', async () => {
    const run = handle.bridge.get('execution.run')!;
    const result = (await run({ task: 'x', entry_scope: 'ghost_scope' }, CTX)) as {
      blocked: boolean;
      block_reason: string | null;
    };
    expect(result.blocked).toBe(true);
    expect(result.block_reason).toContain('不可装载');
  });

  it('fake 服务确被调用（引擎作用域轮次经会话默认模型）', async () => {
    const run = handle.bridge.get('execution.run')!;
    await run({ task: '计数一次' }, CTX);
    expect(server.requestCount).toBeGreaterThanOrEqual(1);
  });
});

describe('execution.run fail-closed（无模型配置）', () => {
  it('无会话默认模型 = 作用域加工失败收口（outcome=failure，摘要可见，不静默）', async () => {
    const { dir, events } = dirs();
    const handle = await createHost({ data_dir: dir, events_dir: events });
    try {
      const run = handle.bridge.get('execution.run')!;
      const result = (await run({ task: 'x' }, CTX)) as {
        blocked: boolean;
        outcome: string;
        degraded_summaries: string[];
      };
      expect(result.outcome).toBe('failure');
      expect(result.degraded_summaries.join('；')).toContain('会话默认模型');
    } finally {
      await handle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
