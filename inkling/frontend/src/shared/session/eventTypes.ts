/**
 * 事件类型注册表（绑定协议 events.* 通道的数据契约）。
 *
 * 与 seed_data/event_types.json 数据形态同源（此处为前端侧镜像契约）：
 * 新增事件类型先改 seed_data/event_types.json，再镜像登记到本表——
 * 未登记的事件类型在 events.* 绑定通道白名单中拒绝。
 */

export const EVENT_TYPE_NAMES = [
  // 回合基础
  'reply_token',
  'thinking_start',
  'thinking_end',
  'plan_start',
  'plan_end',
  'tool_start',
  'tool_end',
  'review_card',
  'suggestions',
  'error',
  'end',
  // 重规划/子任务/推演
  'spawn_start',
  'spawn_end',
  'simulate_decision',
  'branch_result',
  'swap_branch',
  // 路径组装/节点追踪
  'assembly_candidate',
  'junction_verdict',
  'node_start',
  // 孵化/进化
  'signal_detected',
  'distill_outcome',
  'gate_verdict',
  'evolution_variant',
  'mutation_proposed',
  'regression_guard',
  // 时间线/补丁
  'patch_proposed',
  'patch_applied',
  'patch_reverted',
  // 记忆/调优/vetting
  'memory_recall',
  'tuning_update',
  'vetting_result',
  // 设备感知/控制
  'device_sensed',
  'device_control',
  // 后台任务（回合外任务载体）
  'task_start',
  'task_update',
  'task_done',
  'task_cancelled',
] as const;

export type EventTypeName = (typeof EVENT_TYPE_NAMES)[number];

/** 事件类型声明（与 event_types.json 条目形态对齐）。 */
export interface EventTypeSpec {
  name: EventTypeName;
  description: string;
  /** 绑定通道面：events.<name> 可被组件绑定订阅 */
  bindable: boolean;
}

export const EVENT_TYPE_SPECS: EventTypeSpec[] = [
  { name: 'reply_token', description: '流式回复 token', bindable: true },
  { name: 'thinking_start', description: '思考开始', bindable: true },
  { name: 'thinking_end', description: '思考结束', bindable: true },
  { name: 'plan_start', description: '规划开始', bindable: true },
  { name: 'plan_end', description: '规划结束', bindable: true },
  { name: 'tool_start', description: '工具调用开始（工具名/权限判定）', bindable: true },
  { name: 'tool_end', description: '工具调用结束（结果摘要）', bindable: true },
  { name: 'review_card', description: '审批卡弹出（朱砂 accent）', bindable: true },
  { name: 'suggestions', description: '建议', bindable: true },
  { name: 'error', description: '错误', bindable: true },
  { name: 'end', description: '回合结束', bindable: true },
  { name: 'spawn_start', description: '子任务开始', bindable: true },
  { name: 'spawn_end', description: '子任务结束', bindable: true },
  { name: 'simulate_decision', description: '决策点推演开始', bindable: true },
  { name: 'branch_result', description: '分支评分结果', bindable: true },
  { name: 'swap_branch', description: '换选分支', bindable: true },
  { name: 'assembly_candidate', description: '组装候选留痕（路径/边证据视图）', bindable: true },
  { name: 'junction_verdict', description: '汇流裁决留痕', bindable: true },
  { name: 'node_start', description: '节点执行开始（架构实例追踪）', bindable: true },
  { name: 'signal_detected', description: '孵化信号检测', bindable: true },
  { name: 'distill_outcome', description: '蒸馏产物', bindable: true },
  { name: 'gate_verdict', description: '闸门判定（放行/拦截）', bindable: true },
  { name: 'evolution_variant', description: '进化工厂变异体产出/拒绝', bindable: true },
  { name: 'mutation_proposed', description: '变异提案', bindable: true },
  { name: 'regression_guard', description: '防退化守卫', bindable: true },
  { name: 'patch_proposed', description: '补丁提案', bindable: true },
  { name: 'patch_applied', description: '补丁已应用', bindable: true },
  { name: 'patch_reverted', description: '补丁已回退', bindable: true },
  { name: 'memory_recall', description: '记忆召回', bindable: true },
  { name: 'tuning_update', description: '调优更新', bindable: true },
  { name: 'vetting_result', description: 'vetting 结果', bindable: true },
  { name: 'device_sensed', description: '设备感知留痕', bindable: true },
  { name: 'device_control', description: '设备控制留痕', bindable: true },
  { name: 'task_start', description: '后台任务启动', bindable: true },
  { name: 'task_update', description: '后台任务进度更新', bindable: true },
  { name: 'task_done', description: '后台任务完成', bindable: true },
  { name: 'task_cancelled', description: '后台任务取消', bindable: true },
];

export function isEventTypeName(name: string): name is EventTypeName {
  return (EVENT_TYPE_NAMES as readonly string[]).includes(name);
}
