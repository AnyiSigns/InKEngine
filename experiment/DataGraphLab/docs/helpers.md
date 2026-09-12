# DataGraphLab helper 规格与金标（自动生成，勿手改）

本文件与 `conformance/fixtures.json` 均由 `conformance/gen_golden.ts` 生成并冻结；
`npm run golden:check` 会重算比对，任何漂移即失败。文档中的示例不是手写值，
而是参考实现的真实输出（同一批 fixture 同时被 `tests/golden.test.ts` 断言）。

## 通用约定

- 确定性：随机一律 `makeRng(seed)`，禁用 `Math.random`；哈希一律 `hashObj`/`crc32`，
  禁用 `JSON.stringify` 默认键序与任何内置 `hash()`。
- 类型：`t()` 先判 Bool 再判 Int；`TYPE_LIST` 恰 6 项。
- `"any"` 只是 requires 的通配符，绝不进 TYPE_LIST / requires_types。
- 浮点：特征/参数走 float32；跨语言一致性只在 `records.jsonl` / `weights.json`。

## T2 核心 helper（本波已落地）

| 符号 | 签名 | 文件 | 状态 | 语义/边界 |
|---|---|---|---|---|
| `TYPE_LIST` | `readonly TypeName[]` | `world/types.ts` | 已落地 | 恰 6 项，one-hot 索引真源 |
| `TYPE_INDEX` | `Record<TypeName, number>` | `world/types.ts` | 已落地 | 类型 → one-hot 下标 |
| `t` | `t(v: unknown): TypeName` | `world/types.ts` | 已落地 | Bool 先于 Int；List/Json/None |
| `deepEq` | `deepEq(a, b): boolean` | `world/types.ts` | 已落地 | 验收值判定；不做隐式转换 |
| `makeRng` | `makeRng(seed: number): Rng` | `world/rng.ts` | 已落地 | mulberry32；next/randint/choice/shuffle/uniform |
| `canonicalJson` | `canonicalJson(o: unknown): string` | `world/hash.ts` | 已落地 | 键排序、数字格式固定、-0 归一、CJK 直出 |
| `crc32` | `crc32(s: string): number` | `world/hash.ts` | 已落地 | IEEE 0xEDB88320，与 zlib.crc32 一致 |
| `hashObj` | `hashObj(o: unknown): string` | `world/hash.ts` | 已落地 | sha1(canonicalJson)[:16] |
| `OPS` | `readonly Contract[]` | `world/operators.ts` | 已落地 | B.2 契约表真源，表序即基础顺序 |
| `NODES_BASE` | `readonly string[]` | `world/operators.ts` | 已落地 | [entry, ...OPS, exit]，槽位依赖此序 |
| `ROUTING` | `readonly string[]` | `world/operators.ts` | 已落地 | 去 entry 排序，22 项 |
| `LEX_OPS_BASE` | `readonly string[]` | `world/operators.ts` | 已落地 | op+terminal id，义项槽冻结 |
| `MAX_REPEAT` | `number` | `world/operators.ts` | 已落地 | 单节点访问上限 = 2 |
| `contractOf` | `contractOf(id): Contract | undefined` | `world/operators.ts` | 已落地 | 按 id 取契约 |
| `requiresTypes` | `requiresTypes(c): TypeName[]` | `world/operators.ts` | 已落地 | 并集去重、剔除 "any" |
| `requiresOk` | `requiresOk(c, state): boolean` | `world/operators.ts` | 已落地 | 字段存在 + 类型命中 + when |
| `emod` | `emod(a, m): number` | `world/operators.ts` | 已落地 | 非负取模，禁裸 % |
| `histCount` | `histCount(hist, nid): number` | `world/operators.ts` | 已落地 | 访问计数唯一口径 |
| `HIST_SLOTS` | `number` | `controller/slots.ts` | 已落地 | 历史固定槽位容量 = 32 |
| `buildNodeSlots` | `buildNodeSlots(nodes, capacity): Map<string, number>` | `controller/slots.ts` | 已落地 | 追加式稳定槽位，零碰撞 |
| `NODE_SLOT` | `ReadonlyMap<string, number>` | `controller/slots.ts` | 已落地 | 基础世界冻结槽位表 |
| `tokens` | `tokens(instr: string): string[]` | `world/tokenize.ts` | 已落地 | CJK bigram + ASCII 词/字符 |
| `senseTokens` | `senseTokens(sense: string): string[]` | `world/tokenize.ts` | 已落地 | 义项按同口径 token 化 |
| `findSequence` | `findSequence(hay, needle): number` | `world/tokenize.ts` | 已落地 | 连续子序列首现，找不到 -1 |
| `mentionStats` | `mentionStats(toks, key): { hits; first; rank }` | `world/tokenize.ts` | 已落地 | key 接受 op_id 或义项列表 |
| `LEXICON` | `Readonly<Record<string, readonly string[]>>` | `world/lexicon.ts` | 已落地 | 义项真源；每算子 ≥3，含 `取反` 跨类型歧义 |
| `GOAL_LEX` | `Readonly<Record<string, readonly string[]>>` | `world/lexicon.ts` | 已落地 | parity/gt/len 目标义项 |
| `GOAL_TEMPLATES` | `Readonly<Record<string, readonly string[]>>` | `world/lexicon.ts` | 已落地 | 目标句模板；gt/len 必含数值 |
| `renderRecipe` | `renderRecipe(rng, plan, x): string` | `world/render.ts` | 已落地 | 线性渲染；义项全指令全局唯一 |
| `parseRecipe` | `parseRecipe(instr, rootType): string[]` | `world/render.ts` | 已落地 | 往返解析；共享义项按类型消歧 |
| `renderGoal` | `renderGoal(rng, goal): string` | `world/render.ts` | 已落地 | 只描述目标，绝不出现算子义项 |
| `goalOk` | `goalOk(value, spec): boolean` | `world/goal.ts` | 已落地 | parity/gt/len/all；类型守卫不抛异常 |
| `validateLexicon` | `validateLexicon(): string[]` | `world/lexicon_audit.ts` | 已落地 | 覆盖/包含/歧义/goal 泄漏四项自检 |

