/**
 * 审批卡域数据形态：三类卡类型枚举、payload 容器与门控分级常量。
 *
 * 审批卡 payload 是字典形态的通用数据（`{ [key: string]: unknown }`），
 * 字段名与宿主事件协议强绑定（target_id / chapter_index 等字段名协议锁定，
 * 语义由宿主解释）——本模块只声明数据面常量与类型，不解释业务语义。
 *
 * 门控分级（GatingTier）为字符串字面量联合（镜像 StrEnum 的取值面）：
 * l1 直落库、l2 弹卡、l3 破坏类预留；分级判定逻辑见 reviewCard。
 */

/** 审批卡 payload：通用字典容器（字段由发卡方与协议共同决定）。 */
export type CardPayload = { [key: string]: unknown };

/** 三类审核卡类型（新卡类型必须在此登记，防「新卡忘登记 → 前端渲染漂移」）。 */
export const REVIEW_TYPES = ['gate', 'body', 'candidate'] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];

/**
 * 预览截断默认上限（防撑爆传输通道）；内容类/结构化设定类的大额上限由
 * 宿主构造时经 limits 映射注入，构造器把上限写入卡 payload 随卡流动。
 */
export const PREVIEW_LIMIT_DEFAULT = 1000;

/**
 * 写操作的确认策略分档取值（StrEnum 值面；判定与白名单语义见 reviewCard）。
 * - l1 创建/新增类：不弹卡直落库（事后纠正），audit 全量留痕（decision="auto"）；
 * - l2 内容类：保留弹卡（内容写入是不可逆的覆盖型写入）；
 * - l3 破坏类：删除/批量覆盖/修改锁定内容——保留弹卡（预留）。
 */
export const GATING_TIER_VALUES = ['l1', 'l2', 'l3'] as const;
export type GatingTier = (typeof GATING_TIER_VALUES)[number];

/** 有效覆盖挡位值（gating_overrides 白名单；非法值忽略回退默认挡位）。 */
export const GATING_OVERRIDE_VALUES: ReadonlySet<string> = new Set<string>(GATING_TIER_VALUES);

/** 挡位名称清单（外部校验/展示用；按枚举声明顺序）。 */
export const GATING_TIER_NAMES: readonly string[] = [...GATING_TIER_VALUES];
