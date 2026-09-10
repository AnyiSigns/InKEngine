/**
 * 组织先验覆盖资产（org_priors 集合条目形态：route / shortcut / weight）。
 *
 * 组织先验覆盖 = 叠加在出厂/既有先验素材之上的演化行（以 id 为键），是
 * 「受控进化」在组织先验域的持久化落位：
 *
 * - route 覆写：整条先验路线替换/新增（委托策略先验更新；id = 先验模式 id，
 *   payload.pattern 全量覆写同一 id 的模式）；
 * - shortcut 直连：常胜模式短路化沉淀（跳过中继 R 的 A→C 直连入口，
 *   payload 携带 from/to/skip_scope；运行时在对应转场决策上取用）；
 * - weight 权重标记：对转场/模式的偏好权重调整（低使用/高失败降权 → 降
 *   weight；常胜保持 → 加权；payload.ref = 目标引用键）。
 *
 * 纯数据面（JSON 进 JSON 出）：本模块只做词汇 + 类型 + 校验 + 序列化，不含
 * 任何执行语义。集合名 org_priors:<set_id> 为受守卫前缀（GuardedStorage 拒绝
 * 旁路直写），唯一写入通道 = 受控演化应用管线（审批 → EvolutionWriter），
 * 运行时（执行层）经同样受控通道读取覆盖态——降权/短路不裸奔上线。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord } from '../json.js';
import { scope_prior_from_dict, scope_prior_to_dict, type ScopePriorPattern } from './scope_priors.js';

/** 组织先验覆盖资产集合前缀（受守卫前缀 org_priors:）。 */
export const ORG_PRIORS_COLLECTION_PREFIX = 'org_priors:';

/** 组织先验覆盖集合名（按集隔离；缺省集 = '-'，与实体注册表缺省同口径）。 */
export function org_priors_collection(set_id = '-'): string {
  return `${ORG_PRIORS_COLLECTION_PREFIX}${set_id}`;
}

// ── 覆盖类型 ──

/** route 覆写：整条先验模式覆写/新增（更新委托策略先验）。 */
export interface OrgPriorRoutePayload {
  kind: 'route';
  pattern: ScopePriorPattern;
}

/** shortcut 直连：跳过中继 skip_scope 的 A→C 直连入口（短路化沉淀）。 */
export interface OrgPriorShortcutPayload {
  kind: 'shortcut';
  from: string;
  to: string;
  skip_scope: string;
  /** 直连偏好权重（0,1]；缺省 = 不加权）。 */
  weight?: number;
}

/** weight 权重标记：对目标引用（转场/先验模式）的偏好权重调整。 */
export interface OrgPriorWeightPayload {
  kind: 'weight';
  ref: string;
  weight: number;
}

/** 覆盖行载荷联合（kind 判别）。 */
export type OrgPriorOverlayPayload =
  | OrgPriorRoutePayload
  | OrgPriorShortcutPayload
  | OrgPriorWeightPayload;

/** 覆盖 id 的稳定编码（记录键 + 引用；JSON 数组编码防作用域名歧义）。 */
export function shortcut_overlay_id(from: string, skip_scope: string, to: string): string {
  return JSON.stringify(['shortcut', from, skip_scope, to]);
}

/** 权重覆盖行 id（ref 透传编码）。 */
export function weight_overlay_id(ref: string): string {
  return JSON.stringify(['weight', ref]);
}

/** 权重取值域校验：>0 且 ≤1（0 或负权 = 直接下架，不属降权语义）。 */
function valid_weight(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1;
}

function _bad(where: string, expected: string): never {
  throw new GraphDefinitionError(`先验覆盖 ${where} 非法: 期望 ${expected}`);
}

function _need_nonempty(where: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    _bad(where, '非空字符串');
  }
  return value;
}

/**
 * 组织先验覆盖行（冻结数据：kind + 稳定 id + 载荷）。
 * route id = 先验模式 id；shortcut/weight id = JSON 稳定编码（见上方
 * 编码函数），与载荷同源、禁止手工不一致。
 */
export class OrgPriorOverlay {
  readonly kind: 'route' | 'shortcut' | 'weight';
  readonly id: string;
  readonly payload: OrgPriorOverlayPayload;

  constructor(kind: 'route' | 'shortcut' | 'weight', id: string, payload: OrgPriorOverlayPayload) {
    this.kind = kind;
    this.id = id;
    this.payload = payload;
    Object.freeze(this);
  }

