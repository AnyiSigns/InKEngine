/**
 * data/records 派生缓存测试：F.2 v2 逐字段契约 + 稀疏编码纪律（featurize 形状、22 位 ROUTING 掩码、
 * 动作表、bin 往返与 magic/version/截断/NaN/枚举值域 fail-fast）、P1-D struct 拒收与行宽不变量、
 * reinforce.bin 越界拦截、进度分组口径、CLI 冒烟、公开字段白名单审计。真实记录落临时 store
 * 再 load 回（顺带 JSONL 往返），产物落系统临时目录、afterEach 清理。
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  actionFeatureTable, featurizeRecord, featurizeRecords, parseArgs, readRecordsBin, writeRecordsBin, type BinRow,
} from '../data/records.js';
import { readReinforceBin, writeReinforceBin, type ReinforceRow } from '../data/reinforce_bin.js';
import { append, load, recordFromStep, type StoreRecord } from '../data/store.js';
import { ACT_DIM, OBS_DIM, featurizeAction, featurizeObs } from '../controller/features.js';
import { GRAPH, MAX_STEPS } from '../runner/graph.js';
import { oracleTrace } from '../teacher/oracle.js';
import { makeTask } from '../gen/generator.js';
import { EXIT, ROUTING } from '../world/operators.js';
import type { Task } from '../schema.js';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dgl-records-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

const FAM_CODE: Readonly<Record<string, 0 | 1 | 2 | 3>> = { value: 0, verify: 1, goal: 2, goal_verify: 3 };

function pool(style: 'follow' | 'goal', seeds: readonly number[]): Task[] {
  const out: Task[] = [];
  for (const seed of seeds) {
    const t = makeTask(seed, style, undefined, 'train');
    if (t !== null) out.push(t);
  }
  return out;
}

/** 若干真实任务 → oracle 逐步原始记录（内容寻址写侧前的形状）。 */
function oracleRecords(): StoreRecord[] {
  const tasks = [...pool('follow', [1, 2]), ...pool('goal', [31, 7])];
  const out: StoreRecord[] = [];
  for (const t of tasks) for (const step of oracleTrace(t, GRAPH)) out.push(recordFromStep(t, step));
  return out;
}

/** 落临时 store 再 load 回（顺带走一遍 JSONL 往返后的记录面）。 */
function loadedRecords(): StoreRecord[] {
  const root = tmpRoot();
  append(oracleRecords(), { outRoot: root });
  return load('train', { outRoot: root });
}

function popcount(u32: number): number {
  let x = u32 >>> 0;
  let c = 0;
  while (x !== 0) { c += x & 1; x >>>= 1; }
  return c;
}

/** v2 口径：候选 id → ROUTING 位序的全局位掩码，独立于被测实现重算一遍。 */
function globalMask(candidates: readonly string[]): number {
  let mask = 0;
  for (const nid of candidates) mask |= 1 << ROUTING.indexOf(nid);
  return mask >>> 0;
}

