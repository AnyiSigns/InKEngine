/**
 * 门禁共享 harness（docs/gates.md §0）：统一构造上下文、依序执行 G0.1→G0.6、
 * 写机器可读结果、判 exit code。`inputs_hash` = hashObj{world_version, 数据集
 * manifest hash, fixture hash}——三者任一变化都会让历史结果不可复用（§0.3.4）。
 * 任一 `passed=false` 整体退出码 1，但**继续跑完全部**并照样落盘（失败也要
 * 报告）；测试与非落盘调用把 `outDir` 置空，仓库 `runs/` 只由 CLI 入口写入。
 *
 * 数据批次经 `genTasks` 缓存：同一 (split, perFamily, seed) 全 run 只生成一次，
 * 这让六个门禁共享同一确定性数据集而不各付一遍生成成本；缓存键入 hashObj
 * 防手工拼接歧义。零网络零 LLM；随机/哈希全部走 world/rng、world/hash。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashObj } from '../../world/hash.js';
import { worldVersion } from '../../world/version.js';
import { makeSplit } from '../../gen/generator.js';
import { manifest } from '../../data/provenance.js';
import { FIXTURES_PATH } from '../gen_golden.js';
import type { Task } from '../../schema.js';

import {
  failureResult,
  type BatchSpec,
  type GateContext,
  type GateFixtures,
  type GateId,
  type GateResult,
} from './common.js';
// 唯一公开面：上下文/结果形状由 common 定义，harness 透出避免测试双侧 import 分裂。
export type { BatchSpec, GateContext, GateId, GateResult } from './common.js';
import { run as runG01 } from './g01_determinism.js';
import { run as runG02 } from './g02_solvable.js';
import { run as runG03 } from './g03_adversarial.js';
import { run as runG04 } from './g04_leakage.js';
import { run as runG05 } from './g05_kl.js';
import { run as runG06 } from './g06_goal_separability.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(dirname(HERE));
const RUNS_ROOT = join(PKG_ROOT, 'runs');

/** 依序执行的门禁注册表；G1.x/G2.x 落地时在此续排。 */
const GATES: ReadonlyArray<{ gate: GateId; run: (ctx: GateContext) => GateResult }> = [
  { gate: 'G0.1', run: runG01 },
  { gate: 'G0.2', run: runG02 },
  { gate: 'G0.3', run: runG03 },
  { gate: 'G0.4', run: runG04 },
  { gate: 'G0.5', run: runG05 },
  { gate: 'G0.6', run: runG06 },
];

/**
 * `runDir` 缺省即不落盘（vitest 语义）；给出目录时结果写 `<runDir>/<gate>.json`。
 * `run_id` 只决定目录名，不进门禁判定，故带时间戳无碍复算。
 */
export function createGateContext(opts: { runId?: string } = {}): GateContext {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as GateFixtures & {
    meta: { generator: string; schema: number };
  };
  const fixturesHash = hashObj(fixtures);
  const manifestHash = hashObj(manifest());
  const inputsHash = hashObj({ world_version: worldVersion, manifest_hash: manifestHash, fixtures_hash: fixturesHash });
  const runId = opts.runId;
  const outDir = runId === undefined ? undefined : join(RUNS_ROOT, runId, 'gates');
  // artifacts 统一相对**仓库根**（gates.md §0.2）；包根相对仓库根恰为两段。
  const repoRoot = join(PKG_ROOT, '..', '..');
  const artifactPrefix =
    outDir === undefined ? '' : relative(repoRoot, outDir).replaceAll('\\', '/');
  // 批次缓存：键为规范序列化，值冻结复用；确定性使多次取用逐字相同。
  const cache = new Map<string, Task[]>();
  const genTasks = (spec: BatchSpec): Task[] => {
    const key = hashObj(spec);
    let tasks = cache.get(key);
    if (tasks === undefined) {
      tasks = makeSplit(spec.split, spec.perFamily, spec.seed);
      cache.set(key, tasks);
    }
    return tasks;
  };
  return { worldVersion, inputsHash, manifestHash, fixturesHash, fixtures, genTasks, outDir, artifactPrefix };
}

/** 依序跑全部六门禁；单个门禁抛错按失败兜底继续（§0.3.1「失败也要报告」）。 */
export function runAll(ctx: GateContext): GateResult[] {
  const results: GateResult[] = [];
  for (const { gate, run } of GATES) {
    let res: GateResult;
    try {
      res = run(ctx);
    } catch (err) {
      res = failureResult(gate, ctx, err);
    }
    // 结果文件自身也是证据：文件名在落盘前就写进 artifacts（键名与内容一致）。
    const file = `${gate}.json`;
    const named: GateResult = ctx.outDir === undefined
      ? res
      : { ...res, artifacts: [...res.artifacts, `${ctx.artifactPrefix}/${file}`] };
    if (ctx.outDir !== undefined) {
      mkdirSync(ctx.outDir, { recursive: true });
      writeFileSync(join(ctx.outDir, file), `${JSON.stringify(named, null, 2)}\n`, 'utf8');
    }
    results.push(named);
  }
  return results;
}

export function summaryLine(res: GateResult): string {
  return `${res.gate} ${res.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(res.metrics)}${res.notes ? ` notes=${res.notes}` : ''}`;
}

/**
 * CLI：`npm run gate [--check]`。逐行打印门禁结果（机器可读全文见落盘 JSON），
 * 任一失败 → 退出码 1（CI 语义）；`--check` 只作显式 CI 开关，判定逻辑与缺省一致。
 */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  // `--check` 是显式 CI 开关：判定逻辑与缺省完全一致（全量跑 + 落盘 + 失败即非 0）。
  void argv;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const runId = `gates-${stamp}`;
  const ctx = createGateContext({ runId });
  const results = runAll(ctx);
  for (const r of results) console.log(summaryLine(r));
  const failed = results.filter((r) => !r.passed);
  console.log(
    `gate: ${String(results.length - failed.length)}/${String(results.length)} passed -> ${ctx.outDir}`,
  );
  if (failed.length > 0) {
    console.error(`gate: FAILING ${failed.map((f) => f.gate).join(' ')}`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
