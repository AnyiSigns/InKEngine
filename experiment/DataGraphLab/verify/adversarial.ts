/**
 * 必拒错误产物套件（对抗清单）与全量自检 runAll。
 *
 * 生成器与验收器同源会产生共同盲区，因此本套件独立于生成器手构（不依赖骨架
 * 采样），覆盖五类必拒错误产物：空值 answer、类型对但语义错、旧 verdict 复用
 * （R2-P0-1 口径：verdict 是 "pass:"+hash8(被检值) 的指纹承诺——先 check 过 v1
 * 再变换 x 后 submit、或把别的任务算出的指纹搬来做跨任务复用，answer 与指纹
 * 不匹配即拒；合法路径是 submit→check 之间 x 不变，check 之后再变 x 只要不再
 * submit 则 answer 未动、指纹仍成立）、直接复述原题、硬编码常量。硬编码常量
 * 猜中者用双生产者族构造必拒场景——单生产者族的值判定只认 deepEq，猜中不该由
 * 验收器拒（那是 held-out 与超 oracle 统计的职责），双生产者族则缺匹配指纹必拒。
 * runAll 在套件之上用固定 seed 的 makeRng 补刀错误产物，并回放金计划验证正确
 * 通道产物必须全收，防止"全拒通关"的假绿。
 */

import { initState, runPlan, sampleValue, verdictPass } from '../world/operators.js';
import { deepEq } from '../world/types.js';
import { hashObj } from '../world/hash.js';
import { makeRng, type Rng } from '../world/rng.js';
import { accept } from './acceptor.js';
import type { State } from '../world/operators.js';
import type { Goal } from '../world/goal.js';
import type { Task } from '../schema.js';

export interface AdversarialCase {
  readonly label: string;
  readonly task: Task;
  readonly state: State;
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    style: 'follow',
    family: 'value',
    instruction: '起点值4。按顺序做：翻倍',
    x: 4,
    spec: {},
    expected: 8,
    plan_hidden: ['mul2', 'submit'],
    root: 'Int',
    plan_hash: hashObj(['mul2', 'submit']),
    composition_id: 'skel-u2-adv-0',
    split: 'train',
    ...overrides,
  };
}

const VALUE_INT: Task = makeTask({ composition_id: 'adv-value-int' });
const VALUE_STR: Task = makeTask({
  x: 'abc',
  expected: 'ABC',
  instruction: '起点值abc。按顺序做：大写',
  plan_hidden: ['upper', 'submit'],
  plan_hash: hashObj(['upper', 'submit']),
  composition_id: 'adv-value-str',
});
const VERIFY_INT: Task = makeTask({
  family: 'verify',
  instruction: '起点值4。按顺序做：翻倍，再校验偶数',
  spec: { parity: 0 },
  plan_hidden: ['mul2', 'submit', 'check_parity'],
  plan_hash: hashObj(['mul2', 'submit', 'check_parity']),
  composition_id: 'adv-verify-int',
});
const VERIFY_STR: Task = makeTask({
  family: 'verify',
  x: 'abc',
  expected: 'ABC',
  instruction: '起点值abc。按顺序做：大写，再校验长度',
  spec: { length: 3 },
  plan_hidden: ['upper', 'submit', 'check_len'],
  plan_hash: hashObj(['upper', 'submit', 'check_len']),
  composition_id: 'adv-verify-str',
});
const GOAL_INT: Task = makeTask({
  style: 'goal',
  family: 'goal',
  x: 9,
  expected: 24,
  instruction: '结果大于20',
  spec: { goal: { kind: 'gt', target: 20 } },
  plan_hidden: ['add3', 'mul2', 'submit'],
  plan_hash: hashObj(['add3', 'mul2', 'submit']),
  composition_id: 'adv-goal-int',
});
const GOAL_STR: Task = makeTask({
  style: 'goal',
  family: 'goal',
  x: 'ab',
  expected: 'AB',
  instruction: '长度在1到5之间',
  spec: { goal: { kind: 'len', min: 1, max: 5 } },
  plan_hidden: ['upper', 'submit'],
  plan_hash: hashObj(['upper', 'submit']),
  composition_id: 'adv-goal-str',
});
const GOAL_VERIFY_INT: Task = makeTask({
  style: 'goal',
  family: 'goal_verify',
  x: 9,
  expected: 24,
  instruction: '结果大于20',
  spec: { parity: 0, goal: { kind: 'gt', target: 20 } },
  plan_hidden: ['add3', 'mul2', 'submit', 'check_parity'],
  plan_hash: hashObj(['add3', 'mul2', 'submit', 'check_parity']),
  composition_id: 'adv-goal-verify-int',
});
const GOAL_VERIFY_STR: Task = makeTask({
  style: 'goal',
  family: 'goal_verify',
  x: 'abc',
  expected: 'ABC',
  instruction: '长度在1到5之间',
  spec: { length: 3, goal: { kind: 'len', min: 1, max: 5 } },
  plan_hidden: ['upper', 'submit', 'check_len'],
  plan_hash: hashObj(['upper', 'submit', 'check_len']),
  composition_id: 'adv-goal-verify-str',
});

