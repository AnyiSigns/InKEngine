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

## 核心 helper（已落地，含 Phase 0/T2 与 Phase 1 控制器与评测面）

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
| `hash8` | `hash8(o: unknown): string` | `world/hash.ts` | 已落地 | hashObj[:8]；B.4 verdict 指纹唯一截断口径 |
| `OPS` | `readonly Contract[]` | `world/operators.ts` | 已落地 | B.2 契约表真源，表序即基础顺序 |
| `NODES_BASE` | `readonly string[]` | `world/operators.ts` | 已落地 | [entry, ...OPS, exit]，槽位依赖此序 |
| `ROUTING` | `readonly string[]` | `world/operators.ts` | 已落地 | 去 entry 排序，22 项 |
| `LEX_OPS_BASE` | `readonly string[]` | `world/operators.ts` | 已落地 | op+terminal id，义项槽冻结 |
| `MAX_REPEAT` | `number` | `world/operators.ts` | 已落地 | 单节点访问上限 = 2 |
| `contractOf` | `contractOf(id): Contract | undefined` | `world/operators.ts` | 已落地 | 按 id 取契约 |
| `requiresTypes` | `requiresTypes(c): TypeName[]` | `world/operators.ts` | 已落地 | 并集去重、剔除 "any" |
| `requiresOk` | `requiresOk(c, state): boolean` | `world/operators.ts` | 已落地 | 字段存在 + 类型命中 + when |
| `emod` | `emod(a, m): number` | `world/operators.ts` | 已落地 | 非负取模，禁裸 % |
| `verdictPass` | `verdictPass(v: unknown): string` | `world/operators.ts` | 已落地 | check_* 通过写 "pass:"+hash8(v)；accept 据此绑定 answer 指纹（R2-P0-1） |
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
| `MAX_DEPTH` | `number` | `gen/skeletons.ts` | 已落地 | C.1 深度上限 = 5（不含终算子） |
| `PROBE_INT / PROBE_STR` | `readonly (number|string)[]` | `gen/skeletons.ts` | 已落地 | Int 全域 101 点；Str 固定十串 |
| `enumerateSkeletons` | `enumerateSkeletons(maxDepth?): Skel[]` | `gen/skeletons.ts` | 已落地 | 只取 kind=op，终算子不入池；前缀增量探针向量，勿逐骨架重放 |
| `signature` | `signature(root, skeleton): Sig` | `gen/skeletons.ts` | 已落地 | Int 全域探针可证正确；Str 固定探针 |
| `dedupeBySignature` | `dedupeBySignature(skels): Skel[]` | `gen/skeletons.ts` | 已落地 | 同签名留最短、同长取字典序首；纯函数，不含恒等过滤（构造层序：去冗余后恒等过滤，恒等过滤只在 SKELETONS 构造层） |
| `isIdentity` | `isIdentity(root, skeleton): boolean` | `gen/skeletons.ts` | 已落地 | 全探针值不变判恒等（[neg,neg]/[reverse,reverse] 真）；SKELETONS 不含恒等签名（R2-P0-3，其 0-op 解任务必抬 G2.2） |
| `SKELETONS` | `readonly Skel[]` | `gen/skeletons.ts` | 已落地 | 模块级一次性计算：去冗余后、恒等签名丢弃后的全量骨架池 |
| `_skelId` | `_skelId(sk): string` | `gen/skeletons.ts` | 已落地 | hashObj([root, plan])，composition_id 口径 |
| `_stratum / STRATA` | `_stratum(sk): StratumKey; STRATA: ReadonlyMap` | `gen/splits.ts` | 已落地 | 分层键 = 深度 × 是否含 cond |
| `codepointCompare` | `codepointCompare(a, b): number` | `gen/splits.ts` | 已落地 | 码点序唯一口径；localeCompare 依赖 locale，禁用于确定性排序 |
| `_splitMaps` | `_splitMaps(strata?): {heldout; val}` | `gen/splits.ts` | 已落地 | 每层 heldout≈20%/val≈5%、保底 ≥1；层内 <2 报错 |
| `HELDOUT_SKELETONS / VAL_SKELETONS` | `ReadonlySet<string>` | `gen/splits.ts` | 已落地 | composition_id 注册表，与 train 零重叠 |
| `splitOf` | `splitOf(sk): Split` | `gen/splits.ts` | 已落地 | train/val/heldout 归属，切分只看骨架 |
| `sampleGoal` | `sampleGoal(rng, root): Goal` | `gen/generator.ts` | 已落地 | Int parity/gt，Str len；40% 合取强制多步规划 |
| `goalProbeHit` | `goalProbeHit(root, plan, goal): boolean` | `gen/producibility.ts` | 已落地 | 单目标可达性探针；Int instance_goal 精确剪枝，Str 只提示；经 generator.ts 公开 |
| `GOAL_PROBE_GOALS` | `readonly Goal[]` | `gen/producibility.ts` | 已落地 | 适格性判定池（sampleGoal 四单体采样器全集 7 项，按 root 型别子集使用） |
| `goalEligible` | `goalEligible(root, skeleton): boolean` | `gen/producibility.ts` | 已落地 | 族适格性（R2-P0-2）：存在「初始不达标∧终值达标」对；长度不变/str_len 收尾/值单调类判不适格，goal 域两族采样只走适格池；Int 全域精确 |
| `isGoalDomain` | `isGoalDomain(family): boolean` | `gen/producibility.ts` | 已落地 | goal 与 goal_verify 同池采目标，适格性对两族一致（伪代码字面 fam!="goal" 漏掉 goal_verify，落地按语义补齐） |
| `coverageKey` | `coverageKey(style, family, compositionId): string` | `gen/producibility.ts` | 已落地 | `style:family:composition_id` 稳定键 |
| `hasOneStepSolution` | `hasOneStepSolution(task, graph): boolean` | `gen/producibility.ts` | 已落地 | 关死单步 echo/submit 捷径；O(|candidates|) apply+accept；经 generator.ts 公开 |
| `hasShortcut` | `hasShortcut(task, graph): boolean` | `gen/producibility.ts` | 已落地 | follow 极小性守卫（R2-P0-3 删任意步版）：单步替换 + 删任意 ≥1 骨架步（真子序列 ≤31 个）回放穿验收且严格短于金计划 → 非最小，换 witness。**R5 轨迹约束后按定义恒 false**（捷径自带不同 trace → 验收拒），保留作安全网，不再滤任务 |
| `UNPRODUCIBLE_HELDOUT` | `ReadonlySet<string>` | `gen/producibility.ts` | 已落地 | heldout 不可产注册表：goal 两族键由 goalEligible 派生（薄层视图，无第二套判定）；**R5 轨迹约束后 follow 键清空**（结构性非最小不再是缺陷，全骨架重新可产；原 80×2 键移除），覆盖构造按可产域声明、键显式上报 |
| `instanceFollow / instanceGoal` | `instanceFollow(...); instanceGoal(...)` | `gen/generator.ts` | 已落地 | public spec + hidden gold；回放穿 accept 才返回；follow 族 spec 恒带公开 trace（R5：含收尾终算子的渲染序列，验收 = 值 ∧ hist==trace） |
| `STYLES / instanceTask` | `STYLES: Record<Style, Family[]>; instanceTask(...)` | `gen/generator.ts` | 已落地 | follow→value/verify；goal→goal/goal_verify |
| `makeTask` | `makeTask(seed, style?, family?, split?, skeleton?): Task | null` | `gen/generator.ts` | 已落地 | 同 seed 完全确定；可钉骨架/族/切分；goal 域族抽样只走适格池，钉入不适格骨架即返回 null |
| `makeSplit` | `makeSplit(split, perFamily, seed?, maxPerSkeleton?): Task[]` | `gen/generator.ts` | 已落地 | 配额制；goal 域族只走适格池（R2-P0-2）；R5 后 follow 无可产域限制（hasShortcut 恒 false、followUnproducible 退化为回放可穿），配额不足抛错不静默 |
| `makeCoverageSplitInfo` | `makeCoverageSplitInfo(split, seed?, skeletons?): {tasks; unproducible; unproducibleCount; ineligible; ineligibleCount}` | `gen/generator.ts` | 已落地 | follow 可产域 + goal 适格池每骨架每 (style,family) 恰 1 条；goal 不适格与 follow 非最小骨架均以键显式上报（不静默），ineligible 清单仅 goal 侧；可产域内产不出抛错；骨架池可注入 |
| `makeCoverageSplit` | `makeCoverageSplit(split, seed?): Task[]` | `gen/generator.ts` | 已落地 | makeCoverageSplitInfo 的任务列表口径（C.1 签名保持） |
| `GRAPH` | `Graph` | `runner/graph.ts` | 已落地 | OPS/NODES_BASE 组装；entry/exit kind=structural（无契约，不参与契约/动作分类） |
| `candidates` | `candidates(graph, st, hist): string[]` | `runner/graph.ts` | 已落地 | entry 禁入；exit 恒在；访问上限唯一实现 |
| `MAX_STEPS` | `number` | `runner/graph.ts` | 已落地 | C.7/E.14 唯一口径 = 12 |
| `oracleTrace` | `oracleTrace(task, graph): Step[]` | `teacher/oracle.ts` | 已落地 | C.3 逐步 on-path 标签；断言候选内/非死路/末步 EXIT/回放穿验收；obs 走白名单投影 |
| `isOnPath` | `isOnPath(hist, plan): boolean` | `teacher/oracle.ts` | 已落地 | gold 前缀唯一判定源（标签纪律；DAgger 侧复用） |
| `recordFromStep` | `recordFromStep(task, step, extraMeta?): StoreRecord` | `data/store.ts` | 已落地 | F.2 原始 obs 记录；meta 只带派生指纹（expected/spec/plan 原值绝无写入路径） |
| `append / load` | `append(records, opts?): AppendResult; load(split, opts?): StoreRecord[]` | `data/store.ts` | 已落地 | 内容寻址 canonical-JSONL 分片按 (world_version, split, family)；对盘上既有步级去重；坏行 fail-fast（load 追加 style/family 值域与 meta.c_hash 复核，报错含分片#行号；校验内核 data/store_schema.ts 唯一口径） |
| `dedup / taskDedupKey / stepDedupKey` | `dedup(items); taskDedupKey(task); stepDedupKey(rec)` | `data/store.ts` | 已落地 | 两级去重唯一口径：任务级 C.1 六元组（含 plan_hash），步级 (task_hash, step_index, observation, action) |
| `withContentHash` | `withContentHash(rec): StoreRecord` | `data/store.ts` | 已落地 | meta.c_hash 内容寻址；自身不参与重算，幂等 |
| `manifest` | `manifest(opts?): Manifest` | `data/provenance.ts` | 已落地 | world/generator/acceptor/teacher pin/控制器代码/探针集全员版本化，同输入逐字同串 |
| `audit` | `audit(records, opts?): AuditReport` | `data/audit.ts` | 已落地 | G0.4：前四项（obs 白名单/骨架重叠/模板重叠 follow/标签冲突）全 0 才 passed；坏标签 quarantine 清单带出 |
| `templateFingerprint` | `templateFingerprint(instruction): string` | `data/audit.ts` | 已落地 | 数字串归一 # 的模板指纹（指令模板重叠统计唯一口径；goal 族豁免） |
| `safeActionConflictRate` | `safeActionConflictRate(records, opts?): ConflictRateReport` | `data/provenance.ts` | 已落地 | 目标族多解诊断：先 join+on-path 过滤（缺省只统计 goal/goal_verify，includeFollow 放开），再在子池上固定 seed 抽样 ≤200 做 bounded BFS；C.8 诊断项不进门禁 |
| `stateDigest / reachesAccept` | `stateDigest(st): string; reachesAccept(graph, task, start, budget): ReachResult` | `data/conflict_bfs.ts` | 已落地 | C.4 去重键（值字段+逐算子计数，不含完整 hist）；BFS 超预算保守判不可达；plan_bfs 落地时 import 本键 |
| `main / buildTasks / loadDemoTasks` | `main(argv?): number; buildTasks(n, seed): Task[]; loadDemoTasks(path): Task[]` | `demos/generate_demo.ts` | 已落地 | style follow/goal 严格轮转 50/50，canonical Task JSONL（每行一键序稳定）；失败退出码非 0 |
| `featurizeObs` | `featurizeObs(instruction, obs: ObsView, featureSet?): Float32Array` | `controller/features.ts` | 已落地 | lang 主臂 obs=867 维（R6 词法顺序槽 +120、R7 进度对齐槽 +15）；struct/hash_only 为诊断/消融 arch；白名单只读 instruction/state，`struct` 的 goal 段由调用方经 featurizeGoalStruct 拼接 |
| `featurizeAction` | `featurizeAction(graph, nid): Float32Array` | `controller/features.ts` | 已落地 | 契约派生+哈希算子桶，ACT_DIM=83；新增算子不改宽；"any" 不置位、exit/decoy kind 独占 |
| `OBS_DIM / ACT_DIM` | `OBS_DIM: Readonly<Record<FeatureSet, number>>; ACT_DIM=83` | `controller/features.ts` | 已落地 | lang=867 / struct=875 / hash_only=671（R6 顺序槽 + R7 进度槽后）；与 Python 侧 arch 串互钉 |
| `stateStats` | `stateStats(v: unknown): readonly [number, number, number]` | `controller/features.ts` | 已落地 | 值字段统计三特征（Int 数值归一/Str 长度与字符桶）；类型 one-hot 由 featurizeState 负责 |
| `featurizeGoalStruct` | `featurizeGoalStruct(spec): Float32Array` | `controller/features_struct.ts` | 已落地 | GOAL_STRUCT_DIM=8；只进 struct 诊断 arch（G0.4 唯一例外，audit_features 执法） |
| `Policy` | `class Policy; static random(seed, featureSet?, head?); act(instr, obs, cand, graph, greedy?, rng?); save(path, trainMeta?); static load(path, expect?)` | `controller/policy.ts` | 已落地 | pointer 打分前向（hiddenOf/zOf/probsOf/scoresFromObs）；反向只在 train.py（F.1）；load 走 arch fail-fast 通道 |
| `currentArch` | `currentArch(featureSet, head): string` | `controller/checkpoint.ts` | 已落地 | v<ARCH_VERSION>:<featureSet>:<obsDim>:<ACT_DIM>:<H>:<head>，加载须逐字核对 |
| `readWeightsJson / writeWeightsJson` | `readWeightsJson(path, expect?): WeightsFile; writeWeightsJson(path, file): void` | `controller/checkpoint.ts` | 已落地 | 跨语言权重契约；arch 版本校验 fail-fast、禁跨版本静默加载（F.2）；写前先过 assertParams 形状审计 |
| `rollout` | `rollout(policy, graph, task, greedy?, maxSteps?, rng?): RolloutResult` | `runner/rollout.ts` | 已落地 | 环境循环唯一口径；成功 ⇔ accept===true（出口当刻判定）；非 greedy 采样必须显式 rng |
| `correctGold` | `correctGold(task, st, action): string | null` | `runner/dagger.ts` | 已落地 | DAgger 偏离判定唯一口径：off-prefix（isOnPath 判）一律 null 不打标；on-path 时计划耗尽取 EXIT；所选与 gold 一致返 null |
| `dagger` | `dagger(policy, options: DaggerOptions): DaggerResult` | `runner/dagger.ts` | 已落地 | C.5 on-path 干预编排：偏离处打 gold 标签、老师干预后续跑、单 rollout maxFixes=4；训练/评估出口由回调注入（本模块不 spawn Python）；stats（偏离步/首次偏离步位）供 G2.1 诊断消费，不作晋级门槛 |
| `passAt1` | `passAt1(policy, graph, tasks): {solved; total; passRate; ci95}` | `eval/metrics.ts` | 已落地 | 主指标（A.1）：greedy 每题一次，端到端成功率 + Wilson 95% CI，按 style 分开调用 |
| `pathExcess` | `pathExcess(policy, graph, tasks): {mean; successCount}` | `eval/metrics.ts` | 已落地 | 配方族相对 gold 冗余步（两侧都不含 EXIT，G2.2 同源口径）；仅统计验收通过任务 |
| `stepsOverShortest` | `stepsOverShortest(tasks, graph, solvedPlans): {meanExcess; overBudget; total}` | `eval/metrics.ts` | 已落地 | 目标族相对 BFS 穷尽最短解冗余；超预算记 ∞ 桶不 raise（C.4） |
| `routingAcc` | `routingAcc(policy, graph, tasks): {match; total}` | `eval/metrics.ts` | 已落地 | teacher-forced 逐步路由（oracleTrace 上 greedy act）；仅诊断项不入门禁；坏标签任务整任务跳过 |
| `ci95` | `ci95(p, n): [number, number]` | `eval/metrics.ts` | 已落地 | Wilson score 95% 区间钳 [0,1]；n=0 返 [0,0]；全仓唯一 CI 口径 |
| `calibrationEce` | `calibrationEce(confs, outcomes, bins?): number` | `eval/metrics.ts` | 已落地 | 等宽分桶 ECE（§7 校准列）；长度不一致即抛 |
| `beyondOracleRate` | `beyondOracleRate(tasks, graph, opts?): BeyondOracleReport` | `eval/beyond_oracle.ts` | 已落地 | G2.2 超 oracle 率（仅 follow）：逐任务 planBfs 限深 goldLen−1 早停，非 null 记命中；超预算按保守未命名单列 overBudget，不入 hits。**R5 后真实 follow 任务按定义归零**（验收要求 hist==trace，更短解不存在），手工无 trace 任务仍走完整 BFS |
| `HeuristicArm` | `class HeuristicArm { solve(task, graph): RolloutResult }` | `eval/arms.ts` | 已落地 | 仅 follow：弱词法扫描（义项首现升序，同位命中按 LEX_OPS_BASE 固定序取最小、放弃类型消歧，C.7 规格）；goal 抛 N/A（记 N/A 非 0）；零泄漏不触 plan_hidden/expected |
| `RandomArm` | `new RandomArm(seed, featureSet?)` | `eval/arms.ts` | 已落地 | 同架构 Policy.random(seed) 下界，greedy rollout；同 seed 两次 solve 逐字相同（G1.1 臂） |
| `TrainedArm` | `new TrainedArm(policy); static fromWeights(path, expect?)` | `eval/arms.ts` | 已落地 | 训练产物臂唯一入口；fromWeights 走 Policy.load arch fail-fast（F.2） |
| `PlannerArm` | `class PlannerArm { solve(task, graph): RolloutResult }` | `eval/arms.ts` | 已落地 | 仅 goal：planBfs 公开规划上界（G1.3 必含臂）；无解/超预算记 accepted=false；follow N/A；产出永不回灌训练（E.13） |
| `ContractRouteArm` | `class ContractRouteArm { solve(task, graph): RolloutResult }` | `eval/contract_route.ts` | 已落地 | 两 style 廉价机制臂：公开契约反向链贪心，零学习零泄漏；对照列不进主指标；经 eval/arms.ts re-export |
| `evaluateArm / defaultArms` | `evaluateArm(arm, tasks, graph, style): ArmReport; defaultArms(randomSeed?, trained?): readonly EvalArm[]` | `eval/arms.ts` | 已落地 | 按 style 分报的统计口径（策略臂包 passAt1、replay 臂自数 accepted 共用 ci95）；N/A 不跑 solve，与 0 分严格区分 |
| `featurizeRecords` | `featurizeRecords(records, featureSet?): BinRow[]` | `data/records.ts` | 已落地 | store 原始 obs → (obs, cand_mask, target_idx) 派生行；含 CLI main；动作表 actionFeatureTable() |
| `writeRecordsBin / readRecordsBin` | `writeRecordsBin(path, rows, obsDim, actFeats): void; readRecordsBin(path): BinFile` | `data/records_bin.ts` | 已落地 | records.bin 跨语言契约（magic+版本+act 表）；train.py 只读，header obsDim 与 arch 互钉 |
| `bc_train` | `bc_train(D, val_D, act_table, epochs=30, patience=4, min_epochs=5, min_delta=1e-4, seed=0, batch=512, lr_schedule="cosine", head="progress", save_last_k=5)` | `controller/train.py` | 已落地 | 纯拟合、不触环境/rollout（F.1 语言分工）；val CE 早停恢复 best；落最近 K epoch 快照供 TS 按 held-out/val pass@1 选点（C.7）；train.py CLI main(argv?)：--train/--val/--out/--loss |
| `val_ce` | `val_ce(params, rows, act_table): float` | `controller/train.py` | 已落地 | 早停指标（连续 CE，非 route_acc）；batches/snapshot 非公开符号（bc_train 内联） |
| `Adam` | `class Adam(params); step(params, grads, lr)` | `controller/train_nn.py` | 已落地 | 矩估计优化器；numpy-only；二次函数收敛测试 |
| `check_numeric_gradient` | `check_numeric_gradient(seed=7, delta=1e-5, verbose=True)` | `controller/train_nn.py` | 已落地 | 变长 mask backward 数值梯度校验：‖∇num−∇ana‖/‖∇num‖ < 1e-5（D 表断言）；经 train.py --check-grad 暴露 |
| `memory_selftest` | `memory_selftest(seed=0, batch=32, epochs_cap=4000, lr=3e-3, verbose=True)` | `controller/train_nn.py` | 已落地 | 记忆 32 例 → train acc ≥ 0.99 的拟合能力自检；经 train.py --selftest 暴露 |
| `collectReinforceRows` | `collectReinforceRows(policy, tasks, opts?): CollectResult` | `eval/reinforce.ts` | 已落地 | G2.3 采样轨迹 → 优势标签行（非 greedy 需 seed rng；baseline=滑动均值 200、排除当前；单候选步不入集）；行经 recordFromStep/featurizeRecord 唯一口径产出 |
| `slidingBaseline` | `slidingBaseline(rewards, window=200): number` | `eval/reinforce.ts` | 已落地 | 最近 window 条 rollout 奖励均值；调用方在推入当前奖励前取值，自然排除自身（防优势泄漏） |
| `ReinforceArm` | `class ReinforceArm { policy; solve(task, graph?); static evaluate(arm, tasks, graph?) }` | `eval/reinforce.ts` | 已落地 | G2.3 对照臂：白手起家随机初始化、greedy 评测走 passAt1；不从 BC checkpoint 热启（A.2）；lr=1e-3/β_ent=0.01/batch=512 在 Python 侧 |
| `writeReinforceFile` | `writeReinforceFile(path, rows, featureSet?)` | `eval/reinforce.ts` | 已落地 | reinforce.bin 写盘收敛口；obsDim 取自 featureSet，动作表 actionFeatureTable() 唯一源 |
| `writeReinforceBin / readReinforceBin` | `writeReinforceBin(path, rows, obsDim, actFeats); readReinforceBin(path): ReinforceFile` | `data/reinforce_bin.ts` | 已落地 | reinforce.bin v1 字节契约（magic DGLR）：header 动作表 + 稀疏 obs/掩码 + 采样动作本地下标 + advantage/reward；magic/版本/越界/NaN fail-fast |
| `backward_reinforce` | `backward_reinforce(params, o, a, mask, action_idx, advantage, beta_ent=0.01): grads` | `controller/reinforce_nn.py` | 已落地 | 策略梯度余量 g=advantage·p−advantage·δ+β·p·(logp+H)，回传链与 BC 反向同构；无 value head、无权重衰减（A.2） |
| `check_numeric_gradient_reinforce` | `check_numeric_gradient_reinforce(seed=7, delta=1e-6): bool` | `controller/reinforce_nn.py` | 已落地 | 策略梯度链中心差分自检，相对范数差 <1e-5（小维模型逐元素）；CLI `python controller/reinforce_nn.py` 退出码即判 |

