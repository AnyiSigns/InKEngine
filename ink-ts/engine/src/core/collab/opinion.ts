/**
 * 意见块数据形态与输入契约门禁（§7.4.4 输入契约的纯结构化面）。
 *
 * 意见块 = 协作者 scope 资产 produces 通道的产物（ScopeIoBinding.schema 声明
 * 形态，见 core/scopes/scope_spec.ts）：每块自带 schema?（来自其 scope 资产
 * contract.produces[].schema），门禁按 core/schema 校验器执行，不符剔除并记
 * 失败清单（fail-closed 但不抛错——剔除是裁决输入的合法结果，非定义错误）。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）。
 */

import { SchemaSpec, SchemaValidator } from '../../model/schema/schemaValidator.js';
import { isRecord, typeName } from '../../model/json.js';
import type { ScopeIoContract } from '../../model/scopes/scope_spec.js';

/** 单条意见块（{owner, content, seq} 主体 + 可选契约/结论字段）。 */
export interface OpinionEntry {
  /** 写入者作用域 id。 */
  owner: string;
  /** 意见原文。 */
  content: string;
  /** 序号（同一轮内单调；仲裁「先验」档的确定性 tiebreaker）。 */
  seq: number;
  /** 产出契约 schema（ScopeIoBinding.schema 形态；缺省 = 无契约不校验）。 */
  schema?: Record<string, unknown> | null;
  /** 显式结论标记（§7.4.4 ② 冲突检测主信号）。 */
  verdict?: string;
  /** 显式立场标记（verdict 缺席时的次信号）。 */
  stance?: string;
}

/** 剔除记录（记失败清单：形状/契约违规原因，可读可审计）。 */
export interface RejectedOpinion {
  owner: string;
  seq: number;
  content: string;
  /** 剔除原因清单（形状违规 or schema 违规逐条）。 */
  reasons: string[];
}

/** 解析结果：ok=false 时 reasons 记入失败清单。 */
export type ParsedOpinion =
  | { ok: true; entry: OpinionEntry }
  | { ok: false; reasons: string[] };

/**
 * 从 JSON 解析单条意见块（fail-closed 收集原因、不抛错）。
 * 期望 dict：{owner:str, content:str, seq:number[, schema:dict|null][, verdict:str][, stance:str]}。
 */
export function parse_opinion_entry(data: unknown): ParsedOpinion {
  if (!isRecord(data)) {
    return { ok: false, reasons: [`意见块须为 dict，收到 ${typeName(data)}`] };
  }
  const reasons: string[] = [];
  const owner = data['owner'];
  if (typeof owner !== 'string' || owner === '') reasons.push('owner 须为非空 str');
  const content = data['content'];
  if (typeof content !== 'string') reasons.push(`content 须为 str，收到 ${typeName(content)}`);
  const seq = data['seq'];
  if (typeof seq !== 'number' || !Number.isFinite(seq)) reasons.push('seq 须为有限 number');
  if (reasons.length > 0) return { ok: false, reasons };
  // 主体三字段已过守卫（坏形态均已提前 return），此处收窄安全
  const entry: OpinionEntry = { owner: owner as string, content: content as string, seq: seq as number };
  for (const key of ['verdict', 'stance'] as const) {
    const value = data[key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value !== '') {
      entry[key] = value;
    } else {
      reasons.push(`${key} 须为非空 str`);
    }
  }
  const schema = data['schema'];
  if (schema !== undefined) {
    if (schema === null || isRecord(schema)) {
      entry.schema = schema;
    } else {
      reasons.push(`schema 须为 dict | null，收到 ${typeName(schema)}`);
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, entry };
}

/** 门禁校验载荷：意见块的数据面 dict（schema 字段自身不参与校验）。 */
export function opinion_payload(entry: OpinionEntry): Record<string, unknown> {
  const payload: Record<string, unknown> = { owner: entry.owner, content: entry.content, seq: entry.seq };
  if (entry.verdict !== undefined) payload['verdict'] = entry.verdict;
  if (entry.stance !== undefined) payload['stance'] = entry.stance;
  return payload;
}

const _VALIDATOR = new SchemaValidator();

function _first_produces_schema(contract: ScopeIoContract | null): Record<string, unknown> | null {
  for (const binding of contract?.produces ?? []) {
    if (binding.schema !== undefined && binding.schema !== null) return binding.schema;
  }
  return null;
}

/**
 * 输入契约门禁（§7.4.4：不符剔除并记失败清单；复用 core/schema 校验器）。
 * schema 来源：entry.schema 优先；缺省回退协作方 scope 资产 produces 契约的
 * 首个带 schema 绑定；两者皆无 = 无契约不校验（返回空违规清单）。
 * 校验载荷 = opinion_payload(entry)；schema 声明本身非法同样记失败。
 */
export function validate_opinion_schema(entry: OpinionEntry, contract?: ScopeIoContract | null): string[] {
  const schemaDict =
    entry.schema !== undefined && entry.schema !== null ? entry.schema : _first_produces_schema(contract ?? null);
  if (schemaDict === null) return [];
  let spec: SchemaSpec;
  try {
    spec = SchemaSpec.from_dict(schemaDict);
  } catch (exc) {
    return [`schema 声明非法: ${exc instanceof Error ? exc.message : String(exc)}`];
  }
  return _VALIDATOR.validate(spec, opinion_payload(entry));
}
