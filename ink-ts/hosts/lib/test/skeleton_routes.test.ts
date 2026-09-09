/**
 * #8 route:* 出边条件预注册收敛（hosts/lib 侧）——测的是：
 * - 前提：含 router_judge 实例 + route:* 出边条件的骨架，在宿主未预注册前
 *   validate_skeleton 以「未注册条件」拒绝（route:<key> 无法被声明式图解析）；
 * - pre_register_skeleton_routes：从 router config.routes 提取出边条件 key 并
 *   经引擎既有 register_route_edge_condition 登记（幂等），登记后校验通过；
 * - mount_skeleton_to_state 挂载路径自动预注册（唯一写口含预注册收敛点）；
 * - 非法 key（含 ':'/空）预注册失败 = 结构化拒绝原因（fail-closed）；
 * - bridge skeleton.edit 写含 router 出边的骨架 → 统一预注册 → 校验通过并挂载。
 *
 * 机制语义（router 执行体/条件边族注册面/池校验）在 engine，host 只接预注册
 * 收敛，不改机制。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CollectorTransport,
  DefaultInterruptPolicy,
  Runtime,
  ThreadSkeleton,
  create_storage,
  register_route_edge_condition,
} from '@ink-ts/engine';
import type { AsyncLLM, EngineTransport, Host, InterruptPolicy, Storage } from '@ink-ts/engine';
import { afterEach, describe, expect, it } from 'vitest';

import { createHost } from '../src/index.js';
import type { HostHandle } from '../src/index.js';
import {
  mount_skeleton_to_state,
  pre_register_skeleton_routes,
  validate_skeleton_sketch,
} from '../src/skeleton.js';
import { build_product_recipe } from '../src/recipe.js';

/** 最小宿主（真 memory 存储 + 无模型 + 全挂起策略；装配冒烟用）。 */
class FakeHost {
  async create_storage(): Promise<Storage> {
    return create_storage('memory://');
  }
  async resolve_llm(): Promise<AsyncLLM | null> {
    return null;
  }
  interrupt_policy(): InterruptPolicy {
    return new DefaultInterruptPolicy();
  }
  build_transport(): EngineTransport {
    return new CollectorTransport();
  }
  async close(): Promise<void> {}
}

function toHost(host: FakeHost): Host {
  return host as unknown as Host;
}

/** 每个用例独立装配：boot 一次产品配方 runtime。 */
async function productRuntime(): Promise<Runtime> {
  const runtime = new Runtime();
  await runtime.boot(toHost(new FakeHost()), build_product_recipe());
  return runtime;
}

/** 含 router_judge + route 出边的骨架（entry=router，route:A/B → llm_decider 终态）。 */
function routerSkeleton(thread_id: string): ThreadSkeleton {
  return new ThreadSkeleton({
    thread_id,
    entry: 'router',
    nodes: {
      router: {
        type: 'router_judge',
        config: {
          routes: [
            { key: 'A', label: '直接回答', description: '目标已明确' },
            { key: 'B', label: '先研究', description: '先收集信息' },
          ],
        },
      },
      llm_decider: { type: 'llm_decider', config: {} },
    },
    edges: {
      router: [
        { target: 'llm_decider', condition: 'route:A' },
        { target: 'llm_decider', condition: 'route:B' },
      ],
    },
    exits: ['llm_decider'],
    status: 'active',
  });
}

