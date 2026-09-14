/**
 * 一次性重生成 conformance/ffixtures/{f1_forward,f2_roundtrip}.json（R6 顺序槽
 * obsDim 732→852、arch v1→v2；R7 进度对齐槽 obsDim 852→867、arch v2→v3；
 * R7 复评修正 occurrence 指针语义、arch v3→v4；R7 复评 P0 修复动作哈希桶
 * 同签名类内无碰撞（add3/mod7 分桶）、arch v4→v5）。保留原 fixture 的
 * instruction/obs/candidates 文本，重算 obs_vec / candidates_act_feats /
 * weights（Policy.random 固定 seed）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { featurizeObs, featurizeAction, OBS_DIM } from '../controller/features.js';
import { Policy } from '../controller/policy.js';
import { currentArch } from '../controller/checkpoint.js';
import { GRAPH_BASE } from '../world/operators.js';
import type { ObsView } from '../controller/features.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const F1 = join(HERE, '..', 'conformance', 'ffixtures', 'f1_forward.json');
const F2 = join(HERE, '..', 'conformance', 'ffixtures', 'f2_roundtrip.json');

interface Tensor {
  shape: number[];
  data: number[];
}
interface W4 {
  wo: Tensor; bo: Tensor; wa: Tensor; ba: Tensor; ws: Tensor;
}

function obsOf(o: Record<string, unknown>): ObsView {
  return {
    x: o['x'] ?? null,
    answer: o['answer'] ?? null,
    verdict: o['verdict'] ?? null,
    hist: Array.isArray(o['hist']) ? (o['hist'] as string[]) : [],
  };
}

function denseObs(instr: string, obs: Record<string, unknown>): number[] {
  const v = featurizeObs(instr, obsOf(obs), 'lang');
  return Array.from(v);
}

function sparseObs(instr: string, obs: Record<string, unknown>): { idx: number[]; val: number[] } {
  const v = featurizeObs(instr, obsOf(obs), 'lang');
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== 0) {
      idx.push(i);
      val.push(v[i]!);
    }
  }
  return { idx, val };
}

function actFeats(cands: readonly string[]): number[][] {
  return cands.map((c) => Array.from(featurizeAction(GRAPH_BASE, c)));
}

function pick4(p: Policy): W4 {
  const w = p.params;
  return {
    wo: w.wo, bo: w.bo, wa: w.wa, ba: w.ba, ws: w.ws,
  };
}

const policy = Policy.random(20260914, 'lang', 'none');
const arch = currentArch('lang', 'none');
const obsDim = OBS_DIM.lang;
const actDim = 83;

// —— F1 ——
const f1 = JSON.parse(readFileSync(F1, 'utf8')) as Record<string, unknown>;
const groups = (f1['groups'] as { instruction: string; obs: Record<string, unknown>; candidates: string[]; expected_arch: string }[]).map((g) => ({
  instruction: g.instruction,
  obs: denseObs(g.instruction, g.obs),
  candidates: g.candidates,
  candidates_act_feats: actFeats(g.candidates),
  expected_arch: arch,
}));
const f1Out = {
  fixture: f1['fixture'],
  arch,
  obsDim,
  actDim,
  weights: pick4(policy),
  groups,
};
writeFileSync(F1, `${JSON.stringify(f1Out, null, 2)}\n`, 'utf8');

// —— F2 ——
const f2 = JSON.parse(readFileSync(F2, 'utf8')) as Record<string, unknown>;
const tasks = (f2['tasks'] as { instruction: string; obs: Record<string, unknown>; candidates: string[]; expected_arch: string }[]).map((t) => ({
  instruction: t.instruction,
  obs: t.obs,
  obs_vec: sparseObs(t.instruction, t.obs),
  candidates: t.candidates,
  candidates_act_feats: actFeats(t.candidates),
  expected_arch: arch,
}));
const f2Out = {
  fixture: f2['fixture'],
  arch,
  obsDim,
  actDim,
  weights_path: 'f1_forward.json',
  weights: null,
  tasks,
};
writeFileSync(F2, `${JSON.stringify(f2Out, null, 2)}\n`, 'utf8');

console.log(`rewrote ${F1} / ${F2} (arch=${arch}, obsDim=${obsDim})`);
