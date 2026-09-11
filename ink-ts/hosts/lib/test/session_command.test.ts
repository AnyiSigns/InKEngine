/**
 * session_command 工具族执行接线（#1 agent 工具包面：骨架读取/修改 + fork 试跑）——
 * 测的是：
 * - 装配后运行时声明式 harness 已登记三个工具定义（skeleton.inspect /
 *   skeleton.update / rounds.trial），端点族 session_command 有执行体；
 * - 声明式分发（dispatch，web_search 同通道）按工具名把调用送到既有 bridge
 *   命令实现：inspect→skeleton.get、update→skeleton.edit、trial→rounds.fork_trial，
 *   返回 JSON 结果（不复制机制语义）；
 * - 未知工具名 = 显式错误（fail-closed，映射表单一真源）。
 * W7-A 迁移注：骨架 inspect/update 与 rounds.trial 依赖组装回合建立的线程
 * 骨架（组装链专属），文件级打开 INK_ROUNDS_ASSEMBLY_FALLBACK 回退开关保持绿。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ENGINE_STUB_REPLY, endpoint_registry } from '@ink-ts/engine';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import { sessionCommandExecutor } from '../src/session_command.js';
import { SESSION_COMMAND_ENDPOINT } from '../src/session_command.js';
import { disableAssemblyFallback, enableAssemblyFallback } from './_rounds_flag.js';

beforeAll(() => {
  enableAssemblyFallback();
});

afterAll(() => {
  disableAssemblyFallback();
});

function dirs(): { dir: string; events: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-session-tools-'));
  return { dir, events: path.join(dir, 'events') };
}

/** 读取运行时声明式 harness（host 装配后按 web_search 通道登记本族）。 */
function declarativeOf(handle: HostHandle): unknown {
  const declarative = handle.runtime.harness_registry?.declarative;
  if (declarative === null || declarative === undefined) {
    throw new Error('运行时 harness 声明式注册表缺失（boot 后应可用）');
  }
  return declarative;
}

/** 直接走声明式分发执行（引擎统一分发面；ctx 空对象即可，执行体不经引擎管线）。 */
async function dispatchTool(
  handle: HostHandle,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const declarative = declarativeOf(handle) as {
    definitions: Record<string, { name: string; to_spec(): unknown }>;
    dispatch(
      ctx: unknown,
      spec: unknown,
      args: Record<string, unknown>,
      approval?: unknown,
    ): Promise<string>;
  };
  const definition = declarative.definitions[name];
  if (definition === undefined) throw new Error(`工具定义缺失: ${name}`);
  const text = await declarative.dispatch({}, definition.to_spec(), args, null);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('session_command 工具族装配（agent 工具包面执行接线）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('装配后：三个工具定义已登记 + 端点族已注册执行体', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    expect(endpoint_registry.has(SESSION_COMMAND_ENDPOINT)).toBe(true);
    const declarative = declarativeOf(handle) as {
      has(endpoint: string): boolean;
      definitions: Record<string, unknown>;
    };
    expect(declarative.has(SESSION_COMMAND_ENDPOINT)).toBe(true);
    for (const name of ['skeleton.inspect', 'skeleton.update', 'rounds.trial']) {
      expect(declarative.definitions[name]).toBeTruthy();
    }
  });

  it('skeleton.inspect 工具 → 分发到 skeleton.get：读回合建立后的骨架 + 校验态', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'hi' }, { autoApprove: false })) as {
      thread_id: string;
    };
    const view = await dispatchTool(handle, 'skeleton.inspect', {
      thread_id: first.thread_id,
    });
    expect(view['present']).toBe(true);
    expect(view['valid']).toBe(true);
    const skeleton = view['skeleton'] as Record<string, unknown>;
    expect(skeleton['entry']).toBe('llm_decider');
  });

  it('skeleton.update 工具 → 分发到 skeleton.edit：dry 预览校验通过且不落草稿', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'hi' }, { autoApprove: false })) as {
      thread_id: string;
    };
    const view = await dispatchTool(handle, 'skeleton.update', {
      thread_id: first.thread_id,
      actions: [],
      dry: true,
    });
    // 既有 llm_decider 骨架 + 空 actions = 结构不变预览通过（不落草稿）
    expect(view['ok']).toBe(true);
    expect(view['mounted']).toBe(false);
    expect(view['dry']).toBe(true);
  });

  it('rounds.trial 工具 → 分发到 rounds.fork_trial：新线程试跑 1 轮，主线不动', async () => {
    const made = dirs();
    handle = await createHost({ data_dir: made.dir, events_dir: made.events });
    const send = handle.bridge.get('rounds.send')!;
    const first = (await send({ input: 'hi' }, { autoApprove: false })) as {
      thread_id: string;
    };
    const before = await handle.runtime.storage!.chain_index(first.thread_id);
    const out = await dispatchTool(handle, 'rounds.trial', {
      thread_id: first.thread_id,
      input: '换个方向试跑',
    });
    expect(out['reply']).toBe(ENGINE_STUB_REPLY);
    expect(String(out['trial_thread_id'])).toMatch(new RegExp(`^${first.thread_id}:trial:`));
    const after = await handle.runtime.storage!.chain_index(first.thread_id);
    expect(after.length).toBe(before.length);
  });
});

describe('session_command 执行体 fail-closed', () => {
  it('未知工具名 = 显式错误（不静默）', async () => {
    const execute = sessionCommandExecutor(async () => 'unused');
    const definition = { name: 'session.unknown' } as never;
    await expect(execute({}, definition, {}, null)).rejects.toThrow(/未知工具/);
  });
});
