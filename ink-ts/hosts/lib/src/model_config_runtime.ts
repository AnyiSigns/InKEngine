/**
 * host 运行模型配置管理：运行期变更合并、掩码回显、data_dir/config.json 持久化。
 *
 * 配置读取/形状校验在 config.ts（normalize_model_config）；本模块只负责
 * 「运行期变更」的三件事：
 * - 变更合并：以入参出现的槽为准合并进既有 model_config（agent/router 槽
 *   与 `{role}_fallback_configs` 备用链；其余键原样透传）。端点缺 api_key
 *   沿用既有明文（设置页「留空不更新」语义）；api_key = 既有密钥掩码回传
 *   视为未变更（防回显-回写把明文密钥击穿成掩码）。
 * - 掩码回显：get/put/reload 一律只出掩码态（任何嵌套 api_key 均掩码，
 *   规则与检索密钥一致：前 4 字符 + '****'），明文只在进程内与 config.json。
 * - 持久化：角色槽端点形状落 data_dir/config.json（{ model_config: ... }，
 *   api_key 随 data_dir 本地权限落盘）；cli 装配端启动读同一文件合并，
 *   变更原子写回（临时文件 + 同卷 rename，防半写）。
 *
 * 角色槽已配置态与引擎判定同源（model_roles.resolve_role_model）：功能槽
 * 显式回落 agent 不视为该槽已配置（可观测不静默）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolve_role_model } from '@ink-ts/engine';

import { isFallbackListKey, ROLE_SLOT_KEYS } from './config.js';
import { maskKey } from './search/keys.js';

/** 运行配置文件（data_dir 下；存 model_config 角色槽/备用链端点形状）。 */
export const RUNTIME_CONFIG_FILE = 'config.json';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 模型配置回显态（models.config.get 的模型面 + 角色槽已配置态）。 */
export interface ModelConfigState {
  /** 掩码态当前值（任何嵌套 api_key 只出掩码；无明文外泄）。 */
  model_config: Record<string, unknown>;
  /** 角色槽已配置态（agent/router；与引擎 resolve_role_model 判定同源）。 */
  roles: Record<string, { configured: boolean }>;
}

/** 运行配置文件绝对路径（data_dir 下 config.json）。 */
export function runtime_config_path(data_dir: string): string {
  return path.join(data_dir, RUNTIME_CONFIG_FILE);
}

/** 深度掩码：任何键名为 api_key 的字符串值替换为掩码（数组/对象递归）。 */
function maskNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskNested);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = key === 'api_key' && typeof entry === 'string' ? maskKey(entry) : maskNested(entry);
    }
    return out;
  }
  return value;
}

/** 掩码态副本（回显统一出口；不改动原 record）。 */
export function masked_model_config(model_config: Record<string, unknown>): Record<string, unknown> {
  return maskNested(model_config) as Record<string, unknown>;
}

/** 端点变更合并：缺 api_key 沿用既有明文；掩码回传 = 未变更，保留明文。 */
function reconcile_endpoint(
  incoming: Record<string, unknown>,
  prev: Record<string, unknown> | null,
): Record<string, unknown> {
  if (prev === null) return incoming;
  const out = { ...incoming };
  const value = incoming['api_key'];
  const current = prev['api_key'];
  if (value === undefined) {
    if (typeof current === 'string') out['api_key'] = current;
    return out;
  }
  if (typeof value === 'string' && typeof current === 'string' && value === maskKey(current)) {
    out['api_key'] = current;
  }
  return out;
}

/** 变更合并：入参出现的槽/备用链覆盖，缺席槽保留既有；余键原样透传。 */
export function merge_model_config(
  prev: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...prev };
  for (const [key, value] of Object.entries(incoming)) {
    if ((ROLE_SLOT_KEYS as readonly string[]).includes(key)) {
      out[key] = isRecord(value)
        ? reconcile_endpoint(value, isRecord(prev[key]) ? prev[key] : null)
        : value;
    } else if (isFallbackListKey(key)) {
      const before = Array.isArray(prev[key]) ? prev[key] : [];
      out[key] = Array.isArray(value)
        ? value.map((entry, index) =>
            isRecord(entry)
              ? reconcile_endpoint(entry, isRecord(before[index]) ? before[index] : null)
              : entry,
          )
        : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 角色槽已配置态（各自槽位非空才算配置；功能槽回落 agent 不算已配置）。 */
export function role_config_status(
  model_config: Record<string, unknown>,
): Record<string, { configured: boolean }> {
  const roles: Record<string, { configured: boolean }> = {};
  for (const role of ['agent', 'router']) {
    const resolved = resolve_role_model(
      model_config as unknown as Parameters<typeof resolve_role_model>[0],
      role,
    );
    roles[role] = { configured: resolved.config !== null && !resolved.fallback };
  }
  return roles;
}

/** 回显态组装（get/put/reload 统一出口）。 */
export function model_config_state(model_config: Record<string, unknown>): ModelConfigState {
  return { model_config: masked_model_config(model_config), roles: role_config_status(model_config) };
}

/** 读运行配置文件（缺失/非 JSON/非对象 = null；损坏不阻断启动）。 */
export function load_runtime_config(data_dir: string): Record<string, unknown> | null {
  const file = runtime_config_path(data_dir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 读持久化 model_config（config.json 无 model_config 键/非对象 = null）。 */
export function load_persisted_model_config(data_dir: string): Record<string, unknown> | null {
  const config = load_runtime_config(data_dir);
  if (config === null) return null;
  const modelConfig = config['model_config'];
  return isRecord(modelConfig) ? modelConfig : null;
}

/** 原子写回运行配置（临时文件 + 同卷 rename；apply 后调用，cli 冷启读取）。 */
export function write_runtime_model_config(
  data_dir: string,
  model_config: Record<string, unknown>,
): void {
  mkdirSync(data_dir, { recursive: true });
  const file = runtime_config_path(data_dir);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ model_config }, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}
