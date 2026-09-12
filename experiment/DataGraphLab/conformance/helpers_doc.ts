/**
 * `docs/helpers.md` 的生成器（T2：helper 签名 + 示例）。
 *
 * 文档不是手写产物：签名表在代码里维护，示例一律来自 `buildFixtures()` 的真实
 * 输出；`npm run golden:check` 同时校验 fixture 与本文件，杜绝文档漂移。
 */

interface HelperRow {
  name: string;
  signature: string;
  file: string;
  status: '已落地' | '待 Phase 0';
  note: string;
}

const CORE: readonly HelperRow[] = [
  { name: 'TYPE_LIST', signature: 'readonly TypeName[]', file: 'world/types.ts', status: '已落地', note: '恰 6 项，one-hot 索引真源' },
  { name: 'TYPE_INDEX', signature: 'Record<TypeName, number>', file: 'world/types.ts', status: '已落地', note: '类型 → one-hot 下标' },
  { name: 't', signature: 't(v: unknown): TypeName', file: 'world/types.ts', status: '已落地', note: 'Bool 先于 Int；List/Json/None' },
  { name: 'deepEq', signature: 'deepEq(a, b): boolean', file: 'world/types.ts', status: '已落地', note: '验收值判定；不做隐式转换' },
  { name: 'makeRng', signature: 'makeRng(seed: number): Rng', file: 'world/rng.ts', status: '已落地', note: 'mulberry32；next/randint/choice/shuffle/uniform' },
  { name: 'canonicalJson', signature: 'canonicalJson(o: unknown): string', file: 'world/hash.ts', status: '已落地', note: '键排序、数字格式固定、-0 归一、CJK 直出' },
  { name: 'crc32', signature: 'crc32(s: string): number', file: 'world/hash.ts', status: '已落地', note: 'IEEE 0xEDB88320，与 zlib.crc32 一致' },
  { name: 'hashObj', signature: 'hashObj(o: unknown): string', file: 'world/hash.ts', status: '已落地', note: 'sha1(canonicalJson)[:16]' },
  { name: 'OPS', signature: 'readonly Contract[]', file: 'world/operators.ts', status: '已落地', note: 'B.2 契约表真源，表序即基础顺序' },
  { name: 'NODES_BASE', signature: 'readonly string[]', file: 'world/operators.ts', status: '已落地', note: '[entry, ...OPS, exit]，槽位依赖此序' },
  { name: 'ROUTING', signature: 'readonly string[]', file: 'world/operators.ts', status: '已落地', note: '去 entry 排序，22 项' },
  { name: 'LEX_OPS_BASE', signature: 'readonly string[]', file: 'world/operators.ts', status: '已落地', note: 'op+terminal id，义项槽冻结' },
  { name: 'MAX_REPEAT', signature: 'number', file: 'world/operators.ts', status: '已落地', note: '单节点访问上限 = 2' },
  { name: 'contractOf', signature: 'contractOf(id): Contract | undefined', file: 'world/operators.ts', status: '已落地', note: '按 id 取契约' },
  { name: 'requiresTypes', signature: 'requiresTypes(c): TypeName[]', file: 'world/operators.ts', status: '已落地', note: '并集去重、剔除 "any"' },
  { name: 'requiresOk', signature: 'requiresOk(c, state): boolean', file: 'world/operators.ts', status: '已落地', note: '字段存在 + 类型命中 + when' },
  { name: 'emod', signature: 'emod(a, m): number', file: 'world/operators.ts', status: '已落地', note: '非负取模，禁裸 %' },
  { name: 'histCount', signature: 'histCount(hist, nid): number', file: 'world/operators.ts', status: '已落地', note: '访问计数唯一口径' },
  { name: 'HIST_SLOTS', signature: 'number', file: 'controller/slots.ts', status: '已落地', note: '历史固定槽位容量 = 32' },
  { name: 'buildNodeSlots', signature: 'buildNodeSlots(nodes, capacity): Map<string, number>', file: 'controller/slots.ts', status: '已落地', note: '追加式稳定槽位，零碰撞' },
  { name: 'NODE_SLOT', signature: 'ReadonlyMap<string, number>', file: 'controller/slots.ts', status: '已落地', note: '基础世界冻结槽位表' },
  { name: 'tokens', signature: 'tokens(instr: string): string[]', file: 'world/tokenize.ts', status: '已落地', note: 'CJK bigram + ASCII 词/字符' },
  { name: 'senseTokens', signature: 'senseTokens(sense: string): string[]', file: 'world/tokenize.ts', status: '已落地', note: '义项按同口径 token 化' },
  { name: 'findSequence', signature: 'findSequence(hay, needle): number', file: 'world/tokenize.ts', status: '已落地', note: '连续子序列首现，找不到 -1' },
  { name: 'mentionStats', signature: 'mentionStats(toks, key): { hits; first; rank }', file: 'world/tokenize.ts', status: '已落地', note: 'key 接受 op_id 或义项列表' },
  { name: 'LEXICON', signature: 'Readonly<Record<string, readonly string[]>>', file: 'world/lexicon.ts', status: '已落地', note: '义项真源；每算子 ≥3，含 `取反` 跨类型歧义' },
  { name: 'GOAL_LEX', signature: 'Readonly<Record<string, readonly string[]>>', file: 'world/lexicon.ts', status: '已落地', note: 'parity/gt/len 目标义项' },
  { name: 'GOAL_TEMPLATES', signature: 'Readonly<Record<string, readonly string[]>>', file: 'world/lexicon.ts', status: '已落地', note: '目标句模板；gt/len 必含数值' },
  { name: 'renderRecipe', signature: 'renderRecipe(rng, plan, x): string', file: 'world/render.ts', status: '已落地', note: '线性渲染；义项全指令全局唯一' },
  { name: 'parseRecipe', signature: 'parseRecipe(instr, rootType): string[]', file: 'world/render.ts', status: '已落地', note: '往返解析；共享义项按类型消歧' },
  { name: 'renderGoal', signature: 'renderGoal(rng, goal): string', file: 'world/render.ts', status: '已落地', note: '只描述目标，绝不出现算子义项' },
  { name: 'goalOk', signature: 'goalOk(value, spec): boolean', file: 'world/goal.ts', status: '已落地', note: 'parity/gt/len/all；类型守卫不抛异常' },
  { name: 'validateLexicon', signature: 'validateLexicon(): string[]', file: 'world/lexicon_audit.ts', status: '已落地', note: '覆盖/包含/歧义/goal 泄漏四项自检' },
];

