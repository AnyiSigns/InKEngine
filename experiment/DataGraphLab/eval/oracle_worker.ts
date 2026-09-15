/**
 * oracle 记录生成的 worker_threads 工作侧（§6 并行生成：任务相互独立，按分片
 * 并行生成，扩产单位 = 行数）。每个 worker 对分到的任务切片跑 `oracleTrace` +
 * `recordFromStep`，把 `StoreRecord[]` 经传入的 MessagePort 回传主线程；主线程
 * 按切片序拼接保序（确定性：同 seed 逐字同结果，G0.1 不因并行改变）。软化 BFS
 * （safeTargets）与标签纪律都在 oracleTrace 内，worker 无任何旁路。
 */

import { isMainThread, workerData } from 'node:worker_threads';

import { oracleTrace } from '../teacher/oracle.js';
import { GRAPH } from '../runner/graph.js';
import { recordFromStep, type StoreRecord } from '../data/store.js';
import type { Task } from '../schema.js';

if (!isMainThread) {
  const { tasks, port, i } = workerData as { tasks: readonly Task[]; port: MessagePort; i: number };
  const rows: StoreRecord[] = [];
  for (const task of tasks) {
    for (const step of oracleTrace(task, GRAPH)) rows.push(recordFromStep(task, step));
  }
  port.postMessage({ i, rows });
}