/** 金计划回放得到达标态：构造正确通道产物的基准，也是复活态套件的起点。 */
function replay(task: Task): State {
  return runPlan(task.plan_hidden, initState(task.x, task.spec))!;
}

/** 旧 verdict 复用攻击态：取金计划回放（verdict=pass:{gold answer 指纹}），再篡改 answer。*/
function staleVerdict(task: Task, newAnswer: number | string): State {
  return { ...replay(task), answer: newAnswer };
}

/** 必拒错误产物清单：五类错误各自至少一条，四族全覆盖；两生产者族 verdict 携带被检值指纹。 */
export const WRONG_ARTIFACTS: readonly AdversarialCase[] = [
  // value：单生产者，只认 answer 与 expected 深等
  { label: 'value/空 answer', task: VALUE_INT, state: initState(VALUE_INT.x) },
  { label: 'value/类型对语义错（值不对）', task: VALUE_INT, state: { ...initState(VALUE_INT.x), answer: 9 } },
  { label: 'value/echo 前缀产物', task: VALUE_INT, state: { ...initState(VALUE_INT.x), answer: 'echo:8' } },
  { label: 'value/直接复述原题', task: VALUE_INT, state: { ...initState(VALUE_INT.x), answer: VALUE_INT.instruction } },
  { label: 'value/硬编码常量猜错', task: VALUE_INT, state: { ...initState(VALUE_INT.x), answer: 0 } },
  { label: 'value/Str 语义错', task: VALUE_STR, state: { ...initState(VALUE_STR.x), answer: 'a' } },
  // verify：双生产者，answer 深等 expected 且 verdict 必须是 pass:{hash8(answer)}
  { label: 'verify/空 answer', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), verdict: 'pass' } },
  { label: 'verify/类型对语义错（值不对）', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: 9, verdict: verdictPass(9) } },
  { label: 'verify/verdict 缺失', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: 8 } },
  { label: 'verify/verdict 是裸 "pass" 不带 answer 指纹', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: 8, verdict: 'pass' } },
  { label: 'verify/旧 verdict 复用（复活态：answer 改 7，verdict 仍是 8 的指纹）', task: VERIFY_INT, state: staleVerdict(VERIFY_INT, 7) },
  { label: 'verify/answer 对但 verdict 指纹漂移（9 的指纹配 answer 8）', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: 8, verdict: verdictPass(9) } },
  { label: 'verify/直接复述原题', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: VERIFY_INT.instruction, verdict: 'pass' } },
  { label: 'verify/硬编码常量猜中但 verdict 伪造缺位', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: 8 } },
  { label: 'verify/verdict 大小写绕过', task: VERIFY_INT, state: { ...initState(VERIFY_INT.x), answer: 8, verdict: 'PASS' } },
  { label: 'verify/Str 旧 verdict 复用（answer 改为原值 abc，verdict 是 ABC 的指纹）', task: VERIFY_STR, state: staleVerdict(VERIFY_STR, 'abc') },
  // goal：目标谓词多解可接受，但不符合或跨类型即拒
  { label: 'goal/空 answer', task: GOAL_INT, state: initState(GOAL_INT.x) },
  { label: 'goal/不满足目标谓词（临界值）', task: GOAL_INT, state: { ...initState(GOAL_INT.x), answer: 20 } },
  { label: 'goal/硬编码常量不在目标内', task: GOAL_INT, state: { ...initState(GOAL_INT.x), answer: 0 } },
  { label: 'goal/echo 前缀产物', task: GOAL_INT, state: { ...initState(GOAL_INT.x), answer: 'echo:24' } },
  { label: 'goal/直接复述原题', task: GOAL_INT, state: { ...initState(GOAL_INT.x), answer: GOAL_INT.instruction } },
  { label: 'goal/跨类型答案', task: GOAL_INT, state: { ...initState(GOAL_INT.x), answer: 'abc' } },
  { label: 'goal/len 越界', task: GOAL_STR, state: { ...initState(GOAL_STR.x), answer: 'abcdefgh' } },
  { label: 'goal/len 非字符串', task: GOAL_STR, state: { ...initState(GOAL_STR.x), answer: 42 } },
  // goal_verify：answer 满足目标且 verdict=pass:{hash8(answer)} 同时成立
  { label: 'goal_verify/空 answer', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x), verdict: 'pass' } },
  { label: 'goal_verify/answer 达标但 verdict 缺失', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x), answer: 24 } },
  { label: 'goal_verify/answer 达标但 verdict 非 pass', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x), answer: 24, verdict: 'fail' } },
  // R2-P0-1 关键封堵：先 check 得 pass(gold)，后改值再 submit 得达标 answer，旧指纹必须判拒
  { label: 'goal_verify/先 check 后改值：answer 改 10（目标不达+verdict 漂移）', task: GOAL_VERIFY_INT, state: staleVerdict(GOAL_VERIFY_INT, 10) },
  { label: 'goal_verify/先 check 后改值：answer 改 100（仍达标 gt20，仅 verdict 指纹漂移）', task: GOAL_VERIFY_INT, state: staleVerdict(GOAL_VERIFY_INT, 100) },
  { label: 'goal_verify/answer 达标但 verdict 用别的值指纹', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x, GOAL_VERIFY_INT.spec), answer: 24, verdict: verdictPass(23) } },
  // 跨任务搬运：另一任务 check_* 合法产出的 pass 指纹（8 的指纹）配本任务达标 answer，仍须拒
  { label: 'goal_verify/跨任务搬运他题 verdict 指纹', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x, GOAL_VERIFY_INT.spec), answer: 24, verdict: replay(VERIFY_INT).verdict } },
  { label: 'goal_verify/硬编码常量猜中但 verdict 伪造缺位', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x), answer: 24 } },
  { label: 'goal_verify/直接复述原题 + verdict 复活', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x), answer: GOAL_VERIFY_INT.instruction, verdict: 'pass' } },
  // Str：answer 落在 len[1,5]（'ab' 达标）但 verdict 是旧值 'ABC' 的指纹 → 漂移必拒
  { label: 'goal_verify/Str 复活态：answer 换达标值 verdict 仍旧指纹', task: GOAL_VERIFY_STR, state: staleVerdict(GOAL_VERIFY_STR, 'ab') },
];

