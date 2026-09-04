/**
 * 感知结点（视觉理解）+ 双通道交叉验证 + 截图外发分级——perception.py 移植。
 *
 * 本模块承载视觉感知能力的引擎侧形态，全部为纯逻辑或结点登记，不触碰
 * 种子数据（事件类型不新增），不改 llm 核心：
 *
 * - 感知结点 vision_perceive：输入 = 屏幕截图引用（image url/path），
 *   输出 = 结构化界面描述（文本摘要 + 元素清单 + 置信度）。结点按既有
 *   结点契约登记进结点类型注册表，可被路径组装器组装进执行路径；视觉
 *   任务的成败由执行器经通用边证据机制统一留痕（不维护专用记录函数——
 *   通用机制已覆盖）。
 * - 双通道交叉验证：元素树结果 + 像素理解结果两路独立产出，一致 = 直进，
 *   不一致 = 触发复核信号（复核路径接管）并给出降级决策。
 * - 截图外发分级：本地多模态模型可直喂（不出网），云端模型默认禁止截图
 *   外发（屏幕内容不出网）；仅当用户显式授权后才放开，且仍走审批链。
 *
 * 注册点追加在 runtime 装配处（图注册表构建后调用
 * :func:`register_perception_nodes`）。
 *
 * TS seam 差异：Python 执行体经 getattr(ctx, "state", None) + Mapping 判读
 * 读取上下文状态，TS 以记录判读（isRecord）等价收敛；截图引用取舍沿用
 * Python 的真值口径（image_url or image_path——缺一取另一，全缺 = 空产出）。
 * 本模块纯函数零 IO：无时间/随机/日志依赖，无需 seam 注入。
 */

import { isRecord } from '../json.js';
import { NodeContract } from '../contracts/contracts.js';
import { NodeTypeRegistry } from '../registry/registry.js';
import { FIELD_NUMBER, FIELD_STRING, SchemaField, SchemaSpec } from '../schema/schemaValidator.js';

// 感知结点类型名（不透明字符串，注册表不解释含义）
export const VISION_PERCEIVE_TYPE = 'vision_perceive';
export const VISION_CONTRACT_VERSION = '1';
export const VISION_CONTEXT_DOMAIN = 'vision';

// 截图外发分级：模型类别（本地多模态 / 云端）
export const MODEL_LOCAL = 'local';
export const MODEL_CLOUD = 'cloud';

// 外发决策（与壳侧同义常量；决策只记录不裁决）
export const EXPORT_ALLOW = 'allow';
export const EXPORT_DENY = 'deny';

// 双通道交叉验证决策
export const VALIDATE_PROCEED = 'proceed';
export const VALIDATE_REVIEW = 'review';

// ── 结点契约与登记 ──

/** 感知结点契约：输入截图引用、输出结构化描述（安全档 1 = 屏幕敏感域）。 */
function _vision_contract(): NodeContract {
  const input_schema = new SchemaSpec({
    name: `${VISION_PERCEIVE_TYPE}.input`,
    fields: [
      new SchemaField({
        name: 'image_url',
        required: false,
        kind: FIELD_STRING,
      }),
      new SchemaField({
        name: 'image_path',
        required: false,
        kind: FIELD_STRING,
      }),
    ],
  });
  const output_schema = new SchemaSpec({
    name: `${VISION_PERCEIVE_TYPE}.output`,
    fields: [
      new SchemaField({ name: 'description', required: true, kind: FIELD_STRING }),
      new SchemaField({ name: 'elements', required: false, kind: FIELD_STRING }),
      new SchemaField({ name: 'confidence', required: false, kind: FIELD_NUMBER }),
    ],
  });
  return new NodeContract({
    input_schema,
    output_schema,
    safety_tier: 1,
    version: 1,
  });
}

/**
 * 感知结点执行体（输入 image → 输出结构化描述）。
 *
 * 真实形态下经本地多模态模型理解截图；本实现取截图引用并产出结构化
 * 描述（元素清单 + 文本摘要 + 置信度），供下游结点消费。结点只产出
 * 数据，成败由执行器经边证据机制留痕（reuse 通用 EdgeEvidenceStore）。
 */
async function _vision_perceive_node(ctx: unknown): Promise<Record<string, unknown>> {
  let image_url: unknown;
  let image_path: unknown;
  if (isRecord(ctx)) {
    const state = ctx['state'];
    if (isRecord(state)) {
      image_url = state['image_url'];
      image_path = state['image_path'];
    }
  }
  const ref = image_url || image_path;
  if (!ref) {
    return { description: '', elements: '', confidence: 0.0 };
  }
  return {
    description: `界面截图理解：${String(ref)}`,
    elements: 'window,button,text,input',
    confidence: 0.9,
  };
}

/**
 * 登记感知结点类型（重复登记显式拒绝；装配处调用）。
 *
 * 契约随类型登记：输入 = 截图引用，输出 = 结构化描述；安全档 1（屏幕
 * 内容属敏感域，组装请求按任务审批档映射放行）。登记后该类型进入结点
 * 池，路径组装器的 contract_pool 即可见，可组装进执行路径。
 */
export function register_perception_nodes(registry: NodeTypeRegistry): void {
  registry.register(
    VISION_PERCEIVE_TYPE,
    () => _vision_perceive_node,
    _vision_contract(),
  );
}

