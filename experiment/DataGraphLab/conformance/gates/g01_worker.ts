/**
 * G0.1 的生成子进程脚本：由 `g01_determinism.ts` 经 tsx 起两个独立进程执行，
 * 每张用例跑 `makeTask(seed, style, family, split?)` 取 `taskHash`（口径即
 * hashObj{instruction, family, x, expected, world_version}），以 `canonicalJson`
 * 规范序列化后打到 stdout——键序/数字格式全部走唯一口径，父进程拿到的就是
 * 可逐字节比较的确定性输出。用例表是本文件唯一真源，门禁侧只 import 表体，
 * 两处绝不各写一份。任何用例产出 null（重试耗尽）都视为确定性破坏：非零
 * 退出并把位置写进 stderr，父进程据此判失败，不当“正常但少一条”处理。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../world/hash.js';
import { makeTask } from '../../gen/generator.js';
import { taskHash, type Task } from '../../schema.js';
import type { DeterminismCase } from './common.js';

/** 跨进程复算用例（seed → makeTask 全链路）：family/split 覆盖四族×三切分。 */
export const G01_CASES: readonly DeterminismCase[] = Object.freeze([
  { seed: 1, style: 'follow', family: 'value', split: 'train' },
  { seed: 2, style: 'follow', family: 'verify', split: 'train' },
  { seed: 3, style: 'goal', family: 'goal', split: 'train' },
  { seed: 4, style: 'goal', family: 'goal_verify', split: 'heldout' },
  { seed: 5, style: 'follow', family: 'value', split: 'heldout' },
  { seed: 6, style: 'follow', family: 'verify', split: 'val' },
  { seed: 7, style: 'goal', family: 'goal', split: 'val' },
  { seed: 8, style: 'goal', family: 'goal_verify', split: 'heldout' },
  { seed: 11, style: 'follow', family: 'value' },
  { seed: 12, style: 'goal', family: 'goal' },
  { seed: 13, style: 'follow', family: 'verify', split: 'train' },
  { seed: 21, style: 'goal', family: 'goal_verify', split: 'heldout' },
]);

/** 子进程主逻辑：产出 canonical 的 task_hash 数组串（同参必同串）。 */
export function buildHashLine(cases: readonly DeterminismCase[]): string {
  const hashes = cases.map((c) => {
    const task: Task | null = makeTask(c.seed, c.style, c.family, c.split);
    if (task === null) {
      throw new Error(`g01_worker: 用例 seed=${String(c.seed)} (${c.style}/${String(c.family)}) 产出 null`);
    }
    return taskHash(task);
  });
  return canonicalJson(hashes);
}

function main(): void {
  try {
    process.stdout.write(buildHashLine(G01_CASES));
  } catch (err) {
    process.stderr.write(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
