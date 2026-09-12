/**
 * 临时协作结晶评估器（执行模型 §五「结晶」+ §六「孵化（统计结晶）同一条受控
 * 通道」：反复出现的临时协作模式 → 转正为目录作用域资产）。
 *
 * Sighting = 临时作用域子执行的完成回执（宿主 convene 使用临时作用域后落
 * org.temp_sightings 集合的观测行：role / def 摘要 / outcome / times）。模式 =
 * (role × model 引用) 分组：同一临时协作模式反复出现且稳定完成时，本评估器把
 * 它结晶为 **add_scope 提案**（provenance=org_pruning，附证据摘要），供既有受控
 * 通道消费——adoption_gate 对 org_pruning 来源的新增强制隔离试跑闸（未装配执行器
 * fail-closed），ControlledEvolutionApplier 过闸过审批后走补丁链落库（§五受控
 * 注册/下架同通道）。评估器本身是**纯函数**（JSON 进、提案出、零副作用）；
 * 执行侧 applier / trial runner 全部由调用方注入（宿主装配），本模块不自装配。
 *
 * 阈值理由（命名常量见下）：MIN_SIGHTINGS = 5 —— 结晶把临时模式晋升为影响所有
 * 未来执行的目录资产，转正门槛不高于择优下架的证据线 ORG_RETIRE_MIN_EVIDENCE=5
 * （既有阈值体系验证的小样本下限），不足则单次侥幸/偶发失败未被稀释；
 * MIN_SUCCESS_RATE = 0.8 —— 介于常胜升级线 0.9（维持/加权信号）与降权触发线
 * 0.5/0.6 之间：转正须明显可信而非常胜级严格；degraded 计分母不计分子（完成形态
 * 有缺，不占转正正面票）。目录感知：目标 id 已在目录现状 = 跳过（转正只发生
 * 一次，修订走 update_scope 高影响变更强制闸）。
 */

import { ENTITY_ID_MAX_LENGTH } from '../../core/entities/entities.js';
import { isRecord } from '../../model/json.js';
import { build_scope_asset } from '../../model/scopes/scope_directory.js';
import type { ScopeCapability, ScopeIoContract } from '../../model/scopes/scope_spec.js';
import { PROVENANCE_ORG, EvolutionProposal } from './evolution_proposal.js';

/** 结晶转正的最少 sighting 次数（含 times 加权；理由见头注）。 */
export const CRYSTALLIZE_MIN_SIGHTINGS = 5;
/** 结晶转正的最低成功率（success/total；degraded 计入分母。理由见头注）。 */
export const CRYSTALLIZE_MIN_SUCCESS_RATE = 0.8;
/** 结晶资产 id 前缀（目录里一眼识别「转正来的模式」；防与出厂身份撞名）。 */
export const CRYSTALLIZE_ID_PREFIX = 'crystal:';
/** 证据摘要采样的 run_id 上限（审批卡/审计可读性封顶）。 */
export const CRYSTALLIZE_SAMPLE_CAP = 8;
/** 证据出处标识（与被结晶模式的数据来源声明；宿主集合 org.temp_sightings 对齐）。 */
export const CRYSTALLIZE_EVIDENCE_SOURCE = 'temp_sightings';

/** 临时协作完成形态（与执行轨迹 TrailOutcome 同词表，不反向 import 运行时）。 */
export const TEMP_SIGHTING_OUTCOMES = ['success', 'failure', 'degraded'] as const;
export type TempSightingOutcome = (typeof TEMP_SIGHTING_OUTCOMES)[number];

// ── sighting 记录形态与评估输入/输出（宿主 append、评估器消费）──

/** 一条归一后的临时协作观测（def = 临时作用域定义摘要：persona/model 等）。 */
export interface TempSighting {
  role: string;
  /** 临时作用域定义摘要（label/persona/model/capabilities/rules/cost_tier/contract）。 */
  def: Record<string, unknown>;
  outcome: TempSightingOutcome;
  /** 观测计次（幂等键防重后仍允许批前聚合；非正/非有限回退 1）。 */
  times: number;
  run_id: string | null;
  ts: number | null;
}