describe('data/records/featurizeRecords：稀疏形状与逐字段语义', () => {
  const back = loadedRecords();
  const rows = featurizeRecords(back);

  it('行数与记录数一致，且非平凡（覆盖多任务/多步）', () => {
    expect(rows.length).toBe(back.length);
    expect(rows.length).toBeGreaterThan(3);
  });

  it('idx 严格升序且 < 65536，val 与 featurizeObs 非零项逐位一致', () => {
    for (let i = 0; i < back.length; i++) {
      const rec = back[i]!;
      const row = rows[i]!;
      expect(row.idx.length).toBe(row.val.length);
      for (let k = 0; k < row.idx.length; k++) {
        if (k > 0) expect(row.idx[k]!).toBeGreaterThan(row.idx[k - 1]!);
        expect(row.idx[k]!).toBeLessThan(65536);
      }
      const dense = featurizeObs(rec.instruction,
        { x: rec.x, answer: rec.state.answer, verdict: rec.state.verdict, hist: [...rec.hist] });
      const nzIdx: number[] = []; const nzVal: number[] = [];
      for (let j = 0; j < dense.length; j++) {
        if (dense[j] !== 0) { nzIdx.push(j); nzVal.push(dense[j]!); }
      }
      expect(Array.from(row.idx)).toEqual(nzIdx);
      expect(Array.from(row.val)).toEqual(nzVal);
    }
  });

  it('candMask=22 位全局 ROUTING 掩码；第 targetIdx 个置位 ↔ target；手算对照', () => {
    for (let i = 0; i < back.length; i++) {
      const rec = back[i]!;
      const row = rows[i]!;
      expect(row.candMask).toBe(globalMask(rec.candidates));
      expect(popcount(row.candMask)).toBe(rec.candidates.length);
      const bits: number[] = [];
      for (let j = 0; j < ROUTING.length; j++) if (row.candMask & (1 << j)) bits.push(j);
      expect(ROUTING[bits[row.targetIdx]!]).toBe(rec.target);
    }
    // 手算对照：ROUTING[0]=add3、ROUTING[9]=exit、ROUTING[13]=mul2 → 1|512|8192=8705。
    const rec = back[0]!;
    const probe = featurizeRecord({ ...rec, candidates: ['add3', 'exit', 'mul2'], target: 'exit' });
    expect(probe.candMask).toBe(8705);
    expect(probe.targetIdx).toBe(1);
  });

  it('style/family 编码与记录值域一致', () => {
    for (let i = 0; i < back.length; i++) {
      expect(rows[i]!.style).toBe(back[i]!.style === 'goal' ? 1 : 0);
      expect(rows[i]!.family).toBe(FAM_CODE[back[i]!.family]!);
    }
  });

  it('progressLabel 终行=0、首行=(末步−0)/MAX_STEPS；完整轨迹 weight=1', () => {
    const maxStep = new Map<string, number>();
    for (const rec of back) {
      const th = rec.meta.task_hash as string;
      const si = rec.meta.step_index as number;
      if ((maxStep.get(th) ?? -Infinity) < si) maxStep.set(th, si);
    }
    const seen = new Set<string>();
    for (const row of rows) {
      const expected = (maxStep.get(row.taskHash)! - row.stepIndex) / MAX_STEPS;
      expect(row.progressLabel).toBeCloseTo(expected, 10);
      expect(row.progressWeight).toBe(1); // oracle 轨迹末步恒为 EXIT → 完整
      if (!seen.has(row.taskHash)) seen.add(row.taskHash);
      if (row.stepIndex === maxStep.get(row.taskHash)) expect(row.progressLabel).toBeCloseTo(0, 10);
      if (row.stepIndex === 0) expect(row.progressLabel).toBeCloseTo(maxStep.get(row.taskHash)! / MAX_STEPS, 10);
    }
  });

  it('剔除某组 EXIT 行后该组 weight=0（不完整轨迹不进进度回归），其余组仍=1', () => {
    const th0 = rows[0]!.taskHash;
    const partial = back.filter((r) => !(r.meta.task_hash === th0 && r.target === EXIT));
    const pr = featurizeRecords(partial);
    expect(pr.some((r) => r.taskHash === th0)).toBe(true);
    for (const r of pr) expect(r.progressWeight).toBe(r.taskHash === th0 ? 0 : 1);
  });
});

