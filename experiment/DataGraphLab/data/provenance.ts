/**
 * 数据集溯源（§6）：全员版本化 manifest 与多解冲突率诊断。
 *
 * - `manifest`：world、generator、acceptor、teacher pin、控制器代码 hash、签名
 *   探针集（PROBE_INT/PROBE_STR，去冗余与 G2.2 的共同口径）hash 汇成一个稳定 JSON
 *   对象；数据集快照 = manifest，可复现、可回滚。指纹一律 `hashObj` 规范序列化，
 *   同输入逐字同串；控制器代码逐文件读内容入 hash（文件缺席如实记 null，缺席也
 *   是版本）。`teacher_pin` 缺省钉在 on-path oracle（本阶段零 API、无模型漂移）。
 * - `safeActionConflictRate`：目标族多解噪音诊断（C.8 报告项）——固定 seed 抽样
 *   ≤200 个 on-path 状态，对每状态找「合法但不同于已记录动作、且仍通向验收」的
 *   候选（bounded BFS，检索内核见 data/conflict_bfs.ts）；占比只作诊断不进门禁，
 *   首轮实测校准后才允许在 Phase 2 门禁内把标签软化为动作集分布。BFS 截断保守计
 *   未冲突、截断数如实入 notes。
 * - G0.4 泄漏审计主入口 `audit` 在 data/audit.ts 实现，本文件 re-export 保持
 *   附录 D 的公开面（manifest / audit / safe_action_conflict_rate）单一真源。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashObj } from '../world/hash.js';
import { makeRng } from '../world/rng.js';
import { EXIT, applyOp, type Graph, type State } from '../world/operators.js';
import { GRAPH, candidates } from '../runner/graph.js';
import { worldVersion } from '../world/version.js';
import { accept } from '../verify/acceptor.js';
import { PROBE_INT, PROBE_STR } from '../gen/skeletons.js';
import { isOnPath } from '../teacher/oracle.js';
import { taskHash, type Manifest, type Task } from '../schema.js';
import { reachesAccept } from './conflict_bfs.js';
import { requireCoords } from './audit.js';
import type { StoreRecord } from './store.js';

export { audit, templateFingerprint } from './audit.js';
export type { AuditOptions, AuditReport, QuarantineEntry, QuarantineReason } from './audit.js';
export { stateDigest } from './conflict_bfs.js';

function pkgRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** 控制器代码指纹：逐文件内容进规范序列化（TS 单侧自检口径，F.2.5）。 */
export function controllerCodeHash(files: readonly string[] = ['controller/slots.ts']): string {
  const parts = files.map((f) => {
    const abs = join(pkgRoot(), f);
    return { path: f, content: existsSync(abs) ? readFileSync(abs, 'utf8') : null };
  });
  return hashObj(parts);
}

export interface ManifestOptions {
  readonly generatorVersion?: string;
  readonly acceptorVersion?: string;
  readonly teacherPin?: string;
  /** 控制器代码 hash 的取料文件（相对包根）；缺省钉现有 controller 源。 */
  readonly codeHashFiles?: readonly string[];
  readonly probes?: { readonly int: readonly (number | string)[]; readonly str: readonly (number | string)[] };
}

/** 全员版本化清单：同输入逐字同串，数据集快照的唯一锚点。 */
export function manifest(opts: ManifestOptions = {}): Manifest {
  const probes = opts.probes ?? { int: PROBE_INT, str: PROBE_STR };
  return {
    world_version: worldVersion,
    generator_version: opts.generatorVersion ?? 'unknown',
    acceptor_version: opts.acceptorVersion ?? 'unknown',
    teacher_pin: opts.teacherPin ?? 'oracle@plan_hidden',
    controller_code_hash: controllerCodeHash(opts.codeHashFiles),
    probe_hash: hashObj({ int: [...probes.int], str: [...probes.str] }),
  };
}

export interface ConflictRateOptions {
  readonly seed?: number;
  readonly limit?: number;
  readonly nodeBudget?: number;
  readonly graph?: Graph;
  readonly tasks?: readonly Task[];
}

