/**
 * F1–F4 防漂移门禁模块（判据/阈值照 F.3 表，Phase 1 必过否则实验无效）。
 *
 * F1 前向一致：固定权重 + 固定特征下，TS 与 Python 两侧统一 float64 累加后比
 * softmax 分布逐元素（max|Δ| < 1e-6）。产品推理的 scoresFromObs 在链尾把概率
 * cast float32，不满足 F1 的 f64 判据，故本模块用 f_math 的 f64 重算路径；
 * Python 侧经子进程调 py_forward.py，它只装配输入、张量数学 import
 * controller/train_nn.py（两侧都不复刻前向公式）。
 * F2 往返一致：同一候选集上 TS 与 Python 各做 greedy 并比 action 一致率
 * （100% 才过；|top1−top2| < 1e-4 视为并列、按小下标取，与 py_forward 同窗口）。
 * TS 贪心走 Policy.actFromObs（f32 概率首位取大），并列窗口用 f64 重算路径判定；
 * fixture 生成时已保证各组 top1−top2 ≥ 1e-3，两类路径不会在 argmax 上分歧。
 * F3 特征单源：静态扫描训练器与 conformance 入口源码，banned 标识符零容忍
 * （注释命中也算违规）；files 可注入，供测试故意塞带 LEXICON 的伪文件验审计。
 * F4 规范序列化自检（TS 单侧）：canonicalJson 的数字格式边角与 hashObj 对冻结
 * 期望逐字一致，且同对象两次 hashObj 恒定。
 *
 * F1/F2 依赖 fixture 目录 conformance/ffixtures/（git 跟踪、无时间戳）；跨语言
 * 桥只经该目录，Python 解释器默认仓库 `.venv`，可用环境变量 DGL_PYTHON 覆盖。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Policy, type HeadTag } from '../controller/policy.js';
import type { FeatureSet } from '../controller/features.js';
import { canonicalJson, hashObj } from '../world/hash.js';
import { buildResult, type GateContext, type GateId, type GateResult } from './gates/common.js';
import {
  TIE_WINDOW,
  actsOf,
  denseOf,
  forward64,
  subsetOf,
  topTwo,
  type WeightsSubset,
} from './f_math.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
const REPO_ROOT = dirname(dirname(PKG_ROOT));
const FIXTURE_DIR = join(HERE, 'ffixtures');
const PY_FORWARD = join(HERE, 'py_forward.py');

const VERSION = 1;
const PY_TIMEOUT_MS = 60_000;

/** F3 banned 标识符（精确子串、大小写敏感；零容忍）。 */
const BANNED_IDENTIFIERS: readonly string[] = Object.freeze([
  'LEXICON', 'LEX_OPS_BASE', 'GOAL_LEX', 'GOAL_TEMPLATES', 'mentionStats', 'mention_stats',
  'tokenize', 'tokens(', 'featurizeObs', 'featurizeAction', 'stateStats', 'featurize_instr',
  'crc32', 'canonicalJson', 'hashObj', 'GOAL_STRUCT',
]);

/** F3 默认扫描清单（相对包根）：训练器两份 Python 源码 + 本 conformance 入口。 */
const F3_DEFAULT_PATHS: readonly string[] = Object.freeze([
  'controller/train.py',
  'controller/train_nn.py',
  'conformance/py_forward.py',
]);

/** F4 用例表：值必须与 f4_expected.json 生成时逐一对应，否则逐字比对即红。 */
const F4_CASES: readonly { label: string; value: unknown }[] = Object.freeze([
  { label: 'zero_point_one', value: 0.1 },
  { label: 'exp_tiny', value: 1e-7 },
  { label: 'one_value', value: 1 },
  { label: 'negative_zero', value: -0.0 },
  { label: 'cjk_string', value: '中' },
  {
    label: 'nested_mixed',
    value: { b: 0.1, a: [1e-7, { z: '中', y: -0.0 }], c: '中', d: [true, false, null, [], {}, 1, 1.0] },
  },
]);

/** F3 可注入的扫描文件：path 仅作溯源标记，content 参与子串匹配。 */
export interface F3File {
  readonly path: string;
  readonly content: string;
}

