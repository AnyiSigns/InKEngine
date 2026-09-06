/**
 * GrowthConfig：自学习管线配置（growth.py GrowthConfig dataclass 移植）。
 *
 * 出厂默认开启、无用户可操作项；可观察诊断 = 管线是否启用（成长状态视图
 * 的启用态展示）；关闭 = 观察/蒸馏/落位全链路停用（引擎回到「无自学习」
 * 基线）。frozen 语义由 readonly 表达（字段次序与默认值逐一对齐 Python）。
 */

/** GrowthConfig 构造选项（镜像 Python 关键字构造；enabled 默认 True）。 */
export interface GrowthConfigOptions {
  enabled?: boolean;
  /** 蒸馏前复用判定（默认开：检索命中同主题已有知识即跳过蒸馏落位——复用
   *  优先于生成，防知识膨胀；命中判据保守 = 消息词元全部可命中才复用）。 */
  reuse_first?: boolean;
}

export class GrowthConfig {
  readonly enabled: boolean;
  readonly reuse_first: boolean;

  constructor(options: GrowthConfigOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.reuse_first = options.reuse_first ?? true;
  }
}
