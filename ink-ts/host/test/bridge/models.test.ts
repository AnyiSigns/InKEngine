/**
 * models.config.* 命令面单测（运行模型配置：掩码回显 / 校验合并落盘 /
 * 从文件重载换槽）。
 *
 * 覆盖：
 * - get 空态（掩码空配置 + agent/router 双槽未配置）与 put 后已配置态；
 * - put 校验 + apply + 原子落盘 config.json（api_key 明文只在文件内，
 *   任何回显一律掩码、序列化不含明文）；掩码回写不击穿既有明文；
 *   put 只覆盖入参槽（merge 语义，缺席槽保留）；
 * - reload 从 config.json 重读并应用：Runtime 引擎重建后下轮回合走新槽
 *   （resolve_llm 重解析，真对话可见切换）。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createHost } from '../../src/index.js';
import type { HostHandle, RoleEndpointConfig } from '../../src/index.js';
import { maskKey } from '../../src/search/keys.js';
import { runtime_config_path, write_runtime_model_config } from '../../src/model_config_runtime.js';
import { chatGraphRecipe, echoGraphRecipe } from '../_graphs.js';
import { FakeOpenAIServer } from '../_fake_openai.js';

interface DirCtx {
  dir: string;
  events: string;
}

function tempContext(): DirCtx {
  const dir = mkdtempSync(path.join(tmpdir(), 'ink-models-bridge-'));
  return { dir, events: path.join(dir, 'events') };
}

/** 端点形状（openai_compatible 最小面；api_key 仅用于持久化与掩码断言）。 */
function endpoint(overrides: { base_url: string; model_id: string; api_key?: string }): RoleEndpointConfig {
  return {
    protocol: 'openai_compatible',
    base_url: overrides.base_url,
    model_id: overrides.model_id,
    api_key: overrides.api_key ?? '',
  };
}