/** F 门禁 id 直传（GateId 联合类型已含 F1–F4）。 */
function gateId(id: 'F1' | 'F2' | 'F3' | 'F4'): GateId {
  return id;
}

/** Python 解释器：DGL_PYTHON 环境变量优先，缺省仓库 `.venv`（Windows/POSIX 两落位）。 */
function pythonPath(): string {
  const override = process.env.DGL_PYTHON;
  if (override !== undefined && override.length > 0) return override;
  return process.platform === 'win32'
    ? join(REPO_ROOT, '.venv', 'Scripts', 'python.exe')
    : join(REPO_ROOT, '.venv', 'bin', 'python');
}

function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

function readFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as Record<string, unknown>;
}

/** F2 权重解析（与 py_forward._resolve_weights 同优先级）：内联 weights > weights_path。 */
function resolveWeights(fx: Record<string, unknown>, obsDim: number, actDim: number): WeightsSubset {
  const direct = fx['weights'];
  if (direct !== null && direct !== undefined) return subsetOf(direct, obsDim, actDim, 'F2/weights');
  const ref = fx['weights_path'];
  if (typeof ref === 'string') {
    const file = readFixture(ref);
    const nested = file['weights'];
    if (nested !== null && nested !== undefined) return subsetOf(nested, obsDim, actDim, 'F2/weights_path');
    return subsetOf(file, obsDim, actDim, 'F2/weights_path');
  }
  throw new Error('F2: fixture 既无内联 weights 也无 weights_path');
}

