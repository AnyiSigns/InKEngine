/**
 * harness 声明式定义（harness.py 移植：定义数据面）。
 *
 * harness = 用户集内的能力包（图定义数据 + 工具清单 + 能力描述 + 可选
 * 编排模板与状态 schema）——定义即数据，注册即插拔：
 *
 * - 注册表（进程内）：按名取定义、**集内激活**（任务描述 → 集内相关度
 *   激活——唯一用户集原则：每个用户一个专属集（知识+工具+工作流模板
 *   混合生长），任务只在集内按相关度裁剪，无跨集选择、无路由误匹配）；
 *   图/工具经注入的建图注册表从数据重建；
 * - 仓库（存储后盾）：定义落 records 通道，版本 = 补丁链（新版本 append、
 *   失败可回退旧版本——与 checkpoint 版本链同哲学）；
 * - 组合调配：激活返回按相关度排序的候选清单，宿主按序选取并 spawn
 *   展开（多 harness 组合 = 多候选的实例化与编排）。
 *
 * 本文件承载常量/集合名/匹配器签名与 HarnessDefinition 纯数据形态；
 * 构造校验（build_minimal_harness）与默认关键词匹配器在 builder.ts，
 * 注册表在 registry.ts，仓库在 repository.ts。
 */
import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';

// 仓库存储集合名（通用存储服务 records 通道）。
// 历史遗留名（无 set_id）：多集共享同一存储时会互相串数据——新写入按集
// 隔离（见 harness_collection），此名仅作**旧数据只读兼容**保留。
export const HARNESS_COLLECTION = 'harness';

// 按集隔离的集合名前缀（与 knowledge:<user_id> 同构：一集一集合）
export const HARNESS_COLLECTION_PREFIX = 'harness:';

/** harness 仓库集合名（按集隔离：``harness:<set_id>``）。
 *
 *  与知识集 ``knowledge:<user_id>`` 同构——多集共享存储时互不串数据。
 *  旧数据落在无 set_id 的 HARNESS_COLLECTION，仓库读路径保留只读回退
 * （写入一律进按集集合，不迁移旧数据）。
 */
export function harness_collection(set_id: string): string {
  return `${HARNESS_COLLECTION_PREFIX}${set_id}`;
}

// 能力路由缺省置信度门槛（低于 = 不匹配，返回 None 交由宿主询问用户）
export const DEFAULT_ROUTE_THRESHOLD = 0.5;

/** 能力匹配器签名：任务描述 × 定义 → 相关度（0-1）。 */
export type CapabilityMatcher = (task: string, definition: HarnessDefinition) => number;

/** HarnessDefinition 构造选项（对应 Python frozen dataclass 字段）。 */
export interface HarnessDefinitionInit {
  /** harness 名（全局唯一）。 */
  name: string;
  /** 能力描述（能力路由/用户可见说明）。 */
  description?: string;
  /** 能力关键词（默认匹配器的命中依据，如 写作/推演/润色）。 */
  keywords?: readonly string[];
  /** 图定义数据（Graph.to_dict 产物；null = 无图，纯工具/纯模板 harness）。 */
  graph?: Record<string, unknown> | null;
  /** 声明式工具定义数据（DeclarativeToolSpec.to_dict 产物）。 */
  tools?: readonly Record<string, unknown>[];
  /** 状态通道 schema 数据（StateSchema.to_dict 产物）。 */
  schema?: Record<string, unknown> | null;
  /** 默认编排模板（计划数据形态，经 Plan.parse 校验；null = 无模板）。 */
  default_plan?: Record<string, unknown> | null;
  /** 扩展元数据（来源/作者/版本说明等，宿主语义）。 */
  meta?: Record<string, unknown>;
}

/**
 * harness 声明（纯数据：图定义 + 工具 + 能力描述 + 可选编排模板）。
 *
 * 镜像 Python frozen dataclass：构造后不可变（Object.freeze）；to_dict /
 * from_dict 承载导出/导入的数据往返（可随仓库持久化）。
 */
export class HarnessDefinition {
  readonly name: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly graph: Record<string, unknown> | null;
  readonly tools: readonly Record<string, unknown>[];
  readonly schema: Record<string, unknown> | null;
  readonly default_plan: Record<string, unknown> | null;
  readonly meta: Record<string, unknown>;

  constructor(init: HarnessDefinitionInit) {
    this.name = init.name;
    this.description = init.description ?? '';
    this.keywords = init.keywords ? [...init.keywords] : [];
    this.graph = init.graph ?? null;
    this.tools = init.tools ? [...init.tools] : [];
    this.schema = init.schema ?? null;
    this.default_plan = init.default_plan ?? null;
    this.meta = init.meta ? { ...init.meta } : {};
    Object.freeze(this);
  }

  /** 序列化为数据形态（graph/tools 等字段按 Python 口径 list 化）。 */
  to_dict(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      keywords: [...this.keywords],
      graph: this.graph,
      tools: [...this.tools],
      schema: this.schema,
      default_plan: this.default_plan,
      meta: { ...this.meta },
    };
  }

  /** 从数据形态还原（name 缺失/空 → 定义期拒绝；未知键忽略兼容演进）。 */
  static from_dict(data: unknown): HarnessDefinition {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(
        `harness 声明非法: 期望 dict，收到 ${typeName(data)}`,
      );
    }
    const name = data['name'];
    if (typeof name !== 'string' || !name.trim()) {
      throw new GraphDefinitionError('harness 声明缺 name（非空字符串）');
    }
    const rawKeywords = data['keywords'];
    const keywords = Array.isArray(rawKeywords)
      ? rawKeywords.filter((item): item is string => typeof item === 'string')
      : [];
    const rawTools = data['tools'];
    const tools = Array.isArray(rawTools) ? rawTools.filter(isRecord) : [];
    const rawMeta = data['meta'];
    const meta = isRecord(rawMeta) ? rawMeta : {};
    const optional = (key: string): Record<string, unknown> | null => {
      const value = data[key];
      return value !== undefined && value !== null ? (value as Record<string, unknown>) : null;
    };
    return new HarnessDefinition({
      name,
      description: (data['description'] as string | undefined) || '',
      keywords,
      graph: optional('graph'),
      tools,
      schema: optional('schema'),
      default_plan: optional('default_plan'),
      meta,
    });
  }
}