## T2 其余 helper（随各自 Phase 0 文件补齐）

| 符号 | 签名 | 文件 | 状态 | 语义/边界 |
|---|---|---|---|---|
| `sample_value` | `sampleValue(rng, root): number | string` | `world/operators.ts` | 已落地 | Int 全域 -50..50；Str 长度 1..8 的 a-h |
| `init_state` | `initState(x, spec?): State` | `world/operators.ts` | 已落地 | {x, answer:null, verdict:null, hist:[], spec:{}} |
| `apply_op` | `applyOp(graph, nid, st): State | null` | `world/operators.ts` | 已落地 | 契约闸+变换+hist 追加；null=死路 |
| `run_plan` | `runPlan(plan, st): State | null` | `world/operators.ts` | 已落地 | 顺序回放，不写 expected |
| `obs_snapshot` | `obsSnapshot(st): object` | `world/operators.ts` | 已落地 | 只投影 x/answer/verdict/hist |
| `enumerate_skeletons` | `enumerateSkeletons(maxDepth): Skel[]` | `gen/generator.ts` | 待 Phase 0 | 只取 kind=op，终算子不入池 |
| `signature` | `signature(root, skeleton): Sig` | `gen/generator.ts` | 待 Phase 0 | Int 全域探针；Str 固定探针 |
| `dedupe_by_signature` | `dedupeBySignature(skels): Skel[]` | `gen/generator.ts` | 待 Phase 0 | 同签名留最短 |
| `SKELETONS/STRATA/split_of` | `SKELETONS; STRATA; splitOf(sk)` | `gen/splits.ts` | 待 Phase 0 | 按骨架分层切 train/val/heldout |
| `instance_follow/instance_goal` | `instanceFollow(...); instanceGoal(...)` | `gen/generator.ts` | 待 Phase 0 | public spec + hidden gold plan |
| `has_one_step_solution` | `hasOneStepSolution(task, graph): boolean` | `gen/generator.ts` | 待 Phase 0 | 关死单步 echo/submit 捷径 |
| `make_task/make_split/make_coverage_split` | `makeTask(...); makeSplit(...); makeCoverageSplit(...)` | `gen/generator.ts` | 待 Phase 0 | 确定性配额；配额不足抛错 |
| `candidates` | `candidates(graph, st, hist): string[]` | `runner/graph.ts` | 待 Phase 0 | entry 禁入；访问上限唯一实现 |
| `accept / acceptor_view` | `accept(task, st): boolean; acceptorView(task)` | `verify/acceptor.ts` | 已落地 | 通道收口；只看 public+产物 |
| `CHANNEL` | `Readonly<Record<Family, readonly string[]>>` | `verify/acceptor.ts` | 已落地 | 通道表唯一真源；value/goal 单生产者，verify/goal_verify 双生产者 |
| `acceptChannelled` | `acceptChannelled(task, st): Verdict` | `verify/acceptor.ts` | 已落地 | 只读本族通道字段；缺失即 reason=missing:<field> |
| `WRONG_ARTIFACTS` | `readonly AdversarialCase[]` | `verify/adversarial.ts` | 已落地 | 空值/语义错/旧 verdict 复用/复述原题/硬编码常量 |
| `runAll` | `runAll(): {rejectRatio; acceptCorrectRatio; caseCount}` | `verify/adversarial.ts` | 已落地 | 错误产物全拒 + 正确通道全收 + 固定 seed fuzz |
| `FUZZ_COUNT` | `number` | `verify/adversarial.ts` | 已落地 | runAll 固定 seed 补刀错误产物条数 = 24 |
| `runSandboxed` | `runSandboxed(code, tests, timeoutS?): Promise<{ok; output}>` | `verify/sandbox.ts` | 已落地 | 接口占位；代码族验证未启用，调用即抛错 |
| `state_digest / plan_bfs` | `stateDigest(st): string; planBfs(task, graph): string[] | null` | `teacher/search.ts` | 待 Phase 0 | BFS 最短解；不进训练集 |
| `featurize_* / OBS_DIM / ACT_DIM` | `featurizeInstr/State/Action; OBS_DIM=724; ACT_DIM=83` | `controller/features.ts` | 待 Phase 0 | 白名单只读 instruction/state |
| `Policy.forward/backward/act/save/load` | `Policy` | `controller/policy.ts` | 待 Phase 0 | pointer 打分；数值梯度校验 |
| `val_ce / batches / snapshot` | `valCe(policy, D): number; batches(D, n); snapshot(policy)` | `controller/train.py` | 待 Phase 0 | 训练器内层；仅 numpy |
| `trainPython / loadWeights` | `trainPython(D, valD): string; loadWeights(path): Policy` | `controller/train.py` | 待 Phase 0 | 唯一跨语言接口 records.bin/weights.json |
| `recordOf / samePrefix` | `recordOf(st, cand, target); samePrefix(hist, plan, k)` | `runner/dagger.ts` | 待 Phase 0 | on-path 判定；off-prefix 不打标 |
| `manifest / audit / quarantine` | `manifest(...); audit(...); quarantine(rec)` | `data/provenance.ts` | 待 Phase 0 | G0.4 泄漏审计；标签冲突隔离 |
| `HeuristicArm / RandomArm / TrainedArm / PlannerArm` | `HeuristicArm; RandomArm; TrainedArm; PlannerArm` | `eval/arms.ts` | 待 Phase 0 | HeuristicArm 用 LEXICON 首现顺序解析 |
| `pass_at_1 / path_excess / steps_over_shortest / routing_acc / ci95` | `指标函数` | `eval/metrics.ts` | 待 Phase 0 | pass@1 带 95% CI；routing_acc 仅诊断 |
| `structure/*` | `Genome; validate; MUTATIONS; fitness; search; promote` | `structure/*` | 待 Phase 0 | 离线、需求触发、成功非降 + 回滚 |
| `chat / listFreeModels` | `chat(messages, model); listFreeModels()` | `adapters/llm_gateway.ts` | 待 Phase 0 | Kilo 网关免费档；run 内 pin 死 |