export interface ConflictRateReport {
  readonly rate: number;
  readonly sampled: number;
  readonly notes: {
    readonly poolSize: number;
    readonly limit: number;
    readonly nodeBudget: number;
    readonly seed: number;
    readonly skippedNoTask: number;
    readonly skippedOffPath: number;
    readonly conflictStates: number;
    readonly truncatedStates: number;
  };
}

/** 从记录 + task join 重建决策现场（obs 三元组 + hist，spec 由任务侧供给）。 */
function stateFromRecord(rec: StoreRecord, task: Task): State {
  return {
    x: rec.x,
    answer: rec.state.answer,
    verdict: rec.state.verdict,
    hist: [...rec.hist],
    spec: task.spec,
  };
}

/**
 * 安全动作集冲突率（诊断项）：金标外仍有合法且通向验收的动作的 on-path 状态占比。
 * 抽样 = 固定 seed 下对全池（按码点稳定排序后）shuffle 取前 ≤limit；逐状态做
 * 有界 BFS 判「通向验收」，同 obs 的判定不依赖遍历顺序以外的一切随机源。
 */
export function safeActionConflictRate(
  records: readonly StoreRecord[],
  opts: ConflictRateOptions = {},
): ConflictRateReport {
  const seed = opts.seed ?? 0;
  const limit = Math.min(opts.limit ?? 200, 200);
  const nodeBudget = opts.nodeBudget ?? 2000;
  const graph = opts.graph ?? GRAPH;
  const taskByKey = new Map<string, Task>((opts.tasks ?? []).map((t) => [taskHash(t), t]));

  const entries = records.map((rec, i) => ({ coords: requireCoords(rec, i), rec }));
  // 排序只许码点比较（localeCompare 依赖 locale，会破坏跨进程确定性，G0.1）。
  entries.sort((a, b) => {
    if (a.coords.task_hash !== b.coords.task_hash) return a.coords.task_hash < b.coords.task_hash ? -1 : 1;
    if (a.coords.step_index !== b.coords.step_index) return a.coords.step_index - b.coords.step_index;
    return a.rec.target < b.rec.target ? -1 : a.rec.target > b.rec.target ? 1 : 0;
  });
  const pool = makeRng(seed).shuffle(entries).slice(0, Math.min(limit, entries.length));

  let sampled = 0;
  let conflictStates = 0;
  let truncatedStates = 0;
  let skippedNoTask = 0;
  let skippedOffPath = 0;
  for (const { coords, rec } of pool) {
    const task = taskByKey.get(coords.task_hash);
    if (task === undefined) {
      skippedNoTask++;
      continue;
    }
    const st = stateFromRecord(rec, task);
    // 只诊断 on-path 状态：off-path 的「多解」不属于金标标签噪音口径。
    if (!isOnPath(st.hist, task.plan_hidden)) {
      skippedOffPath++;
      continue;
    }
    sampled++;
    let reachedAlt = false;
    let truncated = false;
    for (const alt of candidates(graph, st, st.hist)) {
      if (alt === rec.target) continue;
      if (alt === EXIT) {
        // 提前结束也算「通向验收」：当前状态已被接受即构成金标外可行分支。
        if (accept(task, st)) reachedAlt = true;
        continue;
      }
      const next = applyOp(graph, alt, st);
      if (next === null) continue;
      const res = reachesAccept(graph, task, next, nodeBudget);
      if (res.truncated) truncated = true;
      if (res.reached) {
        reachedAlt = true;
        break;
      }
    }
    if (reachedAlt) conflictStates++;
    else if (truncated) truncatedStates++;
  }
  return {
    rate: sampled > 0 ? conflictStates / sampled : 0,
    sampled,
    notes: {
      poolSize: entries.length,
      limit,
      nodeBudget,
      seed,
      skippedNoTask,
      skippedOffPath,
      conflictStates,
      truncatedStates,
    },
  };
}
