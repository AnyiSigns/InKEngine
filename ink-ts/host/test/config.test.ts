/**
 * host 运行配置读取单测：协议按角色槽双键 + 备用链；审批 fail-closed
 * （autoApprove 显式才放行）；目录定稿（events 落 data_dir/events）。
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENV_KEYS,
  HostConfigError,
  LLM_PROTOCOLS,
  normalize_endpoint,
  normalize_model_config,
  resolve_host_config,
} from '../src/config.js';
import type { HostConfigInput } from '../src/config.js';

describe('config 解析（角色槽/协议/目录）', () => {
  it('默认值：memory:// + autoApprove=false（fail-closed）+ events 落 data/events', () => {
    const config = resolve_host_config({}, {}, 'C:/work');
    expect(config.storage_uri).toBe('memory://');
    expect(config.autoApprove).toBe(false);
    expect(config.approval_timeout).toBeNull();
    expect(config.data_dir).toBe(path.join('C:/work', '.ink-host'));
    expect(config.events_dir).toBe(path.join('C:/work', '.ink-host', 'events'));
  });

  it('agent/router 双键 + {role}_fallback_configs 备用链按协议归一', () => {
    const input = {
      storage_uri: 'sqlite:///tmp/h.db',
      model_config: {
        agent_config: { protocol: 'openai_compatible', base_url: 'http://a/v1', model_id: 'm1' },
        agent_fallback_configs: [
          { adapter: 'anthropic_messages', base_url: 'http://b', model_id: 'm2' },
        ],
        router_config: { protocol: 'anthropic_messages', base_url: 'http://c', model_id: 'm3' },
      },
    };
    const config = resolve_host_config(input);
    const slots = config.model_config;
    expect((slots['agent_config'] as { adapter: string }).adapter).toBe('openai_compatible');
    expect((slots['agent_fallback_configs'] as Array<{ adapter: string }>)[0]!.adapter).toBe(
      'anthropic_messages',
    );
    expect((slots['router_config'] as { adapter: string }).adapter).toBe('anthropic_messages');
    expect(config.storage_uri).toBe('sqlite:///tmp/h.db');
  });

  it('非引擎角色槽键（如 audit_config）不按槽归一（原样透传；引擎不消费）', () => {
    const input = {
      model_config: {
        audit_config: { base_url: 'http://d', model_id: 'm4' },
      },
    } as unknown as HostConfigInput;
    const config = resolve_host_config(input);
    const raw = config.model_config['audit_config'] as Record<string, unknown> | undefined;
    expect(raw).toBeDefined();
    expect(raw!['adapter']).toBeUndefined();
  });

  it('endpoint 校验：未知协议 / 缺 base_url/model_id / 无 adapter 均显式报错', () => {
    expect(() =>
      normalize_endpoint({ protocol: 'weird', base_url: 'http://x', model_id: 'm' }, 'p'),
    ).toThrow(HostConfigError);
    expect(() => normalize_endpoint({ adapter: 'openai', model_id: 'm' }, 'p')).toThrow(
      HostConfigError,
    );
    expect(() => normalize_endpoint({ adapter: 'openai', base_url: 'http://x' }, 'p')).toThrow(
      HostConfigError,
    );
    expect(() => normalize_endpoint({ base_url: 'http://x', model_id: 'm' }, 'p')).toThrow(
      HostConfigError,
    );
  });

  it('环境覆盖：INK_STORAGE_URI / INK_AUTO_APPROVE / INK_EVENTS_DIR', () => {
    const env: NodeJS.ProcessEnv = {
      [ENV_KEYS.storageUri]: 'sqlite:///e.db',
      [ENV_KEYS.autoApprove]: 'true',
      [ENV_KEYS.eventsDir]: 'C:/ev',
    };
    const config = resolve_host_config({}, env, 'C:/work');
    expect(config.storage_uri).toBe('sqlite:///e.db');
    expect(config.autoApprove).toBe(true);
    expect(config.events_dir).toBe('C:/ev');
  });

  it('model_config 非法槽形状（fallback 非数组）报错', () => {
    expect(() =>
      normalize_model_config({ agent_fallback_configs: { not: 'array' } }),
    ).toThrow(HostConfigError);
  });

  it('内置协议枚举完整（三协议齐备）', () => {
    expect([...LLM_PROTOCOLS]).toEqual([
      'openai_compatible',
      'openai_responses',
      'anthropic_messages',
    ]);
  });
});
