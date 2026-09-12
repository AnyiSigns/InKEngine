/**
 * 择优评估阈值的产品参数面（§十一#6 实验参数固化：n_max/阈值等组织参数从
 * 引擎实验常量开放为 options 注入，缺省 = 现实验值；§六 择优半环的宿主入口）。
 *
 * 语义：宿主从产品配置读入一段**外部 JSON**（键 = Wave-2/3 阈值的蛇形拼写），
 * 本模块做纯函数归一——只认已登记阈值键、只收合法数值（观测计数 = 正整数，
 * 比率/线 = [0,1]），非法键值一律忽略并留痕（ignored 清单，回执可审计），
 * 缺省回落 `default_pruning_thresholds()`（= 现实验常量，行为零漂移）。
 * 引擎不读配置：读盘/取节归宿主装配（hosts boot / evolution 桥），本层只做
 * 「外部值 → OrgEvaluateOptions.thresholds」的形状卫生，保持评估器纯函数。
 *
 * 键表同时充当配置面字段名单一事实源（桥回执回显 effective 值，宿主报告
 * 声明字段名直接引用 ORG_THRESHOLD_CONFIG_KEYS）。
 */

import { isRecord } from '../json.js';
import {
  default_pruning_thresholds,
  type PruningThresholds,
} from '../org_archive/pruning.js';

/** 阈值数值域：positive_int = 观测计数下限（正整数）；unit = [0,1] 比率/触发线。 */
export type OrgThresholdDomain = 'positive_int' | 'unit';

/** 配置键（蛇形）→ options 键（驼峰）+ 数值域（键名单一事实源）。 */
export const ORG_THRESHOLD_CONFIG_KEYS: Readonly<Record<string, {
  option: keyof PruningThresholds;
  domain: OrgThresholdDomain;
}>> = Object.freeze({
  min_evidence: { option: 'minEvidence', domain: 'positive_int' },
  shortcut_min_evidence: { option: 'shortcutMinEvidence', domain: 'positive_int' },
  shortcut_min_success_rate: { option: 'shortcutMinSuccessRate', domain: 'unit' },
  shortcut_max_terminal_ratio: { option: 'shortcutMaxTerminalRatio', domain: 'unit' },
  downrank_min_evidence: { option: 'downrankMinEvidence', domain: 'positive_int' },
  downrank_failure_rate: { option: 'downrankFailureRate', domain: 'unit' },
  retire_min_evidence: { option: 'retireMinEvidence', domain: 'positive_int' },
  retire_max_usage: { option: 'retireMaxUsage', domain: 'positive_int' },
  retire_failure_rate: { option: 'retireFailureRate', domain: 'unit' },
  keep_min_evidence: { option: 'keepMinEvidence', domain: 'positive_int' },
  keep_min_success_rate: { option: 'keepMinSuccessRate', domain: 'unit' },
});

/** 归一产出：可用的阈值覆写（Partial，喂 OrgEvaluateOptions）+ 被忽略项留痕。 */
export interface OrgThresholdNormalization {
  overrides: Partial<PruningThresholds>;
  /** 忽略清单（`键=值` 形态，非法键/域/形状逐条可读，供回执审计）。 */
  ignored: string[];
}

function in_domain(value: number, domain: OrgThresholdDomain): boolean {
  if (domain === 'positive_int') {
    return Number.isInteger(value) && value >= 1;
  }
  return value >= 0 && value <= 1;
}

/**
 * 把宿主配置读入的一段外部 JSON 归一为阈值覆写（纯函数，不抛错）。
 * 非 dict 根 = 全部忽略（ignored 记 `!record`）；已登记键 + 数值域合法才收，
 * 其余进 ignored（缺省回落现实验值，配置面永不使评估器越界）。
 */
export function normalize_org_evaluate_thresholds(raw: unknown): OrgThresholdNormalization {
  const overrides: Partial<PruningThresholds> = {};
  const ignored: string[] = [];
  if (!isRecord(raw)) {
    ignored.push('!record');
    return { overrides, ignored };
  }
  for (const [key, value] of Object.entries(raw)) {
    const spec = (ORG_THRESHOLD_CONFIG_KEYS as Record<string, {
      option: keyof PruningThresholds;
      domain: OrgThresholdDomain;
    }>)[key];
    if (spec === undefined) {
      ignored.push(`${key}=<unknown>`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || !in_domain(value, spec.domain)) {
      ignored.push(`${key}=${JSON.stringify(value)}`);
      continue;
    }
    overrides[spec.option] = value;
  }
  return { overrides, ignored };
}

/** 生效阈值回显（覆写合并现实验缺省；进回执供审批/审计核对参数固化来源）。 */
export function effective_org_evaluate_thresholds(
  overrides: Partial<PruningThresholds>,
): Required<PruningThresholds> {
  return { ...default_pruning_thresholds(), ...overrides };
}
