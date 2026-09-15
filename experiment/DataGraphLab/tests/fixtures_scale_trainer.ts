/**
 * scaling 测试公共夹具：fake 训练器（.py 桩）与两份手工权重。
 *
 * 桩脚本读 argv 的 `--out`，写出最小合法 weights.json（arch/dims 与
 * controller/checkpoint.ts 的 currentArch 逐字同构）：snapshot0 = 全零权重
 * （h=0 → 分数并列取最小下标 → 永不选 submit/check，answer 恒 null → 真实
 * held-out 任务上 pass@1 恒 0 的确定性下界），snapshot1 = 「先 submit 两拍、
 * submit 触顶后走 exit」的偏好权重（构造目标族单测题可解、真实任务上因
 * answer=x≠expected 亦近 0），最终 params = 全零。选点逻辑因此可在真实小
 * val 上确定性断言（并列取更晚候选）。TS 侧同样导出的 pZero/pSolve 供
 * selectCheckpoint 单元测试直接构造 WeightsFile。位索引以字面量烘进桩内，
 * 桩运行期零推导。
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACT_DIM, E_OFF, K_OFF, KIND_LIST, OBS_DIM } from '../controller/features.js';
import { H } from '../controller/policy.js';
import { crc32 } from '../world/hash.js';
import type { PolicyWeights } from '../controller/policy.js';

export const OBS = OBS_DIM.lang;

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0);
}

export function pZeroParams(): PolicyWeights {
  return {
    wo: { shape: [H, OBS], data: zeros(H * OBS) },
    bo: { shape: [H], data: zeros(H) },
    wa: { shape: [H, ACT_DIM], data: zeros(H * ACT_DIM) },
    ba: { shape: [H], data: zeros(H) },
    ws: { shape: [H], data: zeros(H) },
    wp: { shape: [H], data: zeros(H) },
    bp: { shape: [1], data: zeros(1) },
  };
}

/** submit 偏好位 + exit 次偏好位：`submit, submit, exit` 三步收口构造目标题。 */
export function pSolveParams(): PolicyWeights {
  const base = pZeroParams();
  const bo = zeros(H);
  bo[0] = 3;
  bo[1] = 3;
  const wa = zeros(H * ACT_DIM);
  wa[0 * ACT_DIM + (E_OFF + crc32('submit') % 64)] = 8;
  wa[1 * ACT_DIM + (K_OFF + KIND_LIST.indexOf('exit'))] = 3;
  const ws = zeros(H);
  ws[0] = 1;
  ws[1] = 1;
  return {
    wo: base.wo,
    bo: { shape: [H], data: bo },
    wa: { shape: [H, ACT_DIM], data: wa },
    ba: base.ba,
    ws: { shape: [H], data: ws },
    wp: base.wp,
    bp: base.bp,
  };
}

/** 生成 fake trainer 桩（落到 dir，返回 .py 路径；调用方自清理临时目录）。 */
export function writeFakeTrainer(dir: string): string {
  const submitBit = E_OFF + crc32('submit') % 64;
  const exitBit = K_OFF + KIND_LIST.indexOf('exit');
  const src = `# -*- coding: utf-8 -*-
"""fake 训练器桩：写出最小合法 weights.json（两份手工快照 + 全零终点参数）。"""
import argparse, json

H, OBS, ACT = ${H}, ${OBS}, ${ACT_DIM}

def tensor(shape):
    n = 1
    for d in shape:
        n *= d
    return {"shape": shape, "data": [0.0] * n}

def zeros(n):
    return [0.0] * n

def p_zero():
    return {"wo": tensor([H, OBS]), "bo": tensor([H]), "wa": tensor([H, ACT]),
            "ba": tensor([H]), "ws": tensor([H]), "wp": tensor([H]), "bp": tensor([1])}

def p_solve():
    bo = zeros(H); bo[0] = 3.0; bo[1] = 3.0
    wa = zeros(H * ACT); wa[0 * ACT + ${submitBit}] = 8.0; wa[1 * ACT + ${exitBit}] = 3.0
    ws = zeros(H); ws[0] = 1.0; ws[1] = 1.0
    return {"wo": tensor([H, OBS]), "bo": {"shape": [H], "data": bo},
            "wa": {"shape": [H, ACT], "data": wa}, "ba": tensor([H]),
            "ws": {"shape": [H], "data": ws}, "wp": tensor([H]), "bp": tensor([1])}

ap = argparse.ArgumentParser()
ap.add_argument("--train")
ap.add_argument("--val")
ap.add_argument("--out")
ap.add_argument("--save-last-k", type=int, dest="save_last_k")
args, _rest = ap.parse_known_args()
doc = {"arch": "v6:lang:" + str(OBS) + ":" + str(ACT) + ":" + str(H) + ":progress",
       "dims": {"featureSet": "lang", "obsDim": OBS, "actDim": ACT, "h": H, "head": "progress"},
       "params": p_zero(),
       "train_meta": {"records_bin_sha256": "0", "code_hash": "0", "seed": 0, "batch": 512,
                      "epochs_run": 2, "final_val_ce": 0.7, "best_epoch": 0,
                      "epoch_snapshots": [{"epoch": 0, "val_ce": 0.9, "params": p_zero()},
                                          {"epoch": 1, "val_ce": 0.8, "params": p_solve()}]}}
with open(args.out, "w", encoding="utf-8") as f:
    json.dump(doc, f)
print("fake-trainer " + args.out)
`;
  const path = join(dir, 'fake_trainer.py');
  writeFileSync(path, src, 'utf8');
  return path;
}