/** 正确通道产物：金计划回放或公开目标下的合法多解，必须全部被收。 */
const CORRECT_ARTIFACTS: readonly AdversarialCase[] = [
  { label: 'value/回放金计划', task: VALUE_INT, state: replay(VALUE_INT) },
  { label: 'value/Str 回放', task: VALUE_STR, state: replay(VALUE_STR) },
  { label: 'verify/双生产者齐备', task: VERIFY_INT, state: replay(VERIFY_INT) },
  { label: 'verify/Str 双生产者齐备', task: VERIFY_STR, state: replay(VERIFY_STR) },
  { label: 'goal/回放达标', task: GOAL_INT, state: replay(GOAL_INT) },
  { label: 'goal/多解任一达标', task: GOAL_INT, state: { ...initState(GOAL_INT.x), answer: 21 } },
  { label: 'goal/Str 回放', task: GOAL_STR, state: replay(GOAL_STR) },
  { label: 'goal_verify/双生产者齐备', task: GOAL_VERIFY_INT, state: replay(GOAL_VERIFY_INT) },
  { label: 'goal_verify/Str 双生产者齐备', task: GOAL_VERIFY_STR, state: replay(GOAL_VERIFY_STR) },
  // 公开目标多解的任一达标 answer + 同步提交后的 check_* verdict（合法：submit→check 之间 x 不变）
  { label: 'goal_verify/多解任一 + 当次值的自指纹 verdict', task: GOAL_VERIFY_INT, state: { ...initState(GOAL_VERIFY_INT.x, GOAL_VERIFY_INT.spec), answer: 27, verdict: verdictPass(27) } },
  // check 之后只动 x、不再 submit：answer 未动，绑定成立（验收绑 answer 不绑 x）
  { label: 'goal_verify/金计划后再变换 x 不重提交（answer 未动）仍成立', task: GOAL_VERIFY_INT, state: runPlan(['add3'], replay(GOAL_VERIFY_INT))! },
];