describe('pre_register_skeleton_routes（#8 收敛：router route:* 条件预注册）', () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime.stop();
  });

  it('前提：未预注册时 validate 拒绝「未注册条件」；预注册后通过', async () => {
    runtime = await productRuntime();
    const registries = runtime.graph_registries!;
    expect(registries.edges.has('route:A')).toBe(false);

    const skeleton = routerSkeleton('t-route-1');
    const before = validate_skeleton_sketch(runtime, skeleton.to_dict());
    expect(before.ok).toBe(false);
    expect(before.reasons.join('；')).toContain('未注册条件');

    const pre = pre_register_skeleton_routes(runtime, skeleton.to_dict());
    expect(pre.ok).toBe(true);
    expect(registries.edges.has('route:A')).toBe(true);
    expect(registries.edges.has('route:B')).toBe(true);

    const after = validate_skeleton_sketch(runtime, skeleton.to_dict());
    expect(after.ok).toBe(true);
    expect(after.reasons).toEqual([]);
  });

  it('幂等：重复预注册不报错、不重复登记', async () => {
    runtime = await productRuntime();
    const skeleton = routerSkeleton('t-route-2');
    const first = pre_register_skeleton_routes(runtime, skeleton.to_dict());
    const second = pre_register_skeleton_routes(runtime, skeleton.to_dict());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runtime.graph_registries!.edges.has('route:A')).toBe(true);
  });

  it('mount_skeleton_to_state 挂载路径自动预注册（写口收敛）', async () => {
    runtime = await productRuntime();
    const state: Record<string, unknown> = {};
    const skeleton = routerSkeleton('t-route-3');
    expect(runtime.graph_registries!.edges.has('route:A')).toBe(false);
    const mounted = mount_skeleton_to_state(runtime, state, skeleton.to_dict());
    expect(mounted.ok).toBe(true);
    expect(mounted.mounted).toBe(true);
    expect(runtime.graph_registries!.edges.has('route:A')).toBe(true);
  });

  it('非法 key（含 :）预注册失败 → 拒绝原因（fail-closed）', async () => {
    runtime = await productRuntime();
    const skeleton = new ThreadSkeleton({
      thread_id: 't-route-bad',
      entry: 'router',
      nodes: {
        router: {
          type: 'router_judge',
          config: { routes: ['bad:key'] },
        },
        llm_decider: { type: 'llm_decider', config: {} },
      },
      edges: {
        router: [{ target: 'llm_decider', condition: 'route:bad:key' }],
      },
      exits: ['llm_decider'],
      status: 'active',
    });
    const pre = pre_register_skeleton_routes(runtime, skeleton.to_dict());
    expect(pre.ok).toBe(false);
    expect(pre.reasons.join('；')).toContain('预注册失败');
  });

  it('只登记出边实际引用的 router config 路由 key（无 route 出边条件不登记）', async () => {
    runtime = await productRuntime();
    const skeleton = new ThreadSkeleton({
      thread_id: 't-route-idle',
      entry: 'router',
      nodes: {
        router: {
          type: 'router_judge',
          config: { routes: ['X'] },
        },
        llm_decider: { type: 'llm_decider', config: {} },
      },
      edges: {
        router: [{ target: 'llm_decider', condition: 'llm.pending' }],
      },
      exits: ['llm_decider'],
      status: 'active',
    });
    const pre = pre_register_skeleton_routes(runtime, skeleton.to_dict());
    expect(pre.ok).toBe(true);
    expect(runtime.graph_registries!.edges.has('route:X')).toBe(false);
  });
});

describe('bridge skeleton.edit 写 router 出边骨架 → 统一预注册（#8 bridge 层收敛）', () => {
  let handle: HostHandle;

  afterEach(async () => {
    await handle.dispose();
  });

  it('编辑含 router_judge + route:* 出边的骨架：预注册后校验通过并挂载', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ink-route-bridge-'));
    handle = await createHost({ data_dir: dir, events_dir: path.join(dir, 'events') });
    const send = handle.bridge.get('rounds.send')!;
    const edit = handle.bridge.get('skeleton.edit')!;
    const first = (await send({ input: 'hi' }, { autoApprove: false })) as {
      thread_id: string;
    };
    expect(handle.runtime.graph_registries!.edges.has('route:A')).toBe(false);
    const view = (await edit(
      {
        thread_id: first.thread_id,
        sketch: routerSkeleton(first.thread_id).to_dict(),
      },
      { autoApprove: false },
    )) as { ok: boolean; mounted: boolean; reasons: string[] };
    expect(view.ok).toBe(true);
    expect(view.mounted).toBe(true);
    expect(handle.runtime.graph_registries!.edges.has('route:A')).toBe(true);
  });
});

describe('register_route_edge_condition 引擎公开面（host 引用面）', () => {
  let runtime: Runtime;

  afterEach(async () => {
    await runtime.stop();
  });

  it('单 key 登记幂等且可重复调用', async () => {
    runtime = await productRuntime();
    register_route_edge_condition(runtime.graph_registries!, 'Z');
    register_route_edge_condition(runtime.graph_registries!, 'Z');
    expect(runtime.graph_registries!.edges.has('route:Z')).toBe(true);
  });
});
