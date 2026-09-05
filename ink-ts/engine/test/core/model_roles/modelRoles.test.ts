/**
 * core/model_roles 测试：角色常量与键归一、角色槽配置解析（agent 别名兼容/
 * 功能槽回落）、按角色槽建链与角色调用统计钩子。
 *
 * 语义检查点（替代原 tiers 测试的「数据驱动换挡位」语义，已废弃）：
 * - 固定槽（agent/router），无可变全局档位声明；未知/None 角色归
 *   一 agent（兜底锚点）；
 * - agent 槽兼容历史 main_config 别名（agent_config 优先）；功能槽未配置
 *   （缺失或显式空 {}）→ 显式回落 agent（source_role/fallback 标记来源，
 *   可观测不静默）；
 * - 角色槽已配置可带自身 fallback 链；回落时 = agent 配置 + agent 备用链；
 * - 统计按结构化条目记录（via_fallback 标记回落），merge/reset 可用。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE,
  MODEL_ROLES,
  ROLE_AGENT,
  ROLE_ROUTER,
  RoleModelStats,
  build_role_model_chain,
  resolve_role_model,
  role_call_label,
  role_config_key,
} from '../../../src/core/model_roles/index.js';
import type { JsonRecord } from '../../../src/core/json.js';

function model_config(extra: JsonRecord = {}): JsonRecord {
  return {
    agent_config: { adapter: 'openai_compat', model_id: 'agent', base_url: 'http://a' },
    router_config: { adapter: 'openai_compat', model_id: 'router', base_url: 'http://r' },
    ...extra,
  };
}

describe('角色常量与键归一（固定槽，无可变声明）', () => {
  it('MODEL_ROLES 固定双槽', () => {
    expect(MODEL_ROLES).toEqual(['agent', 'router']);
    expect(DEFAULT_ROLE).toBe('agent');
    expect(ROLE_AGENT).toBe('agent');
    expect(ROLE_ROUTER).toBe('router');
  });

  it('role_config_key：已知角色直取，未知/None 归一 agent', () => {
    expect(role_config_key(ROLE_AGENT)).toBe('agent_config');
    expect(role_config_key(ROLE_ROUTER)).toBe('router_config');
    expect(role_config_key('bogus')).toBe('agent_config');
    expect(role_config_key(null)).toBe('agent_config');
    expect(role_config_key(undefined)).toBe('agent_config');
    expect(role_config_key('main')).toBe('agent_config'); // 旧挡位名迁移归一
  });
});

describe('resolve_role_model agent 槽解析', () => {
  it('agent_config 存在 → 取自身配置，无回落标记', () => {
    const cfg = model_config();
    const resolved = resolve_role_model(cfg, ROLE_AGENT);
    expect(resolved.role).toBe('agent');
    expect(resolved.config).toEqual(cfg['agent_config']);
    expect(resolved.source_role).toBe('agent');
    expect(resolved.fallback).toBe(false);
    expect(resolved.fallbacks).toEqual([]);
  });

  it('历史别名 main_config 读入（agent_config 优先）', () => {
    const legacy = { main_config: { adapter: 'openai_compat', model_id: 'm' } };
    expect(resolve_role_model(legacy, ROLE_AGENT).config).toEqual(legacy['main_config']);
    const both = model_config({
      main_config: { adapter: 'openai_compat', model_id: 'alias' },
    });
    expect(resolve_role_model(both, ROLE_AGENT).config).toEqual(both['agent_config']);
  });

  it('agent_config 显式空 {} → 不视为已配置（无兜底可回落，config=null）', () => {
    const cfg = { agent_config: {} };
    const resolved = resolve_role_model(cfg, ROLE_AGENT);
    expect(resolved.config).toBeNull();
    expect(resolved.source_role).toBe('agent');
    expect(resolved.fallback).toBe(false);
    // 空 agent_config 不遮蔽别名：仍有非空 main_config 时生效
    const aliasAlive = { agent_config: {}, main_config: { model_id: 'm' } };
    expect(resolve_role_model(aliasAlive, ROLE_AGENT).config).toEqual({ model_id: 'm' });
  });

  it('agent 槽无配置 → config=null（调用方按无配置处理，不抛错）', () => {
    expect(resolve_role_model({}, ROLE_AGENT).config).toBeNull();
    expect(resolve_role_model(null, ROLE_AGENT).config).toBeNull();
  });

  it('历史嵌套 fallback_configs 兼容（取自主配置命中的那条 record）', () => {
    const cfg = model_config({
      agent_config: { model_id: 'agent', fallback_configs: [{ model_id: 'fb1' }] },
    });
    expect(resolve_role_model(cfg, ROLE_AGENT).fallbacks).toEqual([{ model_id: 'fb1' }]);
  });
});

describe('resolve_role_model 功能槽解析与回落', () => {
  it('router_config 存在 → 自身配置，无回落', () => {
    const cfg = model_config();
    const resolved = resolve_role_model(cfg, ROLE_ROUTER);
    expect(resolved.role).toBe('router');
    expect(resolved.config).toEqual(cfg['router_config']);
    expect(resolved.source_role).toBe('router');
    expect(resolved.fallback).toBe(false);
  });

  it('router 槽未配置（缺失）→ 显式回落 agent（source_role/fallback 标记）', () => {
    const cfg = { main_config: { adapter: 'openai_compat', model_id: 'm' } };
    const resolved = resolve_role_model(cfg, ROLE_ROUTER);
    expect(resolved.role).toBe('router');
    expect(resolved.config).toEqual(cfg['main_config']);
    expect(resolved.source_role).toBe('agent');
    expect(resolved.fallback).toBe(true);
  });

  it('router 槽显式空 {} → 与缺失同走回落 agent', () => {
    const cfg = { main_config: { adapter: 'openai_compat', model_id: 'm' }, router_config: {} };
    const resolved = resolve_role_model(cfg, ROLE_ROUTER);
    expect(resolved.config).toEqual(cfg['main_config']);
    expect(resolved.fallback).toBe(true);
  });

  it('未知角色归 agent 槽解析（防拼写错误静默换槽）', () => {
    const cfg = model_config();
    const resolved = resolve_role_model(cfg, 'bogus');
    expect(resolved.role).toBe('agent');
    expect(resolved.config).toEqual(cfg['agent_config']);
    expect(resolved.fallback).toBe(false);
  });

  it('顶层 {role}_fallback_configs 优先于历史嵌套形态', () => {
    const cfg = model_config({
      router_config: { model_id: 'router', fallback_configs: [{ model_id: 'nested' }] },
      router_fallback_configs: [{ model_id: 'top' }],
    });
    expect(resolve_role_model(cfg, ROLE_ROUTER).fallbacks).toEqual([{ model_id: 'top' }]);
    delete cfg['router_fallback_configs'];
    expect(resolve_role_model(cfg, ROLE_ROUTER).fallbacks).toEqual([{ model_id: 'nested' }]);
  });

  it('回落时备用链随 agent 槽解析（含历史 main_fallback_configs 别名）', () => {
    const cfg = {
      main_config: { adapter: 'openai_compat', model_id: 'm' },
      main_fallback_configs: [{ model_id: 'mfb' }],
    };
    const resolved = resolve_role_model(cfg, ROLE_ROUTER);
    expect(resolved.fallback).toBe(true);
    expect(resolved.fallbacks).toEqual([{ model_id: 'mfb' }]);
  });
});

describe('build_role_model_chain 按角色槽建链', () => {
  it('槽已配置 → [主配置, ...该槽备用]', () => {
    const cfg = model_config({
      router_fallback_configs: [{ model_id: 'fb1' }],
    });
    const chain = build_role_model_chain(cfg, ROLE_ROUTER);
    expect(chain).not.toBeNull();
    expect(chain!.configs[0]!.model_id).toBe('router');
    expect(chain!.configs[1]!.model_id).toBe('fb1');
  });

  it('回落时 = agent 配置 + agent 备用链', () => {
    const cfg = {
      main_config: { adapter: 'openai_compat', model_id: 'm' },
      main_fallback_configs: [{ model_id: 'mfb' }],
    };
    const chain = build_role_model_chain(cfg, ROLE_ROUTER);
    expect(chain).not.toBeNull();
    expect(chain!.configs[0]!.model_id).toBe('m');
    expect(chain!.configs[1]!.model_id).toBe('mfb');
  });

  it('全部缺配置（含回落）→ null（调用方按配置缺失兜底）', () => {
    expect(build_role_model_chain(null, ROLE_ROUTER)).toBeNull();
    expect(build_role_model_chain({}, ROLE_AGENT)).toBeNull();
    expect(build_role_model_chain({}, ROLE_ROUTER)).toBeNull();
  });

  it('未知角色建链按 agent 槽解析', () => {
    const cfg = model_config();
    const chain = build_role_model_chain(cfg, 'main');
    expect(chain!.configs[0]!.model_id).toBe('agent');
  });
});

describe('role_call_label / RoleModelStats 角色调用统计', () => {
  it('role_call_label：回落条目以 role→agent 标记', () => {
    expect(role_call_label('agent', false)).toBe('agent');
    expect(role_call_label('router', false)).toBe('router');
    expect(role_call_label('router', true)).toBe('router→agent');
    expect(role_call_label('bogus', false)).toBe('agent');
  });

  it('record/snapshot：结构化条目按角色累加，回落条目独立记账', () => {
    const stats = new RoleModelStats();
    stats.record(ROLE_AGENT);
    stats.record(ROLE_ROUTER, { via_fallback: false }, 2);
    stats.record(ROLE_ROUTER, { via_fallback: true });
    expect(stats.snapshot()).toEqual([
      { role: 'agent', via_fallback: false, count: 1 },
      { role: 'router', via_fallback: false, count: 2 },
      { role: 'router', via_fallback: true, count: 1 },
    ]);
  });

  it('未知角色归一 agent；非正计数忽略', () => {
    const stats = new RoleModelStats();
    stats.record('bogus');
    stats.record(ROLE_AGENT, {}, 0);
    stats.record(ROLE_AGENT, {}, -1);
    expect(stats.snapshot()).toEqual([{ role: 'agent', via_fallback: false, count: 1 }]);
  });

  it('reset 清零；merge 汇总另一实例计数', () => {
    const a = new RoleModelStats();
    a.record(ROLE_AGENT, {}, 2);
    a.reset();
    expect(a.snapshot()).toEqual([]);
    const b = new RoleModelStats();
    b.record(ROLE_ROUTER, { via_fallback: true }, 1);
    b.record(ROLE_AGENT, {}, 1);
    a.merge(b);
    expect(a.snapshot()).toEqual([
      { role: 'router', via_fallback: true, count: 1 },
      { role: 'agent', via_fallback: false, count: 1 },
    ]);
  });

  it('snapshot 返回防御拷贝（外部改写不影响内部计数）', () => {
    const stats = new RoleModelStats();
    stats.record(ROLE_AGENT);
    const shot = stats.snapshot();
    (shot[0] as { count: number }).count = 99;
    expect(stats.snapshot()).toEqual([{ role: 'agent', via_fallback: false, count: 1 }]);
  });
});
