/**
 * `spec.goal` 的紧凑结构编码（诊断上界臂专用）。
 *
 * 特征白名单的硬红线是“expected/spec/plan 永不进主臂”，本函数是那条红线上唯一
 * 划开的口子：只读公开 `spec.goal`（不含 expected、不含 gold 计划），8 维定长，
 * 仅供 `struct` 诊断 arch 复核“表示上限”——绝不参与主臂训练、门禁与报告主指标。
 * 拆成独立文件的动机是职责切分：主特征源保持纯“公开可观测面”，goal 侧信道单独
 * 成页，审计时只需盯这一个文件。
 *
 * 编码口径：位 0..2 为 kind onehot（parity/gt/len 序），位 3 parity 目标值，
 * 位 4 gt 目标归一，位 5/6 len 区间端点归一，位 7 hasAll。`all` 合取按 `of` 前
 * 两条子目标填 kind 与各自参数；同类参数冲突时后到覆盖。类型不符/字段缺失记 0。
 */

export const GOAL_STRUCT_DIM = 8;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 单条子目标（或非合取顶层目标）写入 onehot 位与参数位；非法输入静默记 0。 */
function encodeGoal(a: Float32Array, goal: unknown): void {
  if (goal === null || typeof goal !== 'object') return;
  const g = goal as Readonly<Record<string, unknown>>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  switch (g.kind) {
    case 'parity': {
      a[0] = 1;
      const target = num(g.target);
      a[3] = target === 1 ? 1 : 0;
      break;
    }
    case 'gt': {
      a[1] = 1;
      const target = num(g.target);
      if (target !== null) a[4] = Math.max(-1, Math.min(1, target / 50));
      break;
    }
    case 'len': {
      a[2] = 1;
      const min = num(g.min);
      const max = num(g.max);
      if (min !== null) a[5] = clamp01(min / 16);
      if (max !== null) a[6] = clamp01(max / 16);
      break;
    }
    case 'all': {
      a[7] = 1;
      const of = Array.isArray(g.of) ? (g.of as readonly unknown[]).slice(0, 2) : [];
      for (const sub of of) encodeGoal(a, sub);
      break;
    }
    default:
      break;
  }
}

/** 只读公开 `spec.goal` 的 8 维编码；spec 缺 goal 或 kind 不认识时返回全零。 */
export function featurizeGoalStruct(
  spec: Readonly<Record<string, unknown>>,
): Float32Array {
  const a = new Float32Array(GOAL_STRUCT_DIM);
  if (spec !== null && typeof spec === 'object') encodeGoal(a, spec.goal);
  return a;
}
