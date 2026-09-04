/**
 * 补丁落点推导（core/self_application.py patch_path 移植）。
 *
 * 每类补丁落集状态的一个路径段（同名键整体替换）——组装结果即
 * 集状态全量，回退/版本化天然覆盖全部演化对象。
 */

import { GraphDefinitionError } from '../errors.js';
import type { Json } from '../json.js';
import type { PatchKind } from '../self_proposal/index.js';

import {
  _PATH_ARTIFACTS,
  _PATH_ENTITIES,
  _PATH_ENVIRONMENTS,
  _PATH_EVENT_TYPES,
  _PATH_HARNESS,
  _PATH_KNOWLEDGE,
  _PATH_RULES,
  _PATH_THEME,
  _PATH_TOOLS,
  _PATH_UI,
} from './constants.js';

/** Python truthy 口径取值：falsy（None/空容器/空串）回落缺省。 */
function pyPick(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value ? value : fallback;
  if (typeof value === 'number') return value !== 0 ? value : fallback;
  if (typeof value === 'string') return value.length > 0 ? value : fallback;
  if (Array.isArray(value)) return value.length > 0 ? value : fallback;
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0 ? value : fallback;
  }
  return value;
}

/** dict 字段只读取用（非 dict 形态归空容器，镜像 ``payload.get(..) or {}``）。 */
function dictOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 补丁落点推导：类型 × payload → 集状态路径与落链值。
 *
 * @returns [路径段数组, 落链值]（路径段全为字符串；值与 payload 同形）。
 */
export function patch_path(
  kind: PatchKind,
  payload: Record<string, unknown>,
): [readonly string[], Json] {
  if (kind === 'ui') {
    const spec = dictOf(pyPick(payload['spec'], {}));
    const name = (spec['name'] as string | undefined) || 'boot.panel';
    return [[_PATH_UI, name], spec as Json];
  }
  if (kind === 'theme') {
    return [[_PATH_THEME], pyPick(payload['tokens'], {}) as Json];
  }
  if (kind === 'tool') {
    const name = payload['name'];
    if (!name) {
      throw new GraphDefinitionError('tool 补丁缺 name（工具注册名）');
    }
    return [[_PATH_TOOLS, String(name)], payload as Json];
  }
  if (kind === 'rule') {
    const rule = dictOf(pyPick(payload['rule'], {}));
    const ruleId = (rule['id'] as string | undefined) || payload['rule_id'];
    if (!ruleId) {
      throw new GraphDefinitionError('rule 补丁缺规则 id');
    }
    return [[_PATH_RULES, String(ruleId)], rule as Json];
  }
  if (kind === 'knowledge') {
    const entry = dictOf(pyPick(payload['entry'], {}));
    const entryId = (entry['id'] as string | undefined) || payload['entry_id'];
    if (!entryId) {
      throw new GraphDefinitionError('knowledge 补丁缺条目 id');
    }
    return [[_PATH_KNOWLEDGE, String(entryId)], entry as Json];
  }
  if (kind === 'harness') {
    const definition = dictOf(pyPick(payload['definition'], {}));
    const name = definition['name'];
    if (!name) {
      throw new GraphDefinitionError('harness 补丁缺定义 name');
    }
    return [[_PATH_HARNESS, String(name)], definition as Json];
  }
  if (kind === 'event_type') {
    const name = payload['name'];
    if (!name) {
      throw new GraphDefinitionError('event_type 补丁缺 name');
    }
    return [[_PATH_EVENT_TYPES, String(name)], payload as Json];
  }
  if (kind === 'entity') {
    const entityId = payload['id'];
    if (!entityId) {
      throw new GraphDefinitionError('entity 补丁缺 id（实体注册名）');
    }
    return [[_PATH_ENTITIES, String(entityId)], payload as Json];
  }
  if (kind === 'environment') {
    const name = payload['name'];
    if (!name) {
      throw new GraphDefinitionError('environment 补丁缺 name');
    }
    return [[_PATH_ENVIRONMENTS, String(name)], payload as Json];
  }
  if (kind === 'artifact') {
    const artifactId = payload['artifact_id'];
    if (!artifactId) {
      throw new GraphDefinitionError('artifact 补丁缺 artifact_id');
    }
    return [[_PATH_ARTIFACTS, String(artifactId)], payload as Json];
  }
  throw new GraphDefinitionError(`未知补丁类型: ${String(kind)}`);
}