## T2 其余 helper（随各自 Phase 0 文件补齐）

| 符号 | 签名 | 文件 | 状态 | 语义/边界 |
|---|---|---|---|---|
| `sample_value` | `sampleValue(rng, root): number | string` | `world/operators.ts` | 已落地 | Int 全域 -50..50；Str 长度 1..8 的 a-h |
| `init_state` | `initState(x, spec?): State` | `world/operators.ts` | 已落地 | {x, answer:null, verdict:null, hist:[], spec:{}} |
| `apply_op` | `applyOp(graph, nid, st): State | null` | `world/operators.ts` | 已落地 | 契约闸+变换+hist 追加；null=死路；check_* 通过写 verdictPass(x)="pass:"+hash8(x)，不通过写 "fail" |
| `run_plan` | `runPlan(plan, st): State | null` | `world/operators.ts` | 已落地 | 顺序回放，不写 expected；submit→check 间 x 不变 ⇒ verdict 与 answer 指纹恒一致 |
| `obs_snapshot` | `obsSnapshot(st): object` | `world/operators.ts` | 已落地 | 只投影 x/answer/verdict/hist |
| `accept / acceptor_view` | `accept(task, st): boolean; acceptorView(task)` | `verify/acceptor.ts` | 已落地 | 通道收口；两生产者族 verdict 判定 = verdictPass(answer)（旧 verdict 复用因指纹漂移必拒，R2-P0-1）；**R5 轨迹约束**：follow 族（spec.trace 存在）另要求 hist==trace 精确匹配，终值对但轨迹不符必拒；goal 族无轨迹约束（多解合法） |
| `CHANNEL` | `Readonly<Record<Family, readonly string[]>>` | `verify/acceptor.ts` | 已落地 | 通道表唯一真源；value/goal 单生产者，verify/goal_verify 双生产者 |
| `acceptChannelled` | `acceptChannelled(task, st): Verdict` | `verify/acceptor.ts` | 已落地 | 只读本族通道字段；缺失即 reason=missing:<field> |
| `WRONG_ARTIFACTS` | `readonly AdversarialCase[]` | `verify/adversarial.ts` | 已落地 | 空值/语义错/复述原题/硬编码常量+旧 verdict 复用新口径（先 check 后改值再 submit、跨任务搬运指纹、裸 "pass" 旗标——answer 达标也必拒）；**R5 增轨迹不符类**（终值对+指纹对但 hist≠spec.trace 的恒等绕路/等价重排必拒） |
| `runAll` | `runAll(): {rejectRatio; acceptCorrectRatio; caseCount}` | `verify/adversarial.ts` | 已落地 | 错误产物全拒 + 正确通道全收 + 固定 seed fuzz |
| `FUZZ_COUNT` | `number` | `verify/adversarial.ts` | 已落地 | runAll 固定 seed 补刀错误产物条数 = 24 |
| `runSandboxed` | `runSandboxed(code, tests, timeoutS?): Promise<{ok; output}>` | `verify/sandbox.ts` | 已落地 | 接口占位；代码族验证未启用，调用即抛错 |
| `plan_bfs` | `planBfs(task, graph, opts?): string[] | null` | `teacher/search.ts` | 已落地 | BFS 最短解；去重键复用 data/conflict_bfs.ts 的 stateDigest（C.4 唯一口径）；仅可解性 QA/上界诊断，不进训练集。**R5**：follow 族（spec.trace 存在）沿 trace 前缀剪枝，解唯一 = trace（等长，G2.2 归零），maxDepth 语义不变；goal 族走完整 BFS |
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
