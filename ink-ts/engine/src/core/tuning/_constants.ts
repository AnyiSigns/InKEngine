/**
 * 自适应调优常量与边界护栏（tuning.py 常量段移植）。
 *
 * 分工（与进化工厂）：调参改参数（权重/阈值），进化工厂变异规则结构
 * （增删改规则）——进化产物过三层闸门；参数变更过 L2 效果评估回归
 * （参数无「旧版」可比，L1/L3 不适用）。与推演-回溯的交互（参数快照）：
 * 评估时记录所用规则版本 + 权重快照（随评估记录落库）——调参不改变推演
 * 择优的可回放性，回放/审计按快照重算（「标尺在动」问题：快照冻结当时标尺）。
 */

// 权重调整的上下限保护（降权下限防维度形同虚设；升权上限防单一维度
// 失衡主导——超上限的越界权重在调参入口收敛到边界，防回归整条冻结）
export const MIN_WEIGHT = 0.1;
export const MAX_WEIGHT = 1.0;
// 单次调整的权重乘数（低分反馈维度降权步长）
export const WEIGHT_DECAY = 0.9;
// 单次调整的权重加成（高分反馈维度升权步长）
export const WEIGHT_GAIN = 1.1;

// 指标聚合窗口上限（评审分/收敛轮数只留近期窗口，防长跑留痕无限膨胀）
export const _METRICS_WINDOW = 500;

// 失败率档位（重试预算/探索宽度的调整依据）
export const FAILURE_RATE_HIGH = 0.4;
export const FAILURE_RATE_LOW = 0.1;

// 机制参数调整边界（参数级进化护栏：上下限保护防失控）
export const DIVERGENCE_WIDTH_MIN = 1;
export const DIVERGENCE_WIDTH_MAX = 6;
export const RETRY_BUDGET_FLOOR = 2; // 失败率高时的重试预算保底值
export const WEB_THRESHOLD_MIN = 0.1;
export const WEB_THRESHOLD_MAX = 0.9;
export const WEB_THRESHOLD_STEP = 0.1;
export const CONVERGENCE_AVG_HIGH = 3.0;
export const CONVERGENCE_AVG_LOW = 1.0;

// 参数回归的默认取值边界（fixture 未显式声明 bounds 时的兜底口径：
// 权重下限 = 调参下限保护，阈值非负）
export const _DEFAULT_WEIGHT_MIN = MIN_WEIGHT;
export const _DEFAULT_WEIGHT_MAX = 1.0;
export const _DEFAULT_THRESHOLD_MIN = 0.0;
export const _DEFAULT_THRESHOLD_MAX = Infinity;

// 时间 seam 缺省（deterministic：未注入 = 0，纯逻辑可复现——core 零 IO）
export const _DEFAULT_NOW = (): number => 0;