describe('data/records/二进制往返与外部边界 fail-fast', () => {
  const back = loadedRecords();
  const rows = featurizeRecords(back);

  it('writeRecordsBin → readRecordsBin 逐字段回读一致；actFeats 与 featurizeAction 重算逐位一致', () => {
    const bin = join(tmpRoot(), 'records.bin');
    writeRecordsBin(bin, rows, OBS_DIM.lang, actionFeatureTable());
    const parsed = readRecordsBin(bin);
    expect(parsed.obsDim).toBe(OBS_DIM.lang);
    expect(parsed.actDim).toBe(ACT_DIM);
    expect(parsed.actFeats.length).toBe(ROUTING.length);
    for (let j = 0; j < ROUTING.length; j++) {
      expect(Array.from(parsed.actFeats[j]!)).toEqual(Array.from(featurizeAction(GRAPH, ROUTING[j]!)));
    }
    expect(parsed.rows.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const a = rows[i]!;
      const b = parsed.rows[i]!;
      expect(b.style).toBe(a.style);
      expect(b.family).toBe(a.family);
      expect(b.taskHash).toBe(a.taskHash);
      expect(b.stepIndex).toBe(a.stepIndex);
      expect(b.candMask).toBe(a.candMask);
      expect(b.targetIdx).toBe(a.targetIdx);
      expect(b.progressWeight).toBe(a.progressWeight);
      expect(Array.from(b.idx)).toEqual(Array.from(a.idx));
      expect(Array.from(b.val)).toEqual(Array.from(a.val));
      expect(b.progressLabel).toBe(Math.fround(a.progressLabel)); // f32 精度内一致
    }
  });

  it('magic 破坏 / version=1 旧版手工文件 / 文件截断 → read 全抛', () => {
    const root = tmpRoot();
    const bin = join(root, 'r.bin');
    writeRecordsBin(bin, rows, OBS_DIM.lang, actionFeatureTable());
    const good = readFileSync(bin);

    const badMagic = Buffer.from(good);
    badMagic[0] = 'X'.charCodeAt(0);
    const pMagic = join(root, 'magic.bin');
    appendFileSync(pMagic, badMagic);
    expect(() => readRecordsBin(pMagic)).toThrow(/magic/);

    const oldVersion = Buffer.from(good);
    oldVersion.writeUInt32LE(1, 4); // 手工把版本段写回 v1：必须拒读并提示重跑 featurize
    const pVer = join(root, 'ver.bin');
    appendFileSync(pVer, oldVersion);
    expect(() => readRecordsBin(pVer)).toThrow(/version=1.*重跑 featurize/);

    const pTrunc = join(root, 'trunc.bin');
    appendFileSync(pTrunc, good.subarray(0, good.length - 1));
    expect(() => readRecordsBin(pTrunc)).toThrow(/截断|短于/);
  });

  it('同一批记录 featurize+写盘两次字节逐位相同（确定性）', () => {
    const root = tmpRoot();
    const a = join(root, 'a.bin');
    const b = join(root, 'b.bin');
    writeRecordsBin(a, featurizeRecords(back), OBS_DIM.lang, actionFeatureTable());
    writeRecordsBin(b, featurizeRecords(back), OBS_DIM.lang, actionFeatureTable());
    expect(Buffer.compare(readFileSync(a), readFileSync(b))).toBe(0);
  });
});

describe('data/records/fail-fast 边界', () => {
  const back = loadedRecords();

  it('target 不在 candidates → featurizeRecord 抛', () => {
    const rec = back[0]!;
    expect(() => featurizeRecord({ ...rec, target: '__nope__' })).toThrow(/candidates|target/);
  });

  it('候选非 ROUTING 成员 / 候选重复 → 抛（v2 位掩码不变式）', () => {
    const rec = back[0]!;
    expect(() => featurizeRecord({ ...rec, candidates: ['add3', 'cand_x'], target: 'add3' })).toThrow(/cand_x|ROUTING/);
    expect(() => featurizeRecord({ ...rec, candidates: ['add3', 'add3'], target: 'add3' })).toThrow(/重复/);
  });

  it('稀疏值注入 NaN → writeRecordsBin 抛（数值入口判 NaN/Inf）', () => {
    const bin = join(tmpRoot(), 'nan.bin');
    const bad: BinRow = {
      style: 0, family: 0, taskHash: 'h', stepIndex: 0,
      idx: Uint16Array.from([0, 1]), val: Float32Array.from([1, Number.NaN]),
      candMask: 3, targetIdx: 0, progressLabel: 0, progressWeight: 0,
    };
    expect(() => writeRecordsBin(bin, [bad], OBS_DIM.lang, actionFeatureTable())).toThrow(/NaN|非有限/);
    expect(existsSync(bin)).toBe(false);
  });
});

describe('data/records/featurize CLI 冒烟（真实 tsx 子进程）', () => {
  it('--split train --out <tmp> 退出码 0 且 stdout 打印统计行、bin 可读回', () => {
    const root = tmpRoot();
    const seeded = oracleRecords();
    append(seeded, { outRoot: root });
    const bin = join(root, 'cli.bin');
    const r = spawnSync(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('data', 'records.ts'),
        '--split', 'train', '--out', bin, '--out-root', root, '--limit', '1'],
      { cwd: PKG_ROOT, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^records: \d+ rows -> .+ \(obsDim=867\)\s*$/m);
    expect(existsSync(bin)).toBe(true);
    const parsed = readRecordsBin(bin);
    expect(parsed.obsDim).toBe(867);
    expect(parsed.actFeats.length).toBe(22);
    expect(parsed.rows.length).toBe(1);
    expect(seeded.length).toBeGreaterThan(1); // 数据确曾落盘（--limit 只截不造）
  });

  it('非法参数与无参数 → 退出码 1 并打印用法', () => {
    const cli = (args: readonly string[]) => spawnSync(process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('data', 'records.ts'), ...args],
      { cwd: PKG_ROOT, encoding: 'utf8' });
    const bad = cli(['--split', 'nope', '--out', join(tmpRoot(), 'x.bin')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/用法/);
    const empty = cli([]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/用法/);
  });
});