/** 造一个必不满足目标谓词的值：parity 取反相、gt 取临界值、len 用类型不符的 -1。 */
function failingValue(goal: Goal): number {
  switch (goal.kind) {
    case 'parity':
      return 1 - goal.target;
    case 'gt':
      return goal.target;
    case 'len':
      return -1;
    case 'all':
      return failingValue(goal.of[0]!);
  }
}

/** fuzz 造必拒产物：按族构造语义上保证不达标的 answer/verdict 组合。 */
function fuzzWrongState(rng: Rng, task: Task): State {
  const st = initState(task.x, task.spec);
  switch (task.family) {
    case 'value': {
      let a = sampleValue(rng, task.root);
      while (deepEq(a, task.expected)) a = sampleValue(rng, task.root);
      return { ...st, answer: a };
    }
    case 'verify': {
      let a = sampleValue(rng, task.root);
      while (deepEq(a, task.expected)) a = sampleValue(rng, task.root);
      return { ...st, answer: a, verdict: 'pass' };
    }
    case 'goal': {
      const goal = task.spec.goal as Goal;
      if (goal.kind === 'gt') return { ...st, answer: rng.randint(-50, goal.target) };
      if (goal.kind === 'len') {
        return { ...st, answer: 'x'.repeat(rng.randint(goal.max + 1, goal.max + 4)) };
      }
      return { ...st, answer: failingValue(goal) };
    }
    case 'goal_verify': {
      const goal = task.spec.goal as Goal;
      // 旧协议旗标（裸 "pass" 等）在新口径下本就是无效指纹；与不匹配 answer 的 verdict 组合必拒。
      const bad = rng.choice([null, 'fail', 'PASS', 'pass ', '']);
      if (goal.kind === 'gt') {
        return { ...st, answer: rng.randint(goal.target + 1, 50), verdict: bad };
      }
      return { ...st, answer: 'xyz', verdict: bad };
    }
  }
}

/** runAll 固定 seed 补刀的错误产物条数（测试断言与其对齐，防 fuzz 空转）。 */
export const FUZZ_COUNT = 24;

export interface RunAllResult {
  readonly rejectRatio: number;
  readonly acceptCorrectRatio: number;
  readonly caseCount: number;
}

/** 全量自检：静态套件 + 固定 seed fuzz 的错误产物全拒，正确通道产物全收。 */
export function runAll(): RunAllResult {
  const rejected = WRONG_ARTIFACTS.filter((c) => !accept(c.task, c.state)).length;
  const correct = CORRECT_ARTIFACTS.filter((c) => accept(c.task, c.state)).length;

  const rng = makeRng(0x5eed00);
  const wrongPool = [VALUE_INT, VERIFY_INT, GOAL_INT, GOAL_VERIFY_INT, GOAL_STR];
  const fuzzTotal = FUZZ_COUNT;
  let fuzzRejected = 0;
  for (let i = 0; i < fuzzTotal; i++) {
    const task = wrongPool[i % wrongPool.length]!;
    if (!accept(task, fuzzWrongState(rng, task))) fuzzRejected += 1;
  }

  const wrongTotal = WRONG_ARTIFACTS.length + fuzzTotal;
  return {
    rejectRatio: (rejected + fuzzRejected) / wrongTotal,
    acceptCorrectRatio: correct / CORRECT_ARTIFACTS.length,
    caseCount: wrongTotal,
  };
}
