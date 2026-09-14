/**
 * 门禁共享 harness（docs/gates.md §0）：统一构造上下文、依序执行
 * G0.1→G2.2 与 F1→F4、写机器可读结果、判 exit code。`inputs_hash` =
 * hashObj{world_version, 数据集 manifest hash, fixture hash}——三者任一变化
 * 都会让历史结果不可复用（§0.3.4）。任一 `passed=false` 整体退出码 1，但
 * **继续跑完全部**并照样落盘（失败也要报告）；测试与非落盘调用把 `outDir`
 * 置空，仓库 `runs/` 只由 CLI 入口写入。给出 `runId` 时上下文构造即在同 run
 * 目录落 `manifest.json`：全员版本化快照加 `inputs_hash`，让每个 run 目录
 * 自带版本 pin 证据（审计面产物，不参与哈希）。
 *
 * 数据批次经 `genTasks` 缓存：同一 (split, perFamily, seed) 全 run 只生成
 * 一次，这让各门禁共享同一确定性数据集而不各付一遍生成成本；缓存键入
 * hashObj 防手工拼接歧义。G1.2/G1.3 的 scaling 证据路径经 `resultsPath`
 * 注入（缺省扫 runs/ 下最新 scale 目录）。F1/F2 经子进程调
 * `conformance/py_forward.py`（默认仓库 `.venv`，可用 DGL_PYTHON 覆盖），
 * 复用训练器前向数学、两侧不复刻公式。零网络零 LLM；随机/哈希全部走
 * world/rng、world/hash。
 */

import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashObj } from '../../world/hash.js';
import { worldVersion } from '../../world/version.js';
import { makeSplit } from '../../gen/generator.js';
import { acceptorSourceVersion, generatorSourceVersion, manifest } from '../../data/provenance.js';
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
import { run as runG11 } from './g11_no_free_lunch.js';
import { run as runG12 } from './g12_main_target.js';
import { run as runG13 } from './g13_three_arms.js';
import { run as runG22 } from './g22_beyond_oracle.js';
import { runF1, runF2, runF3, runF4 } from '../f_gates.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(dirname(HERE));
const RUNS_ROOT = join(PKG_ROOT, 'runs');

/** scale 目录名前缀：任务口径 `scale-`，C.8 文面 `scale_`，两者皆认；按名升序即按 stamp 升序。 */
const SCALE_DIR_RE = /^scale[-_]/;

/**
 * 缺省 resultsPath：扫 runs/ 下最新（名 stamp 最大）scale 目录的 results.json；
 * 该目录缺文件不回退旧 run（证据缺口如实暴露给 G1.2/G1.3 的 not-found 失败模式）。
 */
function findLatestScaleResults(): string | undefined {
  if (!existsSync(RUNS_ROOT)) return undefined;
  const dirs = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SCALE_DIR_RE.test(d.name))
    .map((d) => d.name)
    .sort();
  const latest = dirs[dirs.length - 1];
  if (latest === undefined) return undefined;
  const candidate = join(RUNS_ROOT, latest, 'results.json');
  return existsSync(candidate) ? candidate : undefined;
}

/** 依序执行的门禁注册表；G2.x/G4.x 落地时在此续排。F1–F4 收尾防漂移（F.3）。 */
const GATES: ReadonlyArray<{ gate: GateId; run: (ctx: GateContext) => GateResult }> = [
  { gate: 'G0.1', run: runG01 },
  { gate: 'G0.2', run: runG02 },
  { gate: 'G0.3', run: runG03 },
  { gate: 'G0.4', run: runG04 },
  { gate: 'G0.5', run: runG05 },
  { gate: 'G0.6', run: runG06 },
  { gate: 'G1.1', run: runG11 },
  { gate: 'G1.2', run: runG12 },
  { gate: 'G1.3', run: runG13 },
  { gate: 'G2.2', run: runG22 },
  { gate: 'F1', run: runF1 },
  { gate: 'F2', run: runF2 },
  { gate: 'F3', run: runF3 },
  { gate: 'F4', run: runF4 },
];

/**
 * `runDir` 缺省即不落盘（vitest 语义）；给出目录时结果写 `<runDir>/<gate>.json`。
 * `run_id` 只决定目录名，不进门禁判定，故带时间戳无碍复算。
 * `resultsPath` 显式注入优先（测试合成 fixture 走这道口）；缺省扫 `runs/` 下
 * `scale-*`/`scale_*`（C.8 文面为下划线，两处兼容）目录名取最大 stamp 的最新
 * 一次 scale，仅当其真有 `results.json` 时采用——最新 run 缺文件是证据缺口，
 * **不回退旧 run 顶替**（旧证据冒充新结果是伪造）。G0.* 不读 resultsPath。
 */
export function createGateContext(opts: { runId?: string; resultsPath?: string } = {}): GateContext {
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as GateFixtures & {
    meta: { generator: string; schema: number };
  };
  const fixturesHash = hashObj(fixtures);
  // manifestHash 与 run 级快照（下方 manifest.json）同参取真实源码指纹：
  // generator/acceptor 源码漂移必须翻转 inputs_hash，旧门禁结果不可复用（全员版本化）。
  const manifestHash = hashObj(manifest({
    generatorVersion: generatorSourceVersion(),
    acceptorVersion: acceptorSourceVersion(),
  }));
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
  const resultsPath = opts.resultsPath ?? findLatestScaleResults();
  const returnCtx: GateContext = {
    worldVersion, inputsHash, manifestHash, fixturesHash, fixtures, genTasks, outDir, artifactPrefix,
    ...(resultsPath === undefined ? {} : { resultsPath }),
  };
  if (outDir !== undefined) {
    // 完成定义的落盘件：run 级 manifest = §6 全员版本化快照（generator/acceptor 用
    // 源码指纹而非缺省值）+ 门禁 inputs_hash。文件本身是审计面产物，不参与任何哈希。
    const runDir = dirname(outDir);
    mkdirSync(runDir, { recursive: true });
    const snapshot = manifest({
      generatorVersion: generatorSourceVersion(),
      acceptorVersion: acceptorSourceVersion(),
    });
    writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify({ ...snapshot, inputs_hash: inputsHash }, null, 2)}\n`, 'utf8');
  }
  return returnCtx;
}

/** 依序跑全部门禁；单个门禁抛错按失败兜底继续（§0.3.1「失败也要报告」）。 */
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