describe('data/records/白名单审计：只依赖公开字段', () => {
  it('替换 meta（除 task_hash/step_index）不影响 idx/val/candMask/targetIdx', () => {
    const rec = loadedRecords()[0]!;
    const a = featurizeRecord(rec);
    const perturbed: StoreRecord = {
      ...rec,
      meta: {
        task_hash: rec.meta.task_hash,
        step_index: rec.meta.step_index,
        composition_id: '完全不同',
        plan_hash: '完全不同',
        split: 'heldout',
        teacher: 'llm',
        world_version: 'v-other',
        c_hash: 'deadbeefdeadbeef',
        额外隐藏量: { expected: 999, spec: { goal: { kind: 'gt' } }, plan_hidden: ['secret'] },
      },
    };
    const b = featurizeRecord(perturbed);
    expect(Array.from(b.idx)).toEqual(Array.from(a.idx));
    expect(Array.from(b.val)).toEqual(Array.from(a.val));
    expect(b.candMask).toBe(a.candMask);
    expect(b.targetIdx).toBe(a.targetIdx);
    expect(b.style).toBe(a.style);
    expect(b.family).toBe(a.family);
  });
});

describe('data/records/P1-D·P3：struct 拒收、行宽不变量与 bin 越界/枚举 fail-fast', () => {
  const rec0 = loadedRecords()[0]!;
  it('parseArgs 即拒 --feature-set struct（其余特征集照常放行），库口直传 struct 被行宽不变量拦截', () => {
    expect(() => parseArgs(['--split', 'train', '--out', 'x.bin', '--feature-set', 'struct'])).toThrow(/不进 records\.bin/);
    expect(parseArgs(['--split', 'train', '--out', 'x.bin', '--feature-set', 'hash_only']).featureSet).toBe('hash_only');
    expect(() => featurizeRecord(rec0, 'struct')).toThrow(/行宽 867 ≠ OBS_DIM 875（宽度不变量/);
  });
  it('records.bin 读侧：style∉{0,1}、family∉{0..3} 坏字节即抛（不带坏标签进训练）', () => {
    const bin = join(tmpRoot(), 'enum.bin');
    writeRecordsBin(bin, featurizeRecords(loadedRecords()), OBS_DIM.lang, actionFeatureTable());
    let start = 24; // header 6×u32；随后每块 4 + nnz×(2+4) 字节
    for (const a of actionFeatureTable()) {
      let nz = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== 0) nz += 1;
      start += 4 + nz * 6;
    }
    for (const [at, val, re] of [[start, 5, /style/], [start + 1, 4, /family/]] as const) {
      const bad = Buffer.from(readFileSync(bin)); bad[at] = val;
      const p = join(tmpRoot(), `bad-${String(at)}.bin`); appendFileSync(p, bad);
      expect(() => readRecordsBin(p), `字节 ${String(at)}=${String(val)}`).toThrow(re);
    }
  });
  it('reinforce.bin 读侧：idx 越 obsDim、actionIdx 越候选宽度即抛（写侧不设值域，读侧挡损坏/手工文件）', () => {
    const mk = (idx: number, actionIdx: number): ReinforceRow => ({
      style: 0, family: 0, taskHash: 'h', stepIndex: 0,
      idx: Uint16Array.from([idx]), val: Float32Array.from([1]),
      candMask: 3, actionIdx, advantage: 0.5, reward: 1,
    });
    for (const [idx, actionIdx, re] of [[9, 0, /obsDim/], [3, 2, /actionIdx/]] as const) {
      const p = join(tmpRoot(), `rf-${String(idx)}-${String(actionIdx)}.bin`);
      writeReinforceBin(p, [mk(idx, actionIdx)], 8, actionFeatureTable());
      expect(() => readReinforceBin(p), `idx=${String(idx)} actionIdx=${String(actionIdx)}`).toThrow(re);
    }
  });
});