/** 宽松归一一条 sighting 原始记录（存储行/测试字面量；非法形态 = null 不抛错）。 */
export function normalize_temp_sighting(data: unknown): TempSighting | null {
  if (!isRecord(data)) return null;
  const role = data['role'];
  if (typeof role !== 'string' || role.trim() === '') return null;
  const outcome = data['outcome'];
  if (
    typeof outcome !== 'string'
    || !(TEMP_SIGHTING_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return null;
  }
  const rawDef = data['def'];
  const timesRaw = data['times'];
  const times =
    typeof timesRaw === 'number' && Number.isFinite(timesRaw) && timesRaw > 0
      ? Math.floor(timesRaw)
      : 1;
  const rawRunId = data['run_id'];
  const rawTs = data['ts'];
  return {
    role: role.trim(),
    def: isRecord(rawDef) ? { ...rawDef } : {},
    outcome: outcome as TempSightingOutcome,
    times,
    run_id: typeof rawRunId === 'string' && rawRunId !== '' ? rawRunId : null,
    ts: typeof rawTs === 'number' && Number.isFinite(rawTs) ? rawTs : null,
  };
}

/** 目录现状（结晶只对准未注册模式；宿主传实体目录活跃 id 全集即可）。 */
export interface CrystallizeCatalogState {
  entity_ids: readonly string[];
}

/** 阈值覆写（非法值回退缺省；装配/测试可按需收紧或放宽做边界验证）。 */
export interface CrystallizeOptions {
  min_sightings?: number;
  min_success_rate?: number;
  id_prefix?: string;
  sample_cap?: number;
}

/** 单模式观测统计 + 判定结果（proposed = 产出提案；其余带原因）。 */
export interface CrystallizePatternStat {
  ref: string;
  role: string;
  model: Record<string, string> | null;
  sightings: number;
  success: number;
  failure: number;
  degraded: number;
  success_rate: number;
  asset_id: string | null;
  status: 'proposed' | 'skipped';
  reason: string;
}

/** 评估产出：可执行提案清单 + 全模式统计（含未达标与跳过行，审计可读）。 */
export interface CrystallizeEvaluation {
  proposals: EvolutionProposal[];
  patterns: CrystallizePatternStat[];
}

function positive_or(value: number | undefined, fallback: number, upper = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > upper) {
    return fallback;
  }
  return value;
}

