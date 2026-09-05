/**
 * 审批卡模型与门控分级注册表（通用审批原语）——review_card.py 移植。
 *
 * 四类审核卡（gate/body/audit/candidate）的数据模型与构造/校验/截断逻辑，
 * 以及门控分级（GatingTier）注册表机制：
 *
 * - REVIEW_TYPES：卡类型枚举（新增卡类型必须在此登记，防「新卡忘登记
 *   → 前端渲染漂移」）；
 * - validate_card / truncate_preview：统一契约校验与预览截断（按 node_id
 *   分档限额由宿主注入，上限随卡携带——SSE 出口与发卡点共用同一规则，
 *   出口零配置）；
 * - build_*_card 四构造器：四类卡唯一构建源——卡形态一律经构造器产出 +
 *   validate_card 统一契约校验，宿主只提供 payload 数据与语义字段，
 *   不在发卡点手工拼卡；
 * - gating_tier_of：门控分级判定（l1 直落库 / l2 弹卡 / l3 破坏类预留；
 *   未登记写操作默认 l2 保守弹卡）。
 *
 * 边界：卡 payload 形状与宿主事件协议强绑定（target_id / chapter_index
 * 等字段名为协议锁定，语义由宿主解释）——本模块只提供模型与纯函数，
 * 不发射事件、不落库；事件发射形状由宿主保持，前端协议不变。
 *
 * 错误映射（既有移植口径）：Python ValueError 数值越界 → RangeError，
 * 其余枚举/必填契约类 → Error；TypeError → TypeError。
 */

import {
  GATING_OVERRIDE_VALUES,
  PREVIEW_LIMIT_DEFAULT,
  REVIEW_TYPES,
} from './reviewCard_types.js';
import type { CardPayload, GatingTier, ReviewType } from './reviewCard_types.js';

export { GATING_TIER_NAMES } from './reviewCard_types.js';

/** 各卡必填字段（validate_card 校验依据；缺字段视为契约破坏，宁可拒绝发卡）。
 * 只列「结构必填」：卡类型标识 + 定位字段；值允许为空的次要字段
 * （audit.workflow_id / candidate.target_id / output_preview 等）不在此列
 * ——原发卡点允许空值发送，校验过严会破坏既有行为。 */
const REQUIRED_FIELDS: Readonly<Record<ReviewType, readonly string[]>> = {
  gate: ['node_id', 'node_label', 'review_type'],
  body: [
    'node_id',
    'node_label',
    'review_type',
    'target_id',
    'chapter_index',
    'chapter_total',
  ],
  audit: ['node_id', 'node_label', 'review_type'],
  candidate: ['node_id', 'node_label', 'review_type', 'candidates'],
};

/** 数值型必填字段的下界（0 合法，负数为越界/异常卡）。 */
const NUMERIC_FIELDS = ['chapter_index', 'chapter_total'] as const;

// 族收敛：pyStr/pyRepr 近似拷贝的统一迁移点 = core/py_repr.ts 单源（已就绪）。
// 本实现差异：pyRepr 非递归（对象/数组直接 String()）。后续批次可按批迁移，
// 本文件暂不改实现。
/** Python str() 口径渲染（None → 'None'、布尔 True/False，其余 String()）。 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** Python repr() 口径渲染（错误消息携带类型值；字符串带引号）。 */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

/** 值是否为合法挡位（gating_overrides / 注册表白名单命中判定）。 */
function isGatingValue(value: unknown): value is GatingTier {
  return typeof value === 'string' && GATING_OVERRIDE_VALUES.has(value);
}

/** 按 node_id 分档的预览截断上限（宿主注入映射，未命中回默认档）。 */
export function preview_limit_for(
  node_id: string,
  limits?: Readonly<Record<string, number>> | null,
): number {
  if (limits) {
    const limit = limits[node_id];
    if (limit != null) return limit;
  }
  return PREVIEW_LIMIT_DEFAULT;
}

/** 校验卡 payload 契约：review_type 枚举 + 必填字段 + 数值下界 + 预览截断。
 *
 * 返回截断后的卡（可直接写 pending_review / 转 SSE）。校验失败抛错——
 * 发卡点必须先行修复（契约错误静默放行会导致前端渲染漂移）。 */
