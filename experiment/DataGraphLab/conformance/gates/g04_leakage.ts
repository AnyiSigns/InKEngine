/**
 * G0.4 泄漏审计（docs/gates.md G0.4）：对固定 seed 批次构造 on-path oracle 记录
 * 集（oracleTrace → recordFromStep，obs 面即主臂数据的白名单投影），跑
 * `data/audit.ts` 的 `audit()`：① 特征白名单硬红线（expected/spec/plan_hidden/
 * plan_hash/seed 既不作键出现、其键名字符串也不混进 instruction/值文本；
 * `struct` 诊断 arch 是唯一例外，且只读公开 spec.goal、不参与本审计口径）；
 * ② train/heldout composition_id 零重叠 + 指令模板指纹（follow 族、数字掩码后）
 * 零重叠——goal 族模板跨骨架复用是多解设计语义，不计泄漏；③ 标签逐条回放，
 * 同 obs 冲突标签计 label_conflict 并 quarantine（冲突 >0 判失败），off-gold/
 * 不可回放进 quarantine（允许 >0，属正常隔离）。判据与 audit().passed 对齐。
 */

import { oracleTrace } from '../../teacher/oracle.js';
import { recordFromStep, type StoreRecord } from '../../data/store.js';
import { audit } from '../../data/audit.js';
import { GRAPH } from '../../runner/graph.js';
import type { Task } from '../../schema.js';
import { BATCH, buildResult, memoized, type GateContext, type GateResult } from './common.js';

const VERSION = 1;

function compute(ctx: GateContext): GateResult {
  const tasks: Task[] = [
    ...ctx.genTasks(BATCH.baseTrain),
    ...ctx.genTasks(BATCH.baseVal),
    ...ctx.genTasks(BATCH.baseHeldout),
  ];
  const records: StoreRecord[] = [];
  for (const task of tasks) {
    for (const step of oracleTrace(task, GRAPH)) records.push(recordFromStep(task, step));
  }
  const rep = audit(records, { tasks });
  return buildResult({
    gate: 'G0.4',
    version: VERSION,
    ctx,
    seeds: [BATCH.baseTrain.seed, BATCH.baseVal.seed, BATCH.baseHeldout.seed],
    metrics: {
      feature_leak_count: rep.featureLeakCount,
      skeleton_overlap_count: rep.skeletonOverlapCount,
      template_overlap_count: rep.templateOverlapCount,
      label_conflict_count: rep.labelConflictCount,
      quarantined_count: rep.quarantinedCount,
      checked_records: rep.notes.checkedRecords,
      tasks_joined: rep.notes.tasksJoined,
      replay_ok_tasks: rep.notes.replayOkTasks,
    },
    thresholds: {
      'feature_leak_count:eq': 0,
      'skeleton_overlap_count:eq': 0,
      'template_overlap_count:eq': 0,
      'label_conflict_count:eq': 0,
      'checked_records:min': 1,
      'tasks_joined:min': 1,
    },
    notes: rep.passed
      ? '主臂 obs 面白名单零违规；train/heldout 骨架零重叠；模板指纹重叠口径= follow 限定+数字掩码（goal 族模板共享为设计语义不判冲突，与 gates.md 同步）；quarantine=' +
        String(rep.quarantinedCount)
      : `失败模式：leak=${String(rep.featureLeakCount)}、skeleton=${String(rep.skeletonOverlapCount)}、template=${String(rep.templateOverlapCount)}、conflict=${String(rep.labelConflictCount)}`,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G0.4', ctx, () => compute(ctx));
}