// ── 双通道交叉验证 ──

/** 双通道交叉验证结果（一致 = 直进；不一致 = 复核信号 + 降级决策）。 */
export class CrossValidationResult {
  readonly consistent: boolean;
  readonly review_signal: boolean;
  readonly decision: string;
  readonly detail: string;

  constructor(
    consistent: boolean,
    review_signal: boolean,
    decision: string,
    detail = '',
  ) {
    this.consistent = consistent;
    this.review_signal = review_signal;
    this.decision = decision;
    this.detail = detail;
  }
}

/** 交叉验证选项（threshold = 最小重合度，默认 0.5，需多数元素重合才一致）。 */
export interface CrossValidationOptions {
  threshold?: number;
}

/**
 * 从单通道结果抽取元素标签集合（字符串逗号分隔或序列归一）。
 *
 * 字符串按逗号切分后去空白、去空项；数组逐元素字符串化后同样去空白
 * 去空项；其余形态 = 空集（与 Python frozenset 口径对齐）。
 */
function _element_labels(result: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const items = result['elements'];
  const labels = new Set<string>();
  if (typeof items === 'string') {
    for (const part of items.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') labels.add(trimmed);
    }
  } else if (Array.isArray(items)) {
    for (const item of items) {
      const trimmed = String(item).trim();
      if (trimmed !== '') labels.add(trimmed);
    }
  }
  return labels;
}

/**
 * 双通道交叉验证：元素树结果 + 像素理解结果。
 *
 * 两路各自给出界面元素清单；一致（标签集合重合度 ≥ 阈值，默认 0.5 =
 * 需多数元素重合）则直进；不一致 = 触发复核信号（复核路径接管）并给出
 * 降级决策（退化到单通道理解）。纯逻辑，单测可断言一致 / 不一致两态。
 *
 * @param element_result 元素树通道产出（含 elements 字段）。
 * @param pixel_result 像素理解通道产出（含 elements 字段）。
 * @param options.threshold 最小重合度（默认 0.5，需多数元素重合才一致）。
 */
export function cross_validate_channels(
  element_result: Readonly<Record<string, unknown>>,
  pixel_result: Readonly<Record<string, unknown>>,
  options: CrossValidationOptions = {},
): CrossValidationResult {
  const threshold = options.threshold ?? 0.5;
  const a = _element_labels(element_result);
  const b = _element_labels(pixel_result);
  if (a.size === 0 && b.size === 0) {
    return new CrossValidationResult(
      true,
      false,
      VALIDATE_PROCEED,
      '两通道均无元素，按空一致处理',
    );
  }
  if (a.size === 0 || b.size === 0) {
    // 单通道缺失：不一致，触发复核（降级到可用通道）
    return new CrossValidationResult(
      false,
      true,
      VALIDATE_REVIEW,
      '单通道缺失，触发复核',
    );
  }
  let overlap = 0;
  for (const label of a) {
    if (b.has(label)) overlap += 1;
  }
  // 并集大小 = 两集合大小之和减去重叠（Python len(a | b) 口径）
  const union_size = a.size + b.size - overlap;
  const score = union_size > 0 ? overlap / union_size : 1.0;
  if (score >= threshold) {
    return new CrossValidationResult(
      true,
      false,
      VALIDATE_PROCEED,
      `两通道一致（重合度 ${score.toFixed(2)}）`,
    );
  }
  return new CrossValidationResult(
    false,
    true,
    VALIDATE_REVIEW,
    `两通道不一致（重合度 ${score.toFixed(2)} < 阈值 ${threshold}），触发复核`,
  );
}

// ── 截图外发分级（纯逻辑，可单测）──

/** 截图外发决策（allow / deny + 原因）。 */
export class VisionExportDecision {
  readonly decision: string;
  readonly reason: string;

  constructor(decision: string, reason: string) {
    this.decision = decision;
    this.reason = reason;
  }
}

/** 外发分级选项（authorized = 用户是否显式授权截图外发，设置持久化态）。 */
export interface ClassifyVisionExportOptions {
  authorized: boolean;
}

/**
 * 截图外发分级（纯逻辑，可单测）。
 *
 * 本地多模态模型 = 截图不出网，可直接喂（allow）；云端模型默认禁止
 * 截图外发（屏幕内容不出网）——仅当用户显式授权（authorized=True）
 * 才放开。未授权时云端一律 deny（fail-closed 默认禁外发）。
 *
 * @param model_kind 模型类别（local / cloud）。
 * @param options.authorized 用户是否显式授权截图外发。
 */
export function classify_vision_export(
  model_kind: string,
  options: ClassifyVisionExportOptions,
): VisionExportDecision {
  if (model_kind === MODEL_LOCAL) {
    return new VisionExportDecision(EXPORT_ALLOW, '本地多模态模型直喂（截图不出网）');
  }
  if (model_kind === MODEL_CLOUD) {
    if (options.authorized) {
      return new VisionExportDecision(EXPORT_ALLOW, '云端模型已显式授权，允许外发');
    }
    return new VisionExportDecision(EXPORT_DENY, '云端模型默认禁止截图外发（屏幕内容不出网）');
  }
  return new VisionExportDecision(EXPORT_DENY, `未知模型类别: ${model_kind}`);
}