export function validate_card(card: CardPayload): CardPayload {
  const rtype: unknown = card['review_type'];
  if (!(typeof rtype === 'string' && (REVIEW_TYPES as readonly string[]).includes(rtype))) {
    throw new Error(`未知审核卡类型: ${pyRepr(rtype)}（须在 REVIEW_TYPES 登记）`);
  }
  const type = rtype as ReviewType;
  const missing = REQUIRED_FIELDS[type].filter((key) => {
    const value = card[key];
    return value === null || value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new Error(`审核卡（${type}）缺少必填字段: ${missing.join(', ')}`);
  }
  for (const numKey of NUMERIC_FIELDS) {
    if (
      REQUIRED_FIELDS[type].includes(numKey)
      && typeof card[numKey] === 'number'
      && (card[numKey] as number) < 0
    ) {
      throw new RangeError(`审核卡（${type}）字段 ${numKey} 不能为负`);
    }
  }
  return truncate_preview(card);
}

/** 按卡内 preview_limit（构造时固化）截断 output_preview。
 *
 * 返回新 dict，不改原卡；卡内无 preview_limit 时按 node_id 回退默认档。 */
export function truncate_preview(card: CardPayload): CardPayload {
  const payload: CardPayload = { ...card };
  const preview: unknown = payload['output_preview'] || '';
  const nodeIdRaw = payload['node_id'];
  const rawLimit = payload['preview_limit'];
  const limit =
    rawLimit && typeof rawLimit === 'number'
      ? (rawLimit as number)
      : preview_limit_for(nodeIdRaw ? pyStr(nodeIdRaw) : '');
  if (typeof preview === 'string' && preview.length > limit) {
    payload['output_preview'] = preview.slice(0, limit) + '\n…（已截断）';
  }
  return payload;
}

/** 写操作审批卡（gate）：动作摘要 + 确认/编辑/取消（四类卡之一）。
 *
 * 同时承接单动作卡（action 键）与合并卡（actions 键——同回合多写操作
 * 聚合一张卡，仍是 gate 卡形态）。宿主 payload 字段优先：已显式给定的
 * 字段不改写，与审批语义「宿主 payload 优先」一致。
 *
 * @param action 单动作描述（{tool, args, summary, diff, ...}——渲染与策略
 *   分级判定用，宿主自定形态）。
 * @param options.actions 动作列表（合并卡；与 action 二选一，actions 优先）。
 * @param options.payload 宿主提供的卡负载。
 * @param options.limits 宿主注入的预览上限映射（可选；output_preview 超限截断）。
 */
export function build_gate_card(
  action?: { [key: string]: unknown } | null,
  options: {
    actions?: readonly { [key: string]: unknown }[] | null;
    payload?: CardPayload | null;
    limits?: Readonly<Record<string, number>> | null;
  } = {},
): CardPayload {
  const card: CardPayload = options.payload ? { ...options.payload } : {};
  if (!('review_type' in card)) card['review_type'] = 'gate';
  const { actions, limits } = options;
  if (actions) {
    if (!('node_id' in card)) card['node_id'] = 'approval_batch';
    if (!('node_label' in card)) card['node_label'] = '批量审批';
    if (!('actions' in card)) card['actions'] = actions.map((item) => ({ ...item }));
    if (!('output_preview' in card)) {
      card['output_preview'] = actions
        .map(
          (item) =>
            `- ${pyStr(item['tool'])}: ${pyStr(item['summary'] || item['diff'] || '')}`,
        )
        .join('\n');
    }
  } else if (action) {
    const toolRaw = action['tool'];
    const toolName = toolRaw ? pyStr(toolRaw) : 'approval';
    if (!('node_id' in card)) card['node_id'] = toolName;
    if (!('node_label' in card)) card['node_label'] = toolName;
    if (!('action' in card)) card['action'] = { ...action };
    if (!('output_preview' in card)) {
      card['output_preview'] = pyStr(action['diff'] || action['summary'] || '');
    }
  }
  const nodeIdRaw = card['node_id'];
  card['preview_limit'] = preview_limit_for(nodeIdRaw ? pyStr(nodeIdRaw) : '', limits);
  return validate_card(card);
}

/** 内容审批卡（body）：完整内容 + 确认/编辑/取消（前端 ReviewCard 契约）。
 *
 * content 字段为未截断完整内容（供前端编辑回填）；output_preview 由
 * validate_card → truncate_preview 截断用于 SSE 展示，二者分离——编辑基于
 * 全文、展示基于预览，互不影响。
 *
 * @param target_id 卡关联的目标引用 ID（宿主语义，如目标实体 ID）。
 * @param index 进度序号（第 N/M，协议字段 chapter_index）。
 * @param total 进度总数（协议字段 chapter_total）。
 * @param content 完整内容。
 * @param node_label 卡标签。
 * @param node_id 节点 ID（宿主必传；缺省会被必填校验拒绝）。
 * @param conflicts 写时预检命中的冲突列表（可选）。
 * @param limits 宿主注入的预览上限映射（可选）。
 */
export function build_body_card(
  target_id: number,
  index: number,
  total: number,
  content: string,
  node_label: string,
  node_id?: string | null,
  conflicts?: readonly { [key: string]: unknown }[] | null,
  limits?: Readonly<Record<string, number>> | null,
): CardPayload {
  const card: CardPayload = {
    review_type: 'body',
    node_id: node_id ?? null,
    node_label,
    output_preview: content,
    content,
    reason: '内容已生成，请确认后落库（可在编辑后确认）。',
    target_id,
    chapter_index: index,
    chapter_total: total,
    tokens: 0,
    elapsed_ms: 0,
  };
  card['preview_limit'] = preview_limit_for(node_id || '', limits);
  if (conflicts && conflicts.length > 0) card['conflicts'] = conflicts;
  return validate_card(card);
}

/** 质量卡（audit）：输出未过质量审计的拦截卡（接受/重试/终止）。
 *
 * 截断统一交给 truncate_preview（validate_card 内按 preview_limit 执行）——
 * 宿主注入的大额上限真实生效，不存在双实现重复。 */
export function build_audit_card(
  node_id: string,
  node_label: string,
  workflow_id: string,
  output: string,
  reason: string,
  target_id: number | null,
  tokens = 0,
  elapsed_ms = 0,
  limits?: Readonly<Record<string, number>> | null,
): CardPayload {
  return validate_card({
    node_id,
    node_label,
    workflow_id,
    output_preview: output || '',
    reason: reason || '输出质量不满足节点要求',
    review_type: 'audit',
    target_id,
    tokens,
    elapsed_ms,
    preview_limit: preview_limit_for(node_id || '', limits),
  });
}

/** 候选选择卡（candidate）：全量文本按候选顺序划分，操作 = 选择/编辑/取消。
 *
 * 候选内容不进 messages/上下文（防内容回灌/泄露），落库由调用方在用户
 * 选定后执行，按 source 分流。
 *
 * @param target_id 卡关联的目标引用 ID（宿主语义，可空）。
 * @param workflow_id 来源标识（宿主语义，如工作流 ID 或并行候选标识）。
 * @param candidates 候选列表 [{node_id, node_label, output, summary}, ...]。
 * @param source 候选来源标识（宿主分流与前端来源标签展示，透传不解释）。
 * @param node_id 节点 ID（宿主必传；缺省会被必填校验拒绝）。
 * @param label 卡标签（宿主文案；缺省用通用文案）。
 * @param reason 卡说明（宿主文案；缺省用通用文案）。
 * @param limits 宿主注入的预览上限映射（可选）。
 */
export function build_candidate_card(
  target_id: number | null,
  workflow_id: string,
  candidates: readonly { [key: string]: unknown }[],
  source = 'workflow',
  node_id?: string | null,
  label?: string | null,
  reason?: string | null,
  limits?: Readonly<Record<string, number>> | null,
): CardPayload {
  return validate_card({
    review_type: 'candidate',
    node_id: node_id ?? null,
    node_label: label || '候选选择',
    candidates,
    target_id,
    workflow_id,
    source,
    reason: reason || '已生成多个版本，请选择其一（可编辑后确认）。',
    tokens: 0,
    elapsed_ms: 0,
    preview_limit: preview_limit_for(node_id || '', limits),
  });
}

/** 解析单工具的生效门控挡位（纯函数，可单测）。
 *
 * 优先级：用户覆盖（overrides[tool_name]，白名单校验）> 注册表 l1/l3
 * > l2 默认（未登记写操作默认保守弹卡——新增写工具不弹卡即门控绕过）。
 *
 * @param tool_name 工具名。
 * @param overrides 宿主设置 gating_overrides（{tool_name: 'l1'|'l2'|'l3'}）。
 * @param registry 工具 → 挡位注册表（宿主按需传入；默认空表全部落 l2）。
 */
export function gating_tier_of(
  tool_name: string,
  overrides?: Readonly<Record<string, unknown>> | null,
  registry?: Readonly<Record<string, unknown>> | null,
): GatingTier {
  if (overrides) {
    const override = overrides[tool_name];
    if (isGatingValue(override)) return override;
  }
  const tier = registry ? registry[tool_name] : undefined;
  if (isGatingValue(tier)) return tier;
  return 'l2';
}

export { GATING_OVERRIDE_VALUES, PREVIEW_LIMIT_DEFAULT, REVIEW_TYPES };
export type { CardPayload, GatingTier, ReviewType };