## 冻结示例（同一批 fixture 可被测试复算）

```text
makeRng(0).next() x8 => [1144304738,1416247,958946056,627933444,2007157716,2340967985,2642484575,2787370982]
makeRng(1).next() x8 => [2693262067,11749833,2265367787,4213581821,4159151403,1207330352,2632122864,3095568220]
makeRng(42).next() x8 => [2581720956,1925393290,3661312704,2876485805,750819978,2261697747,1173505300,2683257857]

crc32("") => 0
crc32("hello") => 907060870
crc32("加三") => 1474690540
crc32("取反") => 3706575867
crc32("task:0") => 3143333359

hashObj(zero) => b6589fc6ab0dc82c  canonicalJson => 0
hashObj(neg-zero) => b6589fc6ab0dc82c  canonicalJson => 0
hashObj(tenth) => 180505679cfe0cca  canonicalJson => 0.1
hashObj(tiny) => edd591d5998d92a0  canonicalJson => 1e-7
hashObj(one) => 356a192b7913b04c  canonicalJson => 1
hashObj(nested) => 7e6ad26fea2eecfd  canonicalJson => {"a":{"n":0.1},"b":[1,2,3],"c":"中文"}
hashObj(cjk) => 345e1522feecde02  canonicalJson => {"中文键":"值"}
```

