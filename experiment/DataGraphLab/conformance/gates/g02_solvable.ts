/**
 * G0.2 生成可解（docs/gates.md G0.2）：对本批 emitted tasks 逐一用 hidden
 * `plan_hidden` 回放 `runPlan`，随后 `accept(task, state)`——终算子已由
 * `make_task` 按族追加（value/goal 仅 submit；verify/goal_verify 加 check_*，
 * spec 随之写入），这里只做独立复核、不改写任何字段。批次取固定 seed 的
 * makeSplit train/val/heldout 各 perFamily 条 + 若干 makeTask 直出样本，
 * 保证秒级完成。solvable_ratio 必须 == 1；回放死路单列 replay_fail_count。
 */

import { initState, runPlan } from '../../world/operators.js';
import { makeTask } from '../../gen/generator.js';
import { accept } from '../../verify/acceptor.js';
import type { Family, Style, Task } from '../../schema.js';
import { BATCH, buildResult, memoized, type GateContext, type GateResult } from './common.js';

const VERSION = 1;

const DIRECT_STYLE_FAMILY: readonly (readonly [Style, Family])[] = [
  ['follow', 'value'],
  ['follow', 'verify'],
  ['goal', 'goal'],
  ['goal', 'goal_verify'],
];

/** makeTask 直出样本：覆盖四族，seed 显式且与 makeSplit 批次错开。 */
function directTasks(): Task[] {
  const out: Task[] = [];
  for (let i = 0; i < BATCH.g02DirectCount; i++) {
    const [style, family] = DIRECT_STYLE_FAMILY[i % DIRECT_STYLE_FAMILY.length]!;
    const task = makeTask(BATCH.g02DirectSeedBase + i, style, family);
    if (task === null) {
      throw new Error(`g02: makeTask(seed=${String(BATCH.g02DirectSeedBase + i)}, ${style}/${family}) 产出 null`);
    }
    out.push(task);
  }
  return out;
}

function compute(ctx: GateContext): GateResult {
  const base = BATCH;
  const tasks = [
    ...ctx.genTasks(base.baseTrain),
    ...ctx.genTasks(base.baseVal),
    ...ctx.genTasks(base.baseHeldout),
    ...directTasks(),
  ];
  let accepted = 0;
  let replayFail = 0;
  const failed: string[] = [];
  for (const task of tasks) {
    const st = runPlan(task.plan_hidden, initState(task.x, task.spec));
    if (st === null) {
      replayFail++;
      if (failed.length < 5) failed.push(`${task.family}/${task.composition_id}: 回放死路`);
      continue;
    }
    if (accept(task, st)) accepted++;
    else if (failed.length < 5) failed.push(`${task.family}/${task.composition_id}: 回放成功但 accept 未过`);
  }
  const total = tasks.length;
  const expectedTotal = (base.baseTrain.perFamily + base.baseVal.perFamily + base.baseHeldout.perFamily) * 4 + BATCH.g02DirectCount;
  return buildResult({
    gate: 'G0.2',
    version: VERSION,
    ctx,
    seeds: [base.baseTrain.seed, base.baseVal.seed, base.baseHeldout.seed, BATCH.g02DirectSeedBase],
    metrics: {
      solvable_ratio: total > 0 ? accepted / total : 0,
      task_count: total,
      replay_fail_count: replayFail,
    },
    thresholds: {
      'solvable_ratio:eq': 1,
      'task_count:eq': expectedTotal,
      'replay_fail_count:eq': 0,
    },
    notes:
      accepted === total && total === expectedTotal
        ? '全部 emitted task 的 hidden plan 回放穿验收；终算子仅由生成侧按族追加一次'
        : `失败模式（前若干例）：${failed.join('; ') || '计数不符'}（accepted=${String(accepted)}/${String(total)}，期望 ${String(expectedTotal)} 条）`,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G0.2', ctx, () => compute(ctx));
}