const PENDING: readonly HelperRow[] = [
  { name: 'sample_value', signature: 'sampleValue(rng, root): number | string', file: 'world/operators.ts', status: '已落地', note: 'Int 全域 -50..50；Str 长度 1..8 的 a-h' },
  { name: 'init_state', signature: 'initState(x, spec?): State', file: 'world/operators.ts', status: '已落地', note: '{x, answer:null, verdict:null, hist:[], spec:{}}' },
  { name: 'apply_op', signature: 'applyOp(graph, nid, st): State | null', file: 'world/operators.ts', status: '已落地', note: '契约闸+变换+hist 追加；null=死路' },
  { name: 'run_plan', signature: 'runPlan(plan, st): State | null', file: 'world/operators.ts', status: '已落地', note: '顺序回放，不写 expected' },
  { name: 'obs_snapshot', signature: 'obsSnapshot(st): object', file: 'world/operators.ts', status: '已落地', note: '只投影 x/answer/verdict/hist' },
  { name: 'enumerate_skeletons', signature: 'enumerateSkeletons(maxDepth): Skel[]', file: 'gen/generator.ts', status: '待 Phase 0', note: '只取 kind=op，终算子不入池' },
  { name: 'signature', signature: 'signature(root, skeleton): Sig', file: 'gen/generator.ts', status: '待 Phase 0', note: 'Int 全域探针；Str 固定探针' },
  { name: 'dedupe_by_signature', signature: 'dedupeBySignature(skels): Skel[]', file: 'gen/generator.ts', status: '待 Phase 0', note: '同签名留最短' },
  { name: 'SKELETONS/STRATA/split_of', signature: 'SKELETONS; STRATA; splitOf(sk)', file: 'gen/splits.ts', status: '待 Phase 0', note: '按骨架分层切 train/val/heldout' },
  { name: 'instance_follow/instance_goal', signature: 'instanceFollow(...); instanceGoal(...)', file: 'gen/generator.ts', status: '待 Phase 0', note: 'public spec + hidden gold plan' },
  { name: 'has_one_step_solution', signature: 'hasOneStepSolution(task, graph): boolean', file: 'gen/generator.ts', status: '待 Phase 0', note: '关死单步 echo/submit 捷径' },
  { name: 'make_task/make_split/make_coverage_split', signature: 'makeTask(...); makeSplit(...); makeCoverageSplit(...)', file: 'gen/generator.ts', status: '待 Phase 0', note: '确定性配额；配额不足抛错' },
  { name: 'candidates', signature: 'candidates(graph, st, hist): string[]', file: 'runner/graph.ts', status: '待 Phase 0', note: 'entry 禁入；访问上限唯一实现' },
  { name: 'accept / acceptor_view', signature: 'accept(task, st): boolean; acceptorView(task)', file: 'verify/acceptor.ts', status: '待 Phase 0', note: '通道收口；只看 public+产物' },
  { name: 'state_digest / plan_bfs', signature: 'stateDigest(st): string; planBfs(task, graph): string[] | null', file: 'teacher/search.ts', status: '待 Phase 0', note: 'BFS 最短解；不进训练集' },
  { name: 'featurize_* / OBS_DIM / ACT_DIM', signature: 'featurizeInstr/State/Action; OBS_DIM=596; ACT_DIM=83', file: 'controller/features.ts', status: '待 Phase 0', note: '白名单只读 instruction/state' },
  { name: 'Policy.forward/backward/act/save/load', signature: 'Policy', file: 'controller/policy.ts', status: '待 Phase 0', note: 'pointer 打分；数值梯度校验' },
  { name: 'val_ce / batches / snapshot', signature: 'valCe(policy, D): number; batches(D, n); snapshot(policy)', file: 'controller/train.py', status: '待 Phase 0', note: '训练器内层；仅 numpy' },
  { name: 'trainPython / loadWeights', signature: 'trainPython(D, valD): string; loadWeights(path): Policy', file: 'controller/train.py', status: '待 Phase 0', note: '唯一跨语言接口 records.bin/weights.json' },
  { name: 'recordOf / samePrefix', signature: 'recordOf(st, cand, target); samePrefix(hist, plan, k)', file: 'runner/dagger.ts', status: '待 Phase 0', note: 'on-path 判定；off-prefix 不打标' },
  { name: 'manifest / audit / quarantine', signature: 'manifest(...); audit(...); quarantine(rec)', file: 'data/provenance.ts', status: '待 Phase 0', note: 'G0.4 泄漏审计；标签冲突隔离' },
  { name: 'HeuristicArm / RandomArm / TrainedArm / PlannerArm', signature: 'HeuristicArm; RandomArm; TrainedArm; PlannerArm', file: 'eval/arms.ts', status: '待 Phase 0', note: 'HeuristicArm 用 LEXICON 首现顺序解析' },
  { name: 'pass_at_1 / path_excess / steps_over_shortest / routing_acc / ci95', signature: '指标函数', file: 'eval/metrics.ts', status: '待 Phase 0', note: 'pass@1 带 95% CI；routing_acc 仅诊断' },
  { name: 'structure/*', signature: 'Genome; validate; MUTATIONS; fitness; search; promote', file: 'structure/*', status: '待 Phase 0', note: '离线、需求触发、成功非降 + 回滚' },
  { name: 'chat / listFreeModels', signature: 'chat(messages, model); listFreeModels()', file: 'adapters/llm_gateway.ts', status: '待 Phase 0', note: 'Kilo 网关免费档；run 内 pin 死' },
];

