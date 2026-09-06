/**
 * policy 命令面（策略层路由预览：任务分类 → 计划形态 → 档位/配额）。
 *
 * TS host 侧为确定性纯计算（零 LLM 调用），分类与壳侧 Rust
 * domain::policy 同源：开发 = 强信号先于研究/运维，命中即归类，均未命中
 * = 直答。TS host 当前为单 agent 链（无多 workflow 链/无 simulate 预算），
 * 预览链形态按确定性直答形态输出（entry=null、空步骤、plan_only、
 * deterministic），档位随请求 tier 白名单校验；max_simulations /
 * quota_per_round 当前无预算面 = 0（不虚构引擎不存在的预算），quota_guarded
 * 恒 false。引擎侧多链/模拟预算装配落地后此预览随装配数据输出。
 */

import { BridgeError, type BridgeHandler } from './_types.js';

export const SIMULATION_TIERS = ['off', 'light', 'full'] as const;

/** 运维任务触发词（任务文本命中 = 运维类别；先于研究判定，弱于开发）。 */
const OPS_KEYWORDS = [
  '运维', '部署', '发布', '监控', '巡检', '升级', '回滚',
  '清理日志', '环境检查',
];
/** 开发任务触发词（命中 = 开发类别；先于研究判定）。 */
const DEV_KEYWORDS = [
  '开发', '实现', '修复', '编码', '写一个', '写个', '写代码', '编写',
  '构建', '调试', '重构', '造一个', '做出一个', '做一个',
];
/** 研究任务触发词（命中 = 研究类别）。 */
const RESEARCH_KEYWORDS = [
  '研究', '调研', '调查', '检索', '查证', '搜集', '收集资料', '背景查',
  '找找看', '查一查', '了解', '学习',
];

export type TaskKind = 'direct_answer' | 'research' | 'development' | 'operations';

/** 确定性关键词分类（开发强信号优先；结果仅影响预览走法）。 */
export function classifyTask(text: string): TaskKind {
  const devHits = DEV_KEYWORDS.filter((kw) => text.includes(kw)).length;
  const opsHits = OPS_KEYWORDS.filter((kw) => text.includes(kw)).length;
  const researchHits = RESEARCH_KEYWORDS.filter((kw) => text.includes(kw)).length;
  if (devHits > 0) return 'development';
  if (opsHits > 0) return 'operations';
  if (researchHits > 0) return 'research';
  return 'direct_answer';
}

function parseTier(raw: unknown): string {
  if (raw === undefined || raw === null) return 'full';
  const value = String(raw);
  if (!(SIMULATION_TIERS as readonly string[]).includes(value as never)) {
    throw new BridgeError(
      `simulation tier 须为 ${SIMULATION_TIERS.join('/')}，收到 ${value}`,
      'invalid_params',
    );
  }
  return value;
}

export function buildPolicyHandlers(): ReadonlyMap<string, BridgeHandler> {
  const route: BridgeHandler = async (raw): Promise<unknown> => {
    const params = raw as { text?: unknown; tier?: unknown } | null;
    const text =
      params !== null && params !== undefined && typeof params.text === 'string'
        ? params.text
        : '';
    if (text.trim() === '') {
      throw new BridgeError('route_plan 需 params.text（任务文本）', 'invalid_params');
    }
    const tier = parseTier(params?.tier);
    const kind = classifyTask(text);
    return {
      kind,
      chain_id: null,
      plan: {
        entry: null,
        steps: [],
        spawn_groups: [],
        decision_points: [],
        mode: 'plan_only',
        source: 'deterministic',
      },
      policy: { tier, max_simulations: 0, quota_per_round: 0 },
      quota_guarded: false,
    };
  };

  return new Map<string, BridgeHandler>([['policy.route', route]]);
}
