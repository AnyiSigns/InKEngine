/**
 * serve e2e：模型配置旧扁平面经别名到 models.config.* 的端到端通道。
 *
 * 流程：spawn cli serve（指定 data_dir）→ /rpc 扁平 models_config_put 经
 * 别名落 models.config.put（校验+apply+原子落盘 config.json，回显掩码）→
 * models_config_get 回读（角色槽已配置态）→ models_refresh/model.reload
 * 别名同样可达（-32601 回归防线）→ 停进程 → 同一 data_dir 冷启再装配 →
 * 再 get 断言持久化配置仍在（api_key 明文只落文件、回显恒掩码）。
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RUNTIME_CONFIG_FILE } from '@ink-ts/host';
import { afterEach, describe, expect, it } from 'vitest';

import { firstJsonLine, spawnCli, type CliChild } from './_spawn.js';

const TEST_TOKEN = 'models-e2e-token-0123456789abcdef';

interface ListenLine {
  event: string;
  mode: string;
  url: string;
  ws: string;
  token: string;
}

interface RpcReply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

const children: CliChild[] = [];

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ink-cli-models-e2e-'));
}

async function startServe(data_dir: string): Promise<{ listen: ListenLine; child: CliChild }> {
  const child = spawnCli(['serve', '--port', '0', '--data-dir', data_dir, '--token', TEST_TOKEN]);
  children.push(child);
  const listen = (await firstJsonLine(child, 60_000)) as unknown as ListenLine;
  expect(listen.event).toBe('listen');
  return { listen, child };
}

async function stopServe(child: CliChild): Promise<void> {
  try {
    child.kill();
  } catch {
    // 已退出
  }
  try {
    await child.waitClose(8_000);
  } catch {
    // 收尾兜底
  }
}

async function callRpc(
  url: string,
  method: string,
  params: unknown,
): Promise<RpcReply> {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as RpcReply;
}

function agentEndpoint(): Record<string, unknown> {
  return {
    protocol: 'openai_compatible',
    base_url: 'http://agent.local/v1',
    model_id: 'agent-e2e',
    api_key: 'sk-e2e-agent-plain-0123456789',
  };
}

function routerEndpoint(): Record<string, unknown> {
  return {
    protocol: 'openai_compatible',
    base_url: 'http://router.local/v1',
    model_id: 'router-e2e',
    api_key: 'sk-e2e-router-plain-0123456789',
  };
}

afterEach(async () => {
  const list = children.splice(0);
  for (const child of list) await stopServe(child);
});

describe('serve e2e：models 旧扁平 ↔ models.config.* 别名通道', () => {
  it('models_config_put 落盘掩码回显 → get 已配置 → 冷启再装配仍生效', async () => {
    const dataDir = tempDir();

    // 首进程：扁平别名写入（web 设置页同形状载荷）
    const first = await startServe(dataDir);
    try {
      const put = await callRpc(first.listen.url, 'models_config_put', {
        config: {
          agent_config: agentEndpoint(),
          router_config: routerEndpoint(),
        },
      });
      expect(put.error).toBeUndefined();
      const putResult = put.result as { saved: boolean; model_config: Record<string, unknown> };
      expect(putResult.saved).toBe(true);
      expect(putResult.model_config['agent_config']).toMatchObject({ base_url: 'http://agent.local/v1' });
      expect(JSON.stringify(put)).not.toContain('sk-e2e-agent-plain-0123456789');

      // config.json 已原子落盘（明文只随 data_dir 本地权限）
      const file = JSON.parse(
        readFileSync(path.join(dataDir, RUNTIME_CONFIG_FILE), 'utf8'),
      ) as { model_config: Record<string, unknown> };
      const agent = file.model_config['agent_config'] as Record<string, unknown>;
      const router = file.model_config['router_config'] as Record<string, unknown>;
      expect(agent['api_key']).toBe('sk-e2e-agent-plain-0123456789');
      expect(router['api_key']).toBe('sk-e2e-router-plain-0123456789');

      // 扁平 get 别名回读：角色槽已配置 + 掩码
      const get = await callRpc(first.listen.url, 'models_config_get', {});
      expect(get.error).toBeUndefined();
      const state = get.result as {
        model_config: Record<string, unknown>;
        roles: Record<string, { configured: boolean }>;
      };
      expect(state.roles).toEqual({ agent: { configured: true }, router: { configured: true } });
      expect(JSON.stringify(get)).not.toContain('sk-e2e-');

      // models_refresh（保存+刷新）与 model.reload 别名均可达（非 -32601）
      const refresh = await callRpc(first.listen.url, 'models_refresh', {
        config: { agent_config: agentEndpoint() },
      });
      expect((refresh.result as { saved: boolean }).saved).toBe(true);
      const reload = await callRpc(first.listen.url, 'model.reload', {});
      expect((reload.result as { reloaded: boolean }).reloaded).toBe(true);
    } finally {
      await stopServe(first.child);
    }

    // 冷启再装配（同一 data_dir）：config.json 持久化槽读入 → 仍已配置
    const second = await startServe(dataDir);
    try {
      const get = await callRpc(second.listen.url, 'models_config_get', {});
      expect(get.error).toBeUndefined();
      const state = get.result as {
        model_config: Record<string, unknown>;
        roles: Record<string, { configured: boolean }>;
      };
      expect(state.roles).toEqual({ agent: { configured: true }, router: { configured: true } });
      expect(state.model_config['router_config']).toMatchObject({
        base_url: 'http://router.local/v1',
        model_id: 'router-e2e',
      });
      expect(JSON.stringify(get)).not.toContain('sk-e2e-');
    } finally {
      await stopServe(second.child);
    }
  }, 240_000);
});