function row(r: HelperRow): string {
  return `| \`${r.name}\` | \`${r.signature}\` | \`${r.file}\` | ${r.status} | ${r.note} |`;
}

function block(text: string): string {
  return '```text\n' + text + '\n```\n';
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

export function buildHelpersDoc(fx: Record<string, unknown>): string {
  const rng = fx.rng as ReadonlyArray<{ seed: number; first8: number[] }>;
  const crc = fx.crc32 as ReadonlyArray<{ s: string; crc32: number }>;
  const canon = fx.canonical as ReadonlyArray<{ label: string; json: string; hash: string }>;
  const tokensFx = fx.tokens as ReadonlyArray<{ input: string; tokens: string[] }>;
  const mentions = fx.mentionStats as ReadonlyArray<Record<string, unknown>>;
  const recipes = fx.renderRecipe as ReadonlyArray<Record<string, unknown>>;
  const goals = fx.renderGoal as ReadonlyArray<Record<string, unknown>>;
  const nodeSlots = fx.nodeSlots as Record<string, number>;

  const examples = [
    block(
      [
        ...rng.map((r) => `makeRng(${r.seed}).next() x8 => ${json(r.first8)}`),
        '',
        ...crc.map((c) => `crc32(${json(c.s)}) => ${c.crc32}`),
        '',
        ...canon.map((c) => `hashObj(${c.label}) => ${c.hash}  canonicalJson => ${c.json}`),
      ].join('\n'),
    ),
    block(
      [
        ...tokensFx.map((t) => `tokens(${json(t.input)}) => ${json(t.tokens)}`),
        '',
        ...mentions.map(
          (m) => `mentionStats(${json(m.instruction)}, ${json(m.op)}) => ${json({ hits: m.hits, first: m.first, rank: m.rank })}`,
        ),
      ].join('\n'),
    ),
    block(
      [
        `NODE_SLOT => ${json(nodeSlots)}`,
        '',
        ...recipes.map((r) => `renderRecipe(seed=${r.seed}, ${json(r.plan)}) => ${json(r.instruction)}`),
        '',
        ...goals.map((g) => `renderGoal(seed=${g.seed}, ${json(g.goal)}) => ${json(g.instruction)}`),
      ].join('\n'),
    ),
  ];

  return [
    '# DataGraphLab helper 规格与金标（自动生成，勿手改）',
    '',
    '本文件与 `conformance/fixtures.json` 均由 `conformance/gen_golden.ts` 生成并冻结；',
    '`npm run golden:check` 会重算比对，任何漂移即失败。文档中的示例不是手写值，',
    '而是参考实现的真实输出（同一批 fixture 同时被 `tests/golden.test.ts` 断言）。',
    '',
    '## 通用约定',
    '',
    '- 确定性：随机一律 `makeRng(seed)`，禁用 `Math.random`；哈希一律 `hashObj`/`crc32`，',
    '  禁用 `JSON.stringify` 默认键序与任何内置 `hash()`。',
    '- 类型：`t()` 先判 Bool 再判 Int；`TYPE_LIST` 恰 6 项。',
    '- `"any"` 只是 requires 的通配符，绝不进 TYPE_LIST / requires_types。',
    '- 浮点：特征/参数走 float32；跨语言一致性只在 `records.jsonl` / `weights.json`。',
    '',
    '## T2 核心 helper（本波已落地）',
    '',
    '| 符号 | 签名 | 文件 | 状态 | 语义/边界 |',
    '|---|---|---|---|---|',
    ...CORE.map(row),
    '',
    '## T2 其余 helper（随各自 Phase 0 文件补齐）',
    '',
    '| 符号 | 签名 | 文件 | 状态 | 语义/边界 |',
    '|---|---|---|---|---|',
    ...PENDING.map(row),
    '',
    '## 冻结示例（同一批 fixture 可被测试复算）',
    '',
    ...examples,
    '## fixture 索引',
    '',
    '- `constants`：TYPE_LIST / NODES_BASE / ROUTING / LEX_OPS_BASE / MAX_REPEAT / HIST_SLOTS',
    '- `nodeSlots`、`rng`、`crc32`、`canonical`、`tokens`、`mentionStats`',
    '- `renderRecipe`、`renderGoal`',
    '',
    '> 注：`canonical` 的 `input` 只以 canonical 串与 hash 冻结（JSON 无法区分 `-0` 与 `0`）。',
    '',
  ].join('\n');
}