/** 子进程跑 py_forward：结果 JSON 落临时目录，读完即删；解释器缺失/非零退出即抛。 */
function runPy(mode: 'f1' | 'f2', inPath: string): unknown {
  const py = pythonPath();
  if (!existsSync(py)) {
    throw new Error(`F 门禁: 找不到 Python 解释器 ${py}（可用环境变量 DGL_PYTHON 指定）`);
  }
  const work = mkdtempSync(join(tmpdir(), 'dgl-fgates-'));
  const outPath = join(work, 'out.json');
  try {
    const res = spawnSync(
      py,
      [PY_FORWARD, '--mode', mode, '--in', inPath, '--out', outPath],
      { encoding: 'utf8', timeout: PY_TIMEOUT_MS },
    );
    if (res.error !== undefined) {
      throw new Error(`F 门禁: 启动 Python 失败（${py}）：${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`F 门禁: py_forward --mode ${mode} 退出码 ${String(res.status)}：${String(res.stderr)}`);
    }
    if (!existsSync(outPath)) {
      throw new Error(`F 门禁: py_forward 未产出结果文件 ${outPath}`);
    }
    return JSON.parse(readFileSync(outPath, 'utf8')) as unknown;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** F1 前向一致：TS f64 重算 vs Python f64 softmax，逐元素 max|Δ| < 1e-6。 */
export function runF1(ctx: GateContext): GateResult {
  const fx = readFixture('f1_forward.json');
  const obsDim = fx['obsDim'];
  const actDim = fx['actDim'];
  if (typeof obsDim !== 'number' || typeof actDim !== 'number') {
    throw new Error('F1: fixture 缺 obsDim/actDim');
  }
  const w = subsetOf(fx['weights'], obsDim, actDim, 'F1');
  const groups = fx['groups'];
  if (!Array.isArray(groups) || groups.length === 0) throw new Error('F1: fixture 缺 groups 列表');
  const pyOut = runPy('f1', fixturePath('f1_forward.json'));
  if (!Array.isArray(pyOut) || pyOut.length !== groups.length) {
    throw new Error(`F1: Python 输出 ${String(Array.isArray(pyOut) ? pyOut.length : '非数组')} 组与 fixture ${String(groups.length)} 组不符`);
  }
  let maxAbsDiff = 0;
  let elements = 0;
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k] as Record<string, unknown>;
    const obs = denseOf(g['obs'], obsDim, `F1#${String(k)}/obs`);
    const acts = actsOf(g['candidates_act_feats'], actDim, `F1#${String(k)}/acts`);
    const pTs = forward64(w, obs, acts);
    const row = pyOut[k] as { scores?: unknown };
    const pPy = row['scores'];
    if (!Array.isArray(pPy) || pPy.length !== pTs.length) {
      throw new Error(`F1#${String(k)}: Python scores 长度 ${String(Array.isArray(pPy) ? pPy.length : '缺')} 与 TS ${String(pTs.length)} 不符`);
    }
    for (let i = 0; i < pTs.length; i++) {
      const vPy = Number(pPy[i]);
      if (!Number.isFinite(vPy)) throw new Error(`F1#${String(k)}: Python scores[${String(i)}] 非有限数`);
      const d = Math.abs(pTs[i]! - vPy);
      if (d > maxAbsDiff) maxAbsDiff = d;
      elements += 1;
    }
  }
  return buildResult({
    gate: gateId('F1'),
    version: VERSION,
    ctx,
    seeds: [],
    metrics: { max_abs_diff: maxAbsDiff, n_groups: groups.length, tol: 1e-6 },
    thresholds: { 'max_abs_diff:max': 1e-6, 'n_groups:min': 1 },
    notes:
      maxAbsDiff < 1e-6
        ? `TS f64 重算 vs Python f64 softmax：${String(groups.length)} 组 ${String(elements)} 元素逐项比对，max|Δ|=${maxAbsDiff.toExponential(3)}（门槛 1e-6）`
        : `失败模式：max|Δ|=${maxAbsDiff.toExponential(3)} ≥ 1e-6（${String(groups.length)} 组 ${String(elements)} 元素）`,
  });
}

/** F2 往返一致：TS Policy.actFromObs vs Python greedy，action 一致率 100%。 */
export function runF2(ctx: GateContext): GateResult {
  const fx = readFixture('f2_roundtrip.json');
  const obsDim = fx['obsDim'];
  const actDim = fx['actDim'];
  if (typeof obsDim !== 'number' || typeof actDim !== 'number') {
    throw new Error('F2: fixture 缺 obsDim/actDim');
  }
  const w = resolveWeights(fx, obsDim, actDim);
  const arch = fx['arch'];
  if (typeof arch !== 'string') throw new Error('F2: fixture 缺 arch');
  const parts = arch.split(':');
  const featureSet = parts[1] as FeatureSet;
  const head = parts[5] as HeadTag;
  if (featureSet !== 'lang' && featureSet !== 'struct' && featureSet !== 'hash_only') {
    throw new Error(`F2: arch 特征集 ${featureSet} 非法`);
  }
  if (head !== 'progress' && head !== 'none') throw new Error(`F2: arch head ${head} 非法`);
  if (head !== 'none') {
    throw new Error('F2: 本门禁只支持 head=none 的权重子集 fixture（wp/bp 不在跨语言契约内）');
  }
  const policy = new Policy({ ...w, wp: { shape: [0], data: [] }, bp: { shape: [0], data: [] } }, featureSet, head);
  const tasks = fx['tasks'];
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('F2: fixture 缺 tasks 列表');
  const pyOut = runPy('f2', fixturePath('f2_roundtrip.json'));
  if (!Array.isArray(pyOut) || pyOut.length !== tasks.length) {
    throw new Error(`F2: Python 输出 ${String(Array.isArray(pyOut) ? pyOut.length : '非数组')} 条与 fixture ${String(tasks.length)} 条不符`);
  }
  let match = 0;
  let tieCount = 0;
  for (let k = 0; k < tasks.length; k++) {
    const t = tasks[k] as Record<string, unknown>;
    const obs64 = denseOf(t['obs_vec'], obsDim, `F2#${String(k)}/obs`);
    const acts = actsOf(t['candidates_act_feats'], actDim, `F2#${String(k)}/acts`);
    const tsIdx = policy.actFromObs(Float32Array.from(obs64), acts.map((a) => Float32Array.from(a)));
    const { i1, i2, v1, v2 } = topTwo(forward64(w, obs64, acts));
    const tied = v1 - v2 < TIE_WINDOW;
    const tsAction = tied ? Math.min(i1, i2) : tsIdx;
    const row = pyOut[k] as { action_idx?: unknown; tied?: unknown };
    if (typeof row['action_idx'] !== 'number' || !Number.isInteger(row['action_idx'])) {
      throw new Error(`F2#${String(k)}: Python 输出 action_idx 缺失或非法`);
    }
    if (row['tied'] === true) tieCount += 1;
    if (tsAction === row['action_idx']) match += 1;
  }
  const agreeRate = match / tasks.length;
  return buildResult({
    gate: gateId('F2'),
    version: VERSION,
    ctx,
    seeds: [],
    metrics: { match, total: tasks.length, agree_rate: agreeRate, tie_count: tieCount },
    thresholds: { 'agree_rate:eq': 1, 'total:min': 1 },
    notes:
      agreeRate === 1
        ? `TS Policy.actFromObs vs Python greedy：${String(match)}/${String(tasks.length)} 一致（并列 ${String(tieCount)} 条，窗口 1e-4 取小下标）`
        : `失败模式：${String(match)}/${String(tasks.length)} 一致（agree_rate=${agreeRate.toFixed(4)}），非并列分歧不允许`,
  });
}

/** F3 特征单源：训练器与 conformance 入口源码 banned 标识符零容忍；extra 可注入。 */
export function runF3(ctx: GateContext, extra?: readonly F3File[]): GateResult {
  const files: F3File[] = F3_DEFAULT_PATHS.map((p) => ({
    path: p,
    content: readFileSync(join(PKG_ROOT, p), 'utf8'),
  }));
  if (extra !== undefined) files.push(...extra);
  let hits = 0;
  for (const f of files) {
    for (const term of BANNED_IDENTIFIERS) {
      let from = 0;
      for (;;) {
        const at = f.content.indexOf(term, from);
        if (at < 0) break;
        hits += 1;
        from = at + term.length;
      }
    }
  }
  const ok = hits === 0;
  return buildResult({
    gate: gateId('F3'),
    version: VERSION,
    ctx,
    seeds: [],
    metrics: { banned_hits: hits, files_scanned: files.length, banned_list_len: BANNED_IDENTIFIERS.length },
    thresholds: { 'banned_hits:eq': 0, 'files_scanned:min': 1 },
    notes: ok
      ? `扫描 ${String(files.length)} 个文件（含 ${String(extra?.length ?? 0)} 个注入）零命中（banned 清单 ${String(BANNED_IDENTIFIERS.length)} 项）`
      : `失败模式：${String(hits)} 处 banned 标识符命中（清单 ${String(BANNED_IDENTIFIERS.length)} 项，${String(files.length)} 个文件，注释命中同样违规）`,
  });
}

/** F4 规范序列化自检：canonicalJson/hashObj 与冻结期望逐字一致，且两次哈希恒定。 */
export function runF4(ctx: GateContext): GateResult {
  const fx = readFixture('f4_expected.json');
  const cases = fx['cases'];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('F4: 冻结期望 fixture 缺 cases');
  const byLabel = new Map<string, { json: string; hash: string }>();
  for (const c of cases as { label?: unknown; json?: unknown; hash?: unknown }[]) {
    if (typeof c['label'] !== 'string' || typeof c['json'] !== 'string' || typeof c['hash'] !== 'string') {
      throw new Error('F4: 冻结期望条目缺 label/json/hash');
    }
    byLabel.set(c['label'], { json: c['json'], hash: c['hash'] });
  }
  let allStable = 1;
  for (const c of F4_CASES) {
    const expected = byLabel.get(c.label);
    const h1 = hashObj(c.value);
    const h2 = hashObj(c.value);
    if (expected === undefined || canonicalJson(c.value) !== expected.json || h1 !== expected.hash || h1 !== h2) {
      allStable = 0;
    }
  }
  return buildResult({
    gate: gateId('F4'),
    version: VERSION,
    ctx,
    seeds: [],
    metrics: { cases_checked: F4_CASES.length, all_stable: allStable },
    thresholds: { 'all_stable:eq': 1, 'cases_checked:min': 1 },
    notes:
      allStable === 1
        ? `${String(F4_CASES.length)} 例 canonicalJson/hashObj 与 f4_expected.json 逐字一致，且同对象两次 hashObj 恒定（0.1/1e-7/1 vs 1.0/-0.0/CJK/嵌套）`
        : '失败模式：存在 canonicalJson 或 hashObj 与冻结期望不一致、或两次哈希不恒定的用例',
  });
}