function rate(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 模型引用规范化为分组键（键排序连接；缺省/非 dict = '' = 会话默认档）。 */
function model_key(def: Record<string, unknown>): string {
  const model = def['model'];
  if (!isRecord(model)) return '';
  const keys = Object.keys(model).filter((k) => model[k] !== undefined && model[k] !== null);
  keys.sort();
  return keys.map((k) => `${k}=${String(model[k])}`).join('&');
}

function clean_model(def: Record<string, unknown>): Record<string, string> | null {
  const model = def['model'];
  if (!isRecord(model)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(model)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 目录 id 片段规范化（小写、空白折叠为连字符、去控制字符；无空白=可过实体 id 校验）。 */
function slug(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 结晶资产 id（crystal:<role>[@<provider>-<model_id>]；超长截断到实体 id 上限）。 */
export function crystallize_asset_id(
  role: string,
  model: Record<string, string> | null,
  prefix: string,
): string {
  const base = slug(role);
  let id = `${prefix}${base === '' ? 'unnamed' : base}`;
  if (model !== null) {
    const provider = slug(model['provider'] ?? '');
    const modelId = slug(model['model_id'] ?? '');
    const tail = [provider, modelId].filter((s) => s !== '').join('-');
    if (tail !== '') id += `@${tail}`;
  }
  return id.slice(0, ENTITY_ID_MAX_LENGTH);
}

interface PatternGroup {
  ref: string;
  role: string;
  def: Record<string, unknown>;
  model: Record<string, string> | null;
  sightings: number;
  success: number;
  failure: number;
  degraded: number;
  sample_run_ids: string[];
}

// ── 评估主入口（纯函数，不改任何目录；输出确定性 = 首次出现序）──

/**
 * 评估临时协作 sighting 清单 → 达标模式产 add_scope 提案（org-pruning 来源、
 * 附证据摘要）。非法记录跳过并在 patterns 记 malformed 行；不抛错。
 */
export function evaluate_temp_sightings(
  sightings: readonly unknown[],
  catalog: CrystallizeCatalogState | null = null,
  options: CrystallizeOptions = {},
): CrystallizeEvaluation {
  const minSightings = Math.floor(positive_or(options.min_sightings, CRYSTALLIZE_MIN_SIGHTINGS));
  const minRate = positive_or(options.min_success_rate, CRYSTALLIZE_MIN_SUCCESS_RATE, 1);
  const prefix = typeof options.id_prefix === 'string' ? options.id_prefix : CRYSTALLIZE_ID_PREFIX;
  const sampleCap = Math.floor(positive_or(options.sample_cap, CRYSTALLIZE_SAMPLE_CAP));
  const registered = new Set(
    (catalog?.entity_ids ?? []).filter((id): id is string => typeof id === 'string'),
  );

  const groups = new Map<string, PatternGroup>();
  const patterns: CrystallizePatternStat[] = [];
  for (let i = 0; i < sightings.length; i++) {
    const sighting = normalize_temp_sighting(sightings[i]);
    if (sighting === null) {
      patterns.push({
        ref: `row#${i}`, role: '', model: null, sightings: 0, success: 0, failure: 0,
        degraded: 0, success_rate: 0, asset_id: null, status: 'skipped', reason: 'malformed',
      });
      continue;
    }
    const key = `${sighting.role}\u001f${model_key(sighting.def)}`;
    let group = groups.get(key);
    if (group === undefined) {
      const modelKey = model_key(sighting.def);
      group = {
        ref: modelKey === '' ? sighting.role : `${sighting.role}@${modelKey}`,
        role: sighting.role,
        def: sighting.def,
        model: clean_model(sighting.def),
        sightings: 0,
        success: 0,
        failure: 0,
        degraded: 0,
        sample_run_ids: [],
      };
      groups.set(key, group);
    }
    // 聚合语义取**最新一条**定义摘要（同模式反复出现，persona/契约按最近设定转正）
    group.def = sighting.def;
    group.model = clean_model(sighting.def) ?? group.model;
    group.sightings += sighting.times;
    group[sighting.outcome] += sighting.times;
    if (sighting.run_id !== null && !group.sample_run_ids.includes(sighting.run_id)) {
      group.sample_run_ids.push(sighting.run_id);
      if (group.sample_run_ids.length > sampleCap) group.sample_run_ids.shift();
    }
  }

  const issued = new Set<string>();
  const proposals: EvolutionProposal[] = [];
  for (const group of groups.values()) {
    const total = group.sightings;
    const successRate = total > 0 ? rate(group.success / total) : 0;
    const assetId = crystallize_asset_id(group.role, group.model, prefix);
    const stat: CrystallizePatternStat = {
      ref: group.ref,
      role: group.role,
      model: group.model,
      sightings: total,
      success: group.success,
      failure: group.failure,
      degraded: group.degraded,
      success_rate: successRate,
      asset_id: assetId,
      status: 'skipped',
      reason: '',
    };
    patterns.push(stat);
    if (total < minSightings) {
      stat.reason = `below_min_sightings（观测 ${total} < 阈值 ${minSightings}）`;
      continue;
    }
    if (successRate < minRate) {
      stat.reason = `below_success_rate（成功率 ${percent(successRate)} < 阈值 ${percent(minRate)}）`;
      continue;
    }
    if (registered.has(assetId)) {
      stat.reason = `already_registered（目录现状已含 ${assetId}；修订请走 update_scope）`;
      continue;
    }
    if (issued.has(assetId)) {
      stat.reason = `id_conflict（同批内 ${assetId} 已由先现模式占用）`;
      continue;
    }
    try {
      const asset = build_crystallized_asset(assetId, group);
      proposals.push(
        new EvolutionProposal({
          kind: 'add_scope',
          payload: { asset },
          provenance: PROVENANCE_ORG,
          confidence: successRate,
          evidence: {
            source: CRYSTALLIZE_EVIDENCE_SOURCE,
            ref: stat.ref,
            role: group.role,
            model: group.model,
            sightings: total,
            success: group.success,
            failure: group.failure,
            degraded: group.degraded,
            success_rate: successRate,
            thresholds: { min_sightings: minSightings, min_success_rate: minRate },
            sample_run_ids: [...group.sample_run_ids],
          },
          rationale:
            `临时协作结晶：role「${group.role}」成功率 ${percent(successRate)}`
            + `（${group.success}/${total} 次 sighting，阈值 ≥${minSightings} 次且 ≥${percent(minRate)}）`
            + ` → 转正为目录作用域资产 ${assetId}（org-pruning 统计结晶，受控注册/补丁链）`,
        }),
      );
      issued.add(assetId);
      stat.status = 'proposed';
      stat.reason = 'proposed';
    } catch (error) {
      stat.asset_id = null;
      stat.reason = `asset_invalid：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { proposals, patterns };
}

/** 由模式聚合构造结晶资产记录（作用域声明同通道 build_scope_asset；非法即抛，由评估器记 asset_invalid）。 */
function build_crystallized_asset(assetId: string, group: PatternGroup): Record<string, unknown> {
  const def = group.def;
  const opt = (key: string): string | undefined => {
    const value = def[key];
    return typeof value === 'string' ? value : undefined;
  };
  const spec = build_scope_asset({
    id: assetId,
    role: group.role,
    label: opt('label'),
    persona: opt('persona'),
    model: group.model,
    capabilities: def['capabilities'] as ScopeCapability[] | undefined,
    rules: def['rules'] as string[] | undefined,
    cost_tier: opt('cost_tier'),
    contract: def['contract'] as ScopeIoContract | undefined,
    meta: { [CRYSTALLIZE_EVIDENCE_SOURCE]: group.ref },
  });
  return spec.to_dict();
}