```text
tokens("加三，然后翻倍") => ["加三","然后","后翻","翻倍"]
tokens("起点值12。按顺序做：加三，然后取反") => ["起点","点值","12","按顺","顺序","序做","加三","然后","后取","取反"]
tokens("结果是偶数，且结果大于5") => ["结果","果是","是偶","偶数","且结","结果","果大","大于","5"]
tokens("abc") => ["abc"]

mentionStats("加三，然后翻倍，接着减一", "mul2") => {"hits":1,"first":3,"rank":1}
mentionStats("加三，然后翻倍，接着减一", "add3") => {"hits":1,"first":0,"rank":0}
mentionStats("取反，再提交", "reverse") => {"hits":1,"first":0,"rank":0}
mentionStats("结果是偶数，且结果大于5", "check_parity") => {"hits":0,"first":-1,"rank":15}
```

```text
NODE_SLOT => {"add3":0,"mul2":1,"sub1":2,"neg":3,"mod7":4,"upper":5,"lower":6,"reverse":7,"append_bang":8,"str_len":9,"cond_even":10,"cond_long":11,"submit":12,"check_parity":13,"check_len":14,"noop":15,"fake_add":16,"shuffle":17,"dead_end":18,"echo":19,"branch_decoy":20,"exit":21}

renderRecipe(seed=0, ["add3","mul2","sub1","submit"]) => "起点值12。照下面来：添三，之后乘以二，接着减一，此时给出答案"
renderRecipe(seed=1, ["add3","add3","mod7","submit"]) => "起点值-7。按顺序做：增三，此时添三，随后模七求余，接着给出答案"
renderRecipe(seed=2, ["upper","reverse","append_bang","submit"]) => "起点值「abc」。依次执行：变大写，然后颠倒，此时末尾添叹，随后提交"
renderRecipe(seed=3, ["cond_even","submit","check_parity"]) => "起点值9。照下面来：双数加一单数变双倍，再提交，之后核验奇偶"
renderRecipe(seed=4, ["cond_long","submit","check_len"]) => "起点值「abcd」。从起点出发，字符够多则全换大写，然后输出答案，此时核验长度"
renderRecipe(seed=5, ["str_len","mul2","submit","check_parity"]) => "起点值「hello」。从起点出发，取长度，再乘以二，随后给出答案，此时校验奇偶性"
renderRecipe(seed=6, ["neg","add3","submit"]) => "起点值5。依次执行：变号，随后加三，接着输出答案"
renderRecipe(seed=7, ["reverse","lower","submit"]) => "起点值「ab」。按顺序做：反转，再变小写，随后给出答案"

renderGoal(seed=0, {"kind":"parity","target":0}) => "输出应为偶数"
renderGoal(seed=1, {"kind":"parity","target":1}) => "让最终值为奇数"
renderGoal(seed=2, {"kind":"gt","target":20}) => "把结果变成大于20的数"
renderGoal(seed=3, {"kind":"len","min":1,"max":5}) => "字符数介于1和5"
renderGoal(seed=4, {"kind":"all","of":[{"kind":"parity","target":1},{"kind":"gt","target":0}]}) => "输出应为奇数并且让最终值超过0"
```

## fixture 索引

- `constants`：TYPE_LIST / NODES_BASE / ROUTING / LEX_OPS_BASE / MAX_REPEAT / HIST_SLOTS
- `nodeSlots`、`rng`、`crc32`、`canonical`、`tokens`、`mentionStats`
- `renderRecipe`、`renderGoal`

> 注：`canonical` 的 `input` 只以 canonical 串与 hash 冻结（JSON 无法区分 `-0` 与 `0`）。