function readPersisted(dir: string): Record<string, unknown> {
  const text = readFileSync(runtime_config_path(dir), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('models.config.get/put（掩码 + 持久化 + merge）', () => {
  const handled: HostHandle[] = [];

  afterEach(async () => {
    const list = handled.splice(0);
    for (const handle of list) await handle.dispose();
  });

  it('空态 get：掩码空配置 + agent/router 双槽未配置', async () => {
    const ctx = tempContext();
    const handle = await createHost(
      { data_dir: ctx.dir, events_dir: ctx.events },
      { graph_recipe: echoGraphRecipe },
    );
    handled.push(handle);
    const state = await handle.bridge.get('models.config.get')!(null, { autoApprove: false });
    expect(state).toEqual({
      model_config: {},
      roles: { agent: { configured: false }, router: { configured: false } },
    });
  });

  it('put 校验并落盘：回显掩码无明文；只覆盖入参槽（merge 语义）', async () => {
    const ctx = tempContext();
    const agentKey = 'sk-agent-secret-0123456789';
    const routerKey = 'sk-router-secret-0123456789';
    const handle = await createHost(
      { data_dir: ctx.dir, events_dir: ctx.events },
      { graph_recipe: echoGraphRecipe },
    );
    handled.push(handle);

    // 只写 router 槽：agent 槽缺席保留（当前为空 → 仍缺）
    const put = await handle.bridge.get('models.config.put')!(
      {
        config: {
          router_config: endpoint({ base_url: 'http://router/v1', model_id: 'router-m', api_key: routerKey }),
        },
      },
      { autoApprove: false },
    );
    expect(put).toMatchObject({ saved: true });
    const saved = put as { model_config: Record<string, unknown> };
    expect(saved.model_config['router_config']).toMatchObject({ base_url: 'http://router/v1' });
    expect((saved.model_config['router_config'] as Record<string, unknown>)['api_key']).toBe(
      maskKey(routerKey),
    );

    // 明文只落文件（运行配置文件内完整密钥随 data_dir 本地权限）
    const file = readPersisted(ctx.dir)['model_config'] as Record<string, unknown>;
    expect((file['router_config'] as Record<string, unknown>)['api_key']).toBe(routerKey);

    // put agent 槽：router 槽保持（merge，非整表替换）
    const second = await handle.bridge.get('models.config.put')!(
      {
        config: {
          agent_config: endpoint({ base_url: 'http://agent/v1', model_id: 'agent-m', api_key: agentKey }),
        },
      },
      { autoApprove: false },
    );
    const after = (second as { model_config: Record<string, unknown> })['model_config'];
    expect(after['agent_config']).toMatchObject({ base_url: 'http://agent/v1' });
    expect(after['router_config']).toMatchObject({ base_url: 'http://router/v1' });

    // get：双槽已配置 + 掩码回显（序列化不含任何明文）
    const state = (await handle.bridge.get('models.config.get')!(null, { autoApprove: false })) as {
      model_config: Record<string, unknown>;
      roles: Record<string, { configured: boolean }>;
    };
    expect(state.roles).toEqual({ agent: { configured: true }, router: { configured: true } });
    const echoed = JSON.stringify([put, second, state]);
    expect(echoed).not.toContain(agentKey);
    expect(echoed).not.toContain(routerKey);
    expect(JSON.stringify(state.model_config['agent_config'])).not.toContain(agentKey);
  });

  it('掩码回写视为未变更（回显-回写不把明文密钥击穿成掩码）', async () => {
    const ctx = tempContext();
    const key = 'sk-keep-this-plain-0123456789';
    const handle = await createHost(
      { data_dir: ctx.dir, events_dir: ctx.events },
      { graph_recipe: echoGraphRecipe },
    );
    handled.push(handle);
    const config = { agent_config: endpoint({ base_url: 'http://agent/v1', model_id: 'agent-m', api_key: key }) };
    await handle.bridge.get('models.config.put')!({ config }, { autoApprove: false });
    const state = (await handle.bridge.get('models.config.get')!(null, { autoApprove: false })) as {
      model_config: Record<string, unknown>;
    };
    const masked = (state.model_config['agent_config'] as Record<string, unknown>)['api_key'];

    // 携带掩码值整体回写（含槽内其余字段调整）：明文密钥保留
    await handle.bridge.get('models.config.put')!(
      {
        config: {
          agent_config: endpoint({ base_url: 'http://agent/v2', model_id: 'agent-m2', api_key: String(masked) }),
        },
      },
      { autoApprove: false },
    );
    const file = readPersisted(ctx.dir)['model_config'] as Record<string, unknown>;
    expect((file['agent_config'] as Record<string, unknown>)['api_key']).toBe(key);
    const view = (await handle.bridge.get('models.config.get')!(null, { autoApprove: false })) as {
      model_config: Record<string, unknown>;
    };
    const viewAgent = view.model_config['agent_config'] as Record<string, unknown>;
    expect(viewAgent['base_url']).toBe('http://agent/v2');
    expect(viewAgent['api_key']).toBe(maskKey(key));
    expect(JSON.stringify(view)).not.toContain(key);
  });

  it('put 形状校验：非法槽形状显式报错且不落盘', async () => {
    const ctx = tempContext();
    const handle = await createHost(
      { data_dir: ctx.dir, events_dir: ctx.events },
      { graph_recipe: echoGraphRecipe },
    );
    handled.push(handle);
    await expect(
      handle.bridge.get('models.config.put')!(
        { config: { agent_config: { base_url: 'http://x/v1' } } },
        { autoApprove: false },
      ),
    ).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(
      handle.bridge.get('models.config.put')!(null, { autoApprove: false }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(
      handle.bridge.get('models.config.put')!({}, { autoApprove: false }),
    ).rejects.toMatchObject({ code: 'invalid_params' });
    // 校验失败路径不产生运行配置文件（无持久化副作用）
    expect(() => readFileSync(runtime_config_path(ctx.dir))).toThrow();
  });
});

describe('models.config.reload（从文件重读 → 换槽 → 真对话切换）', () => {
  let handle: HostHandle;
  let ctx: DirCtx;
  const servers: FakeOpenAIServer[] = [];

  async function server(content: string): Promise<FakeOpenAIServer> {
    const s = new FakeOpenAIServer({ content });
    await s.start();
    servers.push(s);
    return s;
  }

  async function round(text: string): Promise<string> {
    const result = (await handle.bridge.get('rounds.send')!({ input: text }, { autoApprove: false })) as {
      reply: string;
    };
    return result.reply;
  }

  afterEach(async () => {
    if (handle !== undefined && handle !== null) await handle.dispose();
    for (const s of servers.splice(0)) await s.close();
  });

  it('运行中 overwrite config.json → reload → 下轮回合走新槽（旧链被替换）', async () => {
    ctx = tempContext();
    const serverA = await server('模型A');
    const serverB = await server('模型B');
    const keyA = 'sk-slot-a-plain-0123456789';
    const keyB = 'sk-slot-b-plain-0123456789';
    handle = await createHost(
      {
        data_dir: ctx.dir,
        events_dir: ctx.events,
        model_config: {
          agent_config: endpoint({ base_url: serverA.baseUrl, model_id: 'agent-a', api_key: keyA }),
        },
      },
      { graph_recipe: chatGraphRecipe },
    );

    // 冷启装配的槽真实可用
    expect(await round('hi')).toBe('模型A');

    // 落盘当前配置（models.config.put 即持久化）；随后文件级改成 B 槽
    await handle.bridge.get('models.config.put')!(
      {
        config: {
          agent_config: endpoint({ base_url: serverA.baseUrl, model_id: 'agent-a', api_key: keyA }),
        },
      },
      { autoApprove: false },
    );
    write_runtime_model_config(ctx.dir, {
      agent_config: endpoint({ base_url: serverB.baseUrl, model_id: 'agent-b', api_key: keyB }),
    });

    // reload：从 config.json 重读并应用 → 引擎重建（resolve_llm 用新槽）
    const reloaded = (await handle.bridge.get('models.config.reload')!(null, { autoApprove: false })) as {
      reloaded: boolean;
      model_config: Record<string, unknown>;
    };
    expect(reloaded.reloaded).toBe(true);
    expect(reloaded.model_config['agent_config']).toMatchObject({
      base_url: serverB.baseUrl,
      model_id: 'agent-b',
    });
    expect(JSON.stringify(reloaded)).not.toContain(keyB);

    // 真对话按新槽跑（旧 A 槽 LLM 链已被重建替换）
    expect(await round('again')).toBe('模型B');
    expect(serverB.requestCount).toBeGreaterThan(0);
    expect(serverA.requestCount).toBe(1);

    // get 掩码态反映重载后的槽；明文密钥不出进程
    const state = (await handle.bridge.get('models.config.get')!(null, { autoApprove: false })) as {
      model_config: Record<string, unknown>;
      roles: Record<string, { configured: boolean }>;
    };
    expect(state.roles).toEqual({ agent: { configured: true }, router: { configured: false } });
    const view = state.model_config['agent_config'] as Record<string, unknown>;
    expect(view['base_url']).toBe(serverB.baseUrl);
    expect(view['api_key']).toBe(maskKey(keyB));
    expect(JSON.stringify(state)).not.toContain(keyB);
  });
});
