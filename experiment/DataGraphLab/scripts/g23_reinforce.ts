/**
 * G2.3 REINFORCE 同预算对照（Phase 2 搜证，§10 G2.3 行）：白手起家随机初始化策略、
 * 单遍采样（budgetSteps = BC N×8 口径，§7）→ reinforce.bin → train.py --loss reinforce
 * → held-out 评测；与 BC trained 同预算对照。
 *
 * 预注册解读（§10 G2.3 行）：同预算样本效率对照，稀疏终局奖励下 RL 不及密集监督 BC，
 * 赢/输均按效率报告，禁止升格为路线裁决（§0 关于真实域信号稀疏/信用分配，不因本
 * 玩具域结果存废）。
 *
 * 注：train_reinforce.py 用严格 parse_args、不收 --val/--save-last-k，故不走 runTrainer，
 * 直接 spawn（与 tests/reinforce.test.ts 同构）。输出全 ASCII 防控制台乱码。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PKG_ROOT,
  defaultTrainerPath,
  sampleTasks,
  skeletonPool,
  stamp,
} from '../eval/scale_pipes.js';
import { makeSplit } from '../gen/generator.js';
import { Policy } from '../controller/policy.js';
import { ReinforceArm, collectReinforceRows, writeReinforceFile } from '../eval/reinforce.js';
import { evaluateArm } from '../eval/arms.js';
import { GRAPH } from '../runner/graph.js';

const N = 10000;
const budgetSteps = N * 8; // BC 总步数口径（§7 注册）
const runDir = join(PKG_ROOT, 'runs', `phase2-g23-${stamp()}`);
mkdirSync(runDir, { recursive: true });

// 复用 a1-full 的 val.bin（同切分、同 arch v6）
const valBin = join(PKG_ROOT, 'runs', 'scale-20260915T00-a1-full', 'val.bin');
if (!existsSync(valBin)) throw new Error(`缺 val.bin: ${valBin}（先跑 a1_full）`);

// —— 1. 白手起家 REINFORCE 采集（随机策略、预算封顶）——
const trainPool = skeletonPool('train');
const collectTasks = sampleTasks(20000, 4242, trainPool, 0.5); // 充足任务供预算封顶
const rp = Policy.random(0, 'lang', 'none');
const collected = collectReinforceRows(rp, collectTasks, { seed: 0, budgetSteps });
const rfBin = join(runDir, 'reinforce.bin');
writeReinforceFile(rfBin, collected.rows, 'lang');
console.log(
  `[collect] rollouts=${collected.rollouts} envSteps=${collected.steps} solved=${collected.solved} ` +
    `meanReward=${collected.meanReward.toFixed(4)} rows=${collected.rows.length} budget=${budgetSteps}`,
);

// —— 2. train.py --loss reinforce（直接 spawn：不收 --val/--save-last-k）——
const rfWeights = join(runDir, 'reinforce_weights.json');
const py = defaultTrainerPath();
const trainPy = join(PKG_ROOT, 'controller', 'train.py');
const argv = [
  trainPy, '--loss', 'reinforce', '--train', rfBin, '--out', rfWeights,
  '--seed', '0', '--epochs', '5',
];
const res = spawnSync(py, argv, { cwd: PKG_ROOT, encoding: 'utf-8' });
if (res.status !== 0) {
  throw new Error(`reinforce train 退出码 ${String(res.status)}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
}
console.log(`[train] ${res.stdout.trim()}`);

// —— 3. held-out 评测（同 a1-full 统计集 600/600）——
const statTasks = makeSplit('heldout', 300, 0);
const rfPolicy = Policy.load(rfWeights);
const rfArm = new ReinforceArm(rfPolicy);
const followRep = evaluateArm(rfArm, statTasks, GRAPH, 'follow');
const goalRep = evaluateArm(rfArm, statTasks, GRAPH, 'goal');

// BC 对照数（a1-full results.json，10k s0）
const a1 = JSON.parse(
  readFileSync(join(PKG_ROOT, 'runs', 'scale-20260915T00-a1-full', 'results.json'), 'utf8'),
);
const bc = (style: string, metric: string): number =>
  a1.rows.find((r: any) => r.N === 10000 && r.seed === 0 && r.style === style && r.arm === 'trained' && r.metric === metric).value;

const report = {
  g23_reinforce: {
    budget_steps: budgetSteps,
    collected: {
      rollouts: collected.rollouts,
      env_steps: collected.steps,
      solved: collected.solved,
      mean_reward: collected.meanReward,
      rows: collected.rows.length,
    },
    reinforce: { follow_pass1: followRep.passRate, goal_pass1: goalRep.passRate, n: followRep.total },
    bc_trained_s0_10k: { follow_pass1: bc('follow', 'pass1'), goal_pass1: bc('goal', 'pass1') },
    interpretation:
      'same-budget sample-efficiency comparison; sparse terminal reward -> RL < dense-supervision BC; not a route verdict (plan G2.3 row)',
  },
  runDir,
};
writeFileSync(join(runDir, 'g23_report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(
  `G23_DONE follow: reinforce=${followRep.passRate.toFixed(4)} vs bc=${bc('follow', 'pass1').toFixed(4)} | ` +
    `goal: reinforce=${goalRep.passRate.toFixed(4)} vs bc=${bc('goal', 'pass1').toFixed(4)} | ${runDir}`,
);
