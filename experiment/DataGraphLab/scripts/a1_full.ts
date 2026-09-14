/**
 * A.1 全量复评入口（R7 判定晋级）：grid {1000,10000,30000} × seeds {0..4}，
 * coverageN=1000（C.8 第二跑登记口径），k% 副轴随跑。`--resume` 断点续跑
 * （bin/weights 已存在即跳过构建与训练，复用确定性产物，见 runScale.resume）。
 *
 * 注意：harness 取 runs/ 下**名序最大**的 scale-* 目录作 G1.2 证据（harness.ts
 * findLatestScaleResults），冒烟目录名硬编码为 T12/T22/T23 系；stamp 早于 T23 时
 * 缺省名会排在其后失败，需显式 `--run-id`（如 scale-20260915T00-a1-full）。
 */
import { join } from 'node:path';
import { runScale, writeScaleResults, stamp } from '../eval/scale.js';

const resume = process.argv.includes('--resume');
const runIdArg = process.argv.indexOf('--run-id');
const runId = runIdArg >= 0 ? process.argv[runIdArg + 1]! : `scale-${stamp()}-a1-full`;
const rep = runScale({
  grid: [1000, 10000, 30000],
  seeds: [0, 1, 2, 3, 4],
  outRoot: join(process.cwd(), 'runs'),
  runId,
  coverageN: 1000,
  resume,
});
writeScaleResults(join(rep.runDir, 'results.json'), join(rep.runDir, 'results.csv'), rep);
console.log(`FULL_DONE ${rep.runDir}`);
