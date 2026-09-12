/**
 * 临时作用域定义数据面（动态创建、无稳定身份、用完即散的执行身份）。
 *
 * 执行模型（§四 临时作用域 vs 目录作用域）：组织类路由的 `temp_scope` 参数 = 现场
 * 定义的目标作用域——相对目录作用域（填目录已注册 id，装载既有定义），临时作用域
 * 现场给出 persona/model/能力/契约，会话内不沉淀、组织档案不归因。结晶 = 把反复
 * 出现的临时协作转正为目录资产（受控注册，P5-γ），转正后同一协作直接走目录作用域。
 *
 * 本模块只做定义形态 + 校验 + 归一成实体记录（EntitySpec 是作用域资产的主载体，
 * 见 scope_directory.ts；临时作用域同样以实体记录形态进入执行层，序列化零新形态）。
 * id 不随定义携带——临时 id 由运行时生成（temp_scope 无稳定身份），校验只保证
 * 定义字段合法可装载。
 */

import { GraphDefinitionError } from '../../model/errors.js';
import { isRecord } from '../../model/json.js';
import { EntitySpec } from '../../core/entities/entities.js';
import { build_scope_asset } from '../../model/scopes/scope_directory.js';
import type { ScopeDecl } from '../../model/scopes/scope_spec.js';

/** 临时作用域 id 前缀（运行时生成的临时身份命名空间；无目录注册语义）。 */
export const TEMP_SCOPE_ID_PREFIX = 'temp_scope';

/** 临时作用域定义（现场声明；role 复用目录身份词或自定义；契约结构见 scope_spec）。 */
export interface TempScopeDef {
  role: string;
  label?: string;
  persona?: string;
  model?: Record<string, string> | null;
  capabilities?: readonly { id: string; class: string }[];
  contract?: {
    consumes?: readonly unknown[];
    produces?: readonly unknown[];
  };
  rules?: readonly string[];
  cost_tier?: string;
}

/** 校验辅助：报错统一入口。 */
function _bad(where: string, expected: string): never {
  throw new GraphDefinitionError(`临时作用域 ${where} 非法: 期望 ${expected}`);
}

function _opt_string(raw: unknown, where: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') _bad(where, 'string');
  return raw;
}

/**
 * 解析/校验临时作用域定义（字段类型 fail-closed；persona/label 可缺省）。
 * 契约/能力等嵌套结构在本层只做形状校验，详细声明校验复用 scope_spec 解析面
 * （build_scope_asset 的 EntitySpec 构造并不做该深度校验——装载时由实体目录
 * 同口径校验，本层维持「临时定义不比目录资产松」）。
 */
export function parse_temp_scope_def(data: unknown): TempScopeDef {
  if (!isRecord(data)) _bad('', 'dict');
  const role = data['role'];
  if (typeof role !== 'string' || role.trim() === '') {
    _bad('role', '非空字符串');
  }
  const model = data['model'];
  if (model !== undefined && model !== null && !isRecord(model)) {
    _bad('model', 'dict | null');
  }
  for (const key of ['capabilities', 'rules'] as const) {
    const list = data[key];
    if (list !== undefined && !Array.isArray(list)) _bad(key, 'list');
  }
  const contract = data['contract'];
  if (contract !== undefined && contract !== null && !isRecord(contract)) {
    _bad('contract', 'dict');
  }
  const out: TempScopeDef = { role: role.trim() };
  const label = _opt_string(data['label'], 'label');
  if (label !== undefined) out.label = label;
  const persona = _opt_string(data['persona'], 'persona');
  if (persona !== undefined) out.persona = persona;
  if (model !== undefined && model !== null) {
    out.model = { ...(model as Record<string, string>) };
  } else if (model !== null) {
    out.model = null;
  }
  if (Array.isArray(data['capabilities'])) {
    out.capabilities = data['capabilities'] as unknown as readonly {
      id: string;
      class: string;
    }[];
  }
  if (Array.isArray(data['rules'])) out.rules = data['rules'] as readonly string[];
  if (contract !== undefined && contract !== null) {
    out.contract = { ...(contract as TempScopeDef['contract']) };
  }
  const cost_tier = _opt_string(data['cost_tier'], 'cost_tier');
  if (cost_tier !== undefined) out.cost_tier = cost_tier;
  return out;
}

/** 从临时定义构造实体记录（id 由运行时生成；scope 声明块随构造归一）。 */
export function build_temp_scope_entity(def: TempScopeDef, id: string): EntitySpec {
  return build_scope_asset({
    id,
    role: def.role,
    label: def.label,
    persona: def.persona,
    model: def.model ?? null,
    capabilities: def.capabilities as ScopeDecl['capabilities'],
    rules: def.rules as string[],
    cost_tier: def.cost_tier,
    contract: def.contract as ScopeDecl['contract'],
  });
}

/** 生成临时作用域 id（运行时唯一；run_id + 序号，无空白/控制字符）。 */
export function temp_scope_id(run_id: string, seq: number): string {
  return `${TEMP_SCOPE_ID_PREFIX}:${run_id}:${seq}`;
}