  to_dict(): Record<string, unknown> {
    if (this.payload.kind === 'route') {
      return { id: this.id, kind: 'route', pattern: scope_prior_to_dict(this.payload.pattern) };
    }
    if (this.payload.kind === 'shortcut') {
      const out: Record<string, unknown> = {
        id: this.id,
        kind: 'shortcut',
        from: this.payload.from,
        to: this.payload.to,
        skip_scope: this.payload.skip_scope,
      };
      if (this.payload.weight !== undefined) out['weight'] = this.payload.weight;
      return out;
    }
    return { id: this.id, kind: 'weight', ref: this.payload.ref, weight: this.payload.weight };
  }

  static from_dict(data: unknown): OrgPriorOverlay {
    if (!isRecord(data)) _bad('', 'dict');
    const id = _need_nonempty('id', data['id']);
    const kind = data['kind'];
    if (kind === 'route') {
      const rawPattern = data['pattern'];
      if (!isRecord(rawPattern)) _bad('route.pattern', 'dict');
      const pattern = scope_prior_from_dict(rawPattern);
      if (pattern.id !== id) {
        _bad(`route(${id}).pattern.id`, `与行 id 一致（收到 ${pattern.id}）`);
      }
      return new OrgPriorOverlay('route', id, { kind: 'route', pattern });
    }
    if (kind === 'shortcut') {
      const from = _need_nonempty('shortcut.from', data['from']);
      const to = _need_nonempty('shortcut.to', data['to']);
      const skip = _need_nonempty('shortcut.skip_scope', data['skip_scope']);
      if (from === skip || to === skip) {
        _bad('shortcut', 'skip_scope 须与 from/to 不同（跳过的是中继作用域）');
      }
      const rawWeight = data['weight'];
      let weight: number | undefined;
      if (rawWeight !== undefined) {
        if (typeof rawWeight !== 'number' || !valid_weight(rawWeight)) {
          _bad('shortcut.weight', '(0,1] 内数值');
        }
        weight = rawWeight;
      }
      const payload: OrgPriorShortcutPayload = { kind: 'shortcut', from, to, skip_scope: skip };
      if (weight !== undefined) payload.weight = weight;
      if (id !== shortcut_overlay_id(from, skip, to)) {
        _bad('shortcut.id', '与 from/skip_scope/to 编码一致');
      }
      return new OrgPriorOverlay('shortcut', id, payload);
    }
    if (kind === 'weight') {
      const ref = _need_nonempty('weight.ref', data['ref']);
      const weight = data['weight'];
      if (typeof weight !== 'number' || !valid_weight(weight)) {
        _bad('weight.weight', '(0,1] 内数值');
      }
      if (id !== weight_overlay_id(ref)) {
        _bad('weight.id', '与 ref 编码一致');
      }
      return new OrgPriorOverlay('weight', id, { kind: 'weight', ref, weight });
    }
    _bad('kind', 'route | shortcut | weight');
  }
}

// ── 便捷构造（受控演化应用/择优适配经此建行；校验 fail-closed）──

/** 构造 route 覆写行（id = 先验模式 id；非法先验结构抛错）。 */
export function route_overlay(pattern: ScopePriorPattern): OrgPriorOverlay {
  return new OrgPriorOverlay('route', pattern.id, { kind: 'route', pattern });
}

/** 构造 shortcut 直连行（id = 三作用域稳定编码；weight 可选）。 */
export function shortcut_overlay(
  from: string,
  to: string,
  skip_scope: string,
  weight?: number,
): OrgPriorOverlay {
  if (from.trim() === '' || to.trim() === '' || skip_scope.trim() === '') {
    throw new GraphDefinitionError('先验覆盖 shortcut 非法: from/to/skip_scope 须为非空字符串');
  }
  if (from === skip_scope || to === skip_scope) {
    throw new GraphDefinitionError('先验覆盖 shortcut 非法: skip_scope 须与 from/to 不同（跳过的是中继作用域）');
  }
  if (weight !== undefined && !valid_weight(weight)) {
    throw new GraphDefinitionError(`shortcut 权重非法: ${weight}（须 (0,1]）`);
  }
  const payload: OrgPriorShortcutPayload = { kind: 'shortcut', from, to, skip_scope };
  if (weight !== undefined) payload.weight = weight;
  return new OrgPriorOverlay('shortcut', shortcut_overlay_id(from, skip_scope, to), payload);
}

/** 构造 weight 权重标记行（降权/加权；ref = 目标引用键）。 */
export function weight_overlay(ref: string, weight: number): OrgPriorOverlay {
  if (!valid_weight(weight)) {
    throw new GraphDefinitionError(`权重非法: ${weight}（须 (0,1]）`);
  }
  return new OrgPriorOverlay('weight', weight_overlay_id(ref), { kind: 'weight', ref, weight });
}
