/**
 * 数据契约：Task/Step/Trajectory/Verdict/Manifest 与稳定 `task_hash`。
 *
 * `task_hash` 口径来自 C.1：hashObj({instruction, family, x, expected,
 * world_version})，不含 plan——计划是否变化由 `plan_hash` 单独承载，故数据去重键
 * （style, composition_id, instruction, x, expected, plan_hash）不能省略 plan_hash。
 * `world_version` 见 world/version.ts，是 world/operators 契约表的规范 hash。
 */

import { hashObj } from './world/hash.js';
import { worldVersion } from './world/version.js';

export type Style = 'follow' | 'goal';
export type Family = 'value' | 'verify' | 'goal' | 'goal_verify';
export type Split = 'train' | 'val' | 'heldout';
export type Root = 'Int' | 'Str';

/**
 * 一个任务的公开 + 隐藏两半：public = instruction/x/spec/expected/候选动作集，
 * hidden = plan_hidden（gold）。控制器只见 public；verify 只吃 public + 产物。
 */
export interface Task {
  readonly style: Style;
  readonly family: Family;
  readonly instruction: string;
  readonly x: number | string;
  /** 公开校验/目标（check_* 与 goal_ok 读它），运行期只读。 */
  readonly spec: Readonly<Record<string, unknown>>;
  /** 真值：回放求出（配方族=计划输出；目标族=达标 witness），仅供验收/调试。 */
  readonly expected: number | string;
  /** 隐藏 gold plan（含收尾终算子），控制器不可见。 */
  readonly plan_hidden: readonly string[];
  readonly root: Root;
  /** hashObj(plan)：计划指纹，与 task_hash 分开进入去重键。 */
  readonly plan_hash: string;
  /** 骨架签名 id（C.1 `_skel_id`）；train/held-out 切分只看它。 */
  readonly composition_id: string;
  readonly split: Split;
}

/** 逐步轨迹的一行（C.3 oracle_trace 产物）。 */
export interface Step {
  readonly step: number;
  readonly obs: Readonly<{
    x: unknown;
    answer: unknown;
    verdict: unknown;
    hist: readonly string[];
  }>;
  readonly candidates: readonly string[];
  readonly action: string;
}

export type TeacherKind = 'oracle' | 'search' | 'llm';

/** 数据存储的轨迹记录（§5 字段全量）。 */
export interface Trajectory {
  readonly task_id: string;
  readonly task_hash: string;
  readonly world_version: string;
  readonly generator_version: string;
  readonly acceptor_version: string;
  readonly style: Style;
  readonly family: Family;
  readonly observation: {
    readonly instruction: string;
    readonly state_digest: string;
    readonly candidate_actions: readonly string[];
    readonly action_space_digest: string;
  };
  readonly step_index: number;
  readonly action: string;
  readonly done: boolean;
  readonly teacher: { readonly kind: TeacherKind; readonly model_pin: string; readonly plan_id: string };
  readonly verdict: {
    readonly passed: boolean;
    readonly checker: string;
    readonly evidence_hash: string;
    readonly channel: string;
  };
  readonly split: Split;
  readonly composition_id: string;
  readonly provenance: { readonly seed: number; readonly ts: string; readonly code_hash: string };
}

/** 验收结论（C.2 `Verdict(passed, reason)` 的 TS 形状）。 */
export interface Verdict {
  readonly passed: boolean;
  readonly reason: string;
}

/** 数据集快照的版本 pin（§6：全员版本化，可复现、可回滚）。 */
export interface Manifest {
  readonly world_version: string;
  readonly generator_version: string;
  readonly acceptor_version: string;
  readonly teacher_pin: string;
  readonly controller_code_hash: string;
  readonly probe_hash: string;
}

/** C.1 唯一口径：字典序规范序列化后取 sha1 前 16 位。 */
export function taskHash(task: Task): string {
  return hashObj({
    instruction: task.instruction,
    family: task.family,
    x: task.x,
    expected: task.expected,
    world_version: worldVersion,
  });
}
