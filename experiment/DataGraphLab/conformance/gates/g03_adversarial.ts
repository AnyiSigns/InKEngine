/**
 * G0.3 验收抗投喂（docs/gates.md G0.3）：直接调用 `verify/adversarial.ts` 的
 * `runAll()`——静态必拒清单（空值/类型对语义错/旧 verdict 复活/复述原题/硬编码
 * 常量）+ 固定 seed fuzz 错误产物全拒，同时用正确通道产物确认验收可被喂饱，
 * 两头都判死（reject_ratio==1 且 accept_correct_ratio==1）防「全拒通关」假绿。
 * 判定逻辑唯一真源在 adversarial 套件里，本门禁只做指标搬运，不另写一份判定。
 */

import { FUZZ_COUNT, runAll as adversarialRunAll, WRONG_ARTIFACTS } from '../../verify/adversarial.js';
import { buildResult, memoized, type GateContext, type GateResult } from './common.js';

const VERSION = 1;

function compute(ctx: GateContext): GateResult {
  const r = adversarialRunAll();
  const staticWrong = WRONG_ARTIFACTS.length;
  return buildResult({
    gate: 'G0.3',
    version: VERSION,
    ctx,
    seeds: [0x5eed00],
    metrics: {
      reject_ratio: r.rejectRatio,
      accept_correct_ratio: r.acceptCorrectRatio,
      case_count: r.caseCount,
      wrong_static_count: staticWrong,
      fuzz_count: FUZZ_COUNT,
    },
    thresholds: {
      'reject_ratio:eq': 1,
      'accept_correct_ratio:eq': 1,
      'case_count:eq': staticWrong + FUZZ_COUNT,
      'wrong_static_count:min': 1,
      'fuzz_count:min': 1,
    },
    notes:
      r.rejectRatio === 1 && r.acceptCorrectRatio === 1
        ? `错误产物（静态 ${String(staticWrong)} + fuzz ${String(FUZZ_COUNT)}）全拒，正确通道全收`
        : `失败模式：reject_ratio=${String(r.rejectRatio)}、accept_correct_ratio=${String(r.acceptCorrectRatio)}——前者<1 说明有错误喂招穿验收，后者<1 说明验收可被饿死`,
  });
}

/** 公开入口：同一上下文只算一次（结果不可变，见 common.memoized）。 */
export function run(ctx: GateContext): GateResult {
  return memoized('G0.3', ctx, () => compute(ctx));
}
