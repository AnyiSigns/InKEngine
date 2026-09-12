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
  { name: 'hash8', signature: 'hash8(o: unknown): string', file: 'world/hash.ts', status: '已落地', note: 'hashObj[:8]；B.4 verdict 指纹唯一截断口径' },
  { name: 'OPS', signature: 'readonly Contract[]', file: 'world/operators.ts', status: '已落地', note: 'B.2 契约表真源，表序即基础顺序' },
  { name: 'NODES_BASE', signature: 'readonly string[]', file: 'world/operators.ts', status: '已落地', note: '[entry, ...OPS, exit]，槽位依赖此序' },
  { name: 'ROUTING', signature: 'readonly string[]', file: 'world/operators.ts', status: '已落地', note: '去 entry 排序，22 项' },
  { name: 'LEX_OPS_BASE', signature: 'readonly string[]', file: 'world/operators.ts', status: '已落地', note: 'op+terminal id，义项槽冻结' },
  { name: 'MAX_REPEAT', signature: 'number', file: 'world/operators.ts', status: '已落地', note: '单节点访问上限 = 2' },
  { name: 'contractOf', signature: 'contractOf(id): Contract | undefined', file: 'world/operators.ts', status: '已落地', note: '按 id 取契约' },
  { name: 'requiresTypes', signature: 'requiresTypes(c): TypeName[]', file: 'world/operators.ts', status: '已落地', note: '并集去重、剔除 "any"' },
  { name: 'requiresOk', signature: 'requiresOk(c, state): boolean', file: 'world/operators.ts', status: '已落地', note: '字段存在 + 类型命中 + when' },
  { name: 'emod', signature: 'emod(a, m): number', file: 'world/operators.ts', status: '已落地', note: '非负取模，禁裸 %' },
  { name: 'verdictPass', signature: 'verdictPass(v: unknown): string', file: 'world/operators.ts', status: '已落地', note: 'check_* 通过写 "pass:"+hash8(v)；accept 据此绑定 answer 指纹（R2-P0-1）' },
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
  { name: 'MAX_DEPTH', signature: 'number', file: 'gen/skeletons.ts', status: '已落地', note: 'C.1 深度上限 = 5（不含终算子）' },
  { name: 'PROBE_INT / PROBE_STR', signature: 'readonly (number|string)[]', file: 'gen/skeletons.ts', status: '已落地', note: 'Int 全域 101 点；Str 固定十串' },
  { name: 'enumerateSkeletons', signature: 'enumerateSkeletons(maxDepth?): Skel[]', file: 'gen/skeletons.ts', status: '已落地', note: '只取 kind=op，终算子不入池；前缀增量探针向量，勿逐骨架重放' },
  { name: 'signature', signature: 'signature(root, skeleton): Sig', file: 'gen/skeletons.ts', status: '已落地', note: 'Int 全域探针可证正确；Str 固定探针' },
  { name: 'dedupeBySignature', signature: 'dedupeBySignature(skels): Skel[]', file: 'gen/skeletons.ts', status: '已落地', note: '同签名留最短、同长取字典序首；纯函数，恒等过滤只在 SKELETONS 构造层' },
  { name: 'isIdentity', signature: 'isIdentity(root, skeleton): boolean', file: 'gen/skeletons.ts', status: '已落地', note: '全探针值不变判恒等（[neg,neg]/[reverse,reverse] 真）；SKELETONS 不含恒等签名（R2-P0-3，其 0-op 解任务必抬 G2.2）' },
  { name: 'SKELETONS', signature: 'readonly Skel[]', file: 'gen/skeletons.ts', status: '已落地', note: '模块级一次性计算：去冗余后、恒等签名丢弃后的全量骨架池' },
  { name: '_skelId', signature: '_skelId(sk): string', file: 'gen/skeletons.ts', status: '已落地', note: 'hashObj([root, plan])，composition_id 口径' },
  { name: '_stratum / STRATA', signature: '_stratum(sk): StratumKey; STRATA: ReadonlyMap', file: 'gen/splits.ts', status: '已落地', note: '分层键 = 深度 × 是否含 cond' },
  { name: 'codepointCompare', signature: 'codepointCompare(a, b): number', file: 'gen/splits.ts', status: '已落地', note: '码点序唯一口径；localeCompare 依赖 locale，禁用于确定性排序' },
  { name: '_splitMaps', signature: '_splitMaps(strata?): {heldout; val}', file: 'gen/splits.ts', status: '已落地', note: '每层 heldout≈20%/val≈5%、保底 ≥1；层内 <2 报错' },
  { name: 'HELDOUT_SKELETONS / VAL_SKELETONS', signature: 'ReadonlySet<string>', file: 'gen/splits.ts', status: '已落地', note: 'composition_id 注册表，与 train 零重叠' },
  { name: 'splitOf', signature: 'splitOf(sk): Split', file: 'gen/splits.ts', status: '已落地', note: 'train/val/heldout 归属，切分只看骨架' },
  { name: 'sampleGoal', signature: 'sampleGoal(rng, root): Goal', file: 'gen/generator.ts', status: '已落地', note: 'Int parity/gt，Str len；40% 合取强制多步规划' },
  { name: 'goalProbeHit', signature: 'goalProbeHit(root, plan, goal): boolean', file: 'gen/producibility.ts', status: '已落地', note: '单目标可达性探针；Int instance_goal 精确剪枝，Str 只提示；经 generator.ts 公开' },
  { name: 'GOAL_PROBE_GOALS', signature: 'readonly Goal[]', file: 'gen/producibility.ts', status: '已落地', note: '适格性判定池（sampleGoal 四单体采样器全集 7 项，按 root 型别子集使用）' },
  { name: 'goalEligible', signature: 'goalEligible(root, skeleton): boolean', file: 'gen/producibility.ts', status: '已落地', note: '族适格性（R2-P0-2）：存在「初始不达标∧终值达标」对；长度不变/str_len 收尾/值单调类判不适格，goal 域两族采样只走适格池；Int 全域精确' },
  { name: 'isGoalDomain', signature: 'isGoalDomain(family): boolean', file: 'gen/producibility.ts', status: '已落地', note: 'goal 与 goal_verify 同池采目标，适格性对两族一致（伪代码字面 fam!="goal" 漏掉 goal_verify，落地按语义补齐）' },
  { name: 'coverageKey', signature: 'coverageKey(style, family, compositionId): string', file: 'gen/producibility.ts', status: '已落地', note: '`style:family:composition_id` 稳定键' },
  { name: 'hasOneStepSolution', signature: 'hasOneStepSolution(task, graph): boolean', file: 'gen/producibility.ts', status: '已落地', note: '关死单步 echo/submit 捷径；O(|candidates|) apply+accept；经 generator.ts 公开' },
  { name: 'hasShortcut', signature: 'hasShortcut(task, graph): boolean', file: 'gen/producibility.ts', status: '已落地', note: 'follow 极小性守卫（R2-P0-3）：单算子+收尾提交过验收且严格短于金计划 → 非最小，换 witness' },
  { name: 'UNPRODUCIBLE_HELDOUT', signature: 'ReadonlySet<string>', file: 'gen/producibility.ts', status: '已落地', note: 'heldout 不适格注册表，goal 两族键由 goalEligible 派生（薄层视图，无第二套判定）；follow 判入册仅兜底、按构造恒空' },
  { name: 'instanceFollow / instanceGoal', signature: 'instanceFollow(...); instanceGoal(...)', file: 'gen/generator.ts', status: '已落地', note: 'public spec + hidden gold；回放穿 accept 才返回' },
  { name: 'STYLES / instanceTask', signature: 'STYLES: Record<Style, Family[]>; instanceTask(...)', file: 'gen/generator.ts', status: '已落地', note: 'follow→value/verify；goal→goal/goal_verify' },
  { name: 'makeTask', signature: 'makeTask(seed, style?, family?, split?, skeleton?): Task | null', file: 'gen/generator.ts', status: '已落地', note: '同 seed 完全确定；可钉骨架/族/切分；goal 域族抽样只走适格池，钉入不适格骨架即返回 null' },
  { name: 'makeSplit', signature: 'makeSplit(split, perFamily, seed?, maxPerSkeleton?): Task[]', file: 'gen/generator.ts', status: '已落地', note: '配额制；goal 域族只走适格池（R2-P0-2），适格池空/配额不足抛错不静默；follow 产出经 hasShortcut 极小性守卫' },
  { name: 'makeCoverageSplitInfo', signature: 'makeCoverageSplitInfo(split, seed?, skeletons?): {tasks; unproducible; unproducibleCount; ineligible; ineligibleCount}', file: 'gen/generator.ts', status: '已落地', note: 'follow 全域 + goal 适格池每骨架每 (style,family) 恰 1 条；goal 域族覆盖声明缩到适格池，ineligible 清单与计数显式上报（R2-P0-2 不静默）；适格池产不出/注册表含 follow 键均抛错；骨架池可注入' },
  { name: 'makeCoverageSplit', signature: 'makeCoverageSplit(split, seed?): Task[]', file: 'gen/generator.ts', status: '已落地', note: 'makeCoverageSplitInfo 的任务列表口径（C.1 签名保持）' },
  { name: 'GRAPH', signature: 'Graph', file: 'runner/graph.ts', status: '已落地', note: 'OPS/NODES_BASE 组装；entry/exit kind=structural（无契约，不参与契约/动作分类）' },
  { name: 'candidates', signature: 'candidates(graph, st, hist): string[]', file: 'runner/graph.ts', status: '已落地', note: 'entry 禁入；exit 恒在；访问上限唯一实现' },
  { name: 'MAX_STEPS', signature: 'number', file: 'runner/graph.ts', status: '已落地', note: 'C.7/E.14 唯一口径 = 12' },
  { name: 'oracleTrace', signature: 'oracleTrace(task, graph): Step[]', file: 'teacher/oracle.ts', status: '已落地', note: 'C.3 逐步 on-path 标签；断言候选内/非死路/末步 EXIT/回放穿验收；obs 走白名单投影' },
  { name: 'isOnPath', signature: 'isOnPath(hist, plan): boolean', file: 'teacher/oracle.ts', status: '已落地', note: 'gold 前缀唯一判定源（标签纪律；DAgger 侧复用）' },
  { name: 'recordFromStep', signature: 'recordFromStep(task, step, extraMeta?): StoreRecord', file: 'data/store.ts', status: '已落地', note: 'F.2 原始 obs 记录；meta 只带派生指纹（expected/spec/plan 原值绝无写入路径）' },
  { name: 'append / load', signature: 'append(records, opts?): AppendResult; load(split, opts?): StoreRecord[]', file: 'data/store.ts', status: '已落地', note: '内容寻址 canonical-JSONL 分片按 (world_version, split, family)；对盘上既有步级去重；坏行 fail-fast（load 追加 style/family 值域与 meta.c_hash 复核，报错含分片#行号；校验内核 data/store_schema.ts 唯一口径）' },
  { name: 'dedup / taskDedupKey / stepDedupKey', signature: 'dedup(items); taskDedupKey(task); stepDedupKey(rec)', file: 'data/store.ts', status: '已落地', note: '两级去重唯一口径：任务级 C.1 六元组（含 plan_hash），步级 (task_hash, step_index, observation, action)' },
  { name: 'withContentHash', signature: 'withContentHash(rec): StoreRecord', file: 'data/store.ts', status: '已落地', note: 'meta.c_hash 内容寻址；自身不参与重算，幂等' },
  { name: 'manifest', signature: 'manifest(opts?): Manifest', file: 'data/provenance.ts', status: '已落地', note: 'world/generator/acceptor/teacher pin/控制器代码/探针集全员版本化，同输入逐字同串' },
  { name: 'audit', signature: 'audit(records, opts?): AuditReport', file: 'data/audit.ts', status: '已落地', note: 'G0.4：前四项（obs 白名单/骨架重叠/模板重叠 follow/标签冲突）全 0 才 passed；坏标签 quarantine 清单带出' },
  { name: 'templateFingerprint', signature: 'templateFingerprint(instruction): string', file: 'data/audit.ts', status: '已落地', note: '数字串归一 # 的模板指纹（指令模板重叠统计唯一口径；goal 族豁免）' },
  { name: 'safeActionConflictRate', signature: 'safeActionConflictRate(records, opts?): ConflictRateReport', file: 'data/provenance.ts', status: '已落地', note: '目标族多解诊断：先 join+on-path 过滤（缺省只统计 goal/goal_verify，includeFollow 放开），再在子池上固定 seed 抽样 ≤200 做 bounded BFS；C.8 诊断项不进门禁' },
  { name: 'stateDigest / reachesAccept', signature: 'stateDigest(st): string; reachesAccept(graph, task, start, budget): ReachResult', file: 'data/conflict_bfs.ts', status: '已落地', note: 'C.4 去重键（值字段+逐算子计数，不含完整 hist）；BFS 超预算保守判不可达；plan_bfs 落地时 import 本键' },
  { name: 'main / buildTasks / loadDemoTasks', signature: 'main(argv?): number; buildTasks(n, seed): Task[]; loadDemoTasks(path): Task[]', file: 'demos/generate_demo.ts', status: '已落地', note: 'style follow/goal 严格轮转 50/50，canonical Task JSONL（每行一键序稳定）；失败退出码非 0' },
];

const PENDING: readonly HelperRow[] = [
  { name: 'sample_value', signature: 'sampleValue(rng, root): number | string', file: 'world/operators.ts', status: '已落地', note: 'Int 全域 -50..50；Str 长度 1..8 的 a-h' },
  { name: 'init_state', signature: 'initState(x, spec?): State', file: 'world/operators.ts', status: '已落地', note: '{x, answer:null, verdict:null, hist:[], spec:{}}' },
  { name: 'apply_op', signature: 'applyOp(graph, nid, st): State | null', file: 'world/operators.ts', status: '已落地', note: '契约闸+变换+hist 追加；null=死路；check_* 通过写 verdictPass(x)="pass:"+hash8(x)，不通过写 "fail"' },
  { name: 'run_plan', signature: 'runPlan(plan, st): State | null', file: 'world/operators.ts', status: '已落地', note: '顺序回放，不写 expected；submit→check 间 x 不变 ⇒ verdict 与 answer 指纹恒一致' },
  { name: 'obs_snapshot', signature: 'obsSnapshot(st): object', file: 'world/operators.ts', status: '已落地', note: '只投影 x/answer/verdict/hist' },
  { name: 'accept / acceptor_view', signature: 'accept(task, st): boolean; acceptorView(task)', file: 'verify/acceptor.ts', status: '已落地', note: '通道收口；两生产者族 verdict 判定 = verdictPass(answer)（旧 verdict 复用因指纹漂移必拒，R2-P0-1）' },
  { name: 'CHANNEL', signature: 'Readonly<Record<Family, readonly string[]>>', file: 'verify/acceptor.ts', status: '已落地', note: '通道表唯一真源；value/goal 单生产者，verify/goal_verify 双生产者' },
  { name: 'acceptChannelled', signature: 'acceptChannelled(task, st): Verdict', file: 'verify/acceptor.ts', status: '已落地', note: '只读本族通道字段；缺失即 reason=missing:<field>' },
  { name: 'WRONG_ARTIFACTS', signature: 'readonly AdversarialCase[]', file: 'verify/adversarial.ts', status: '已落地', note: '空值/语义错/复述原题/硬编码常量+旧 verdict 复用新口径（先 check 后改值再 submit、跨任务搬运指纹、裸 "pass" 旗标——answer 达标也必拒）' },
  { name: 'runAll', signature: 'runAll(): {rejectRatio; acceptCorrectRatio; caseCount}', file: 'verify/adversarial.ts', status: '已落地', note: '错误产物全拒 + 正确通道全收 + 固定 seed fuzz' },
  { name: 'FUZZ_COUNT', signature: 'number', file: 'verify/adversarial.ts', status: '已落地', note: 'runAll 固定 seed 补刀错误产物条数 = 24' },
  { name: 'runSandboxed', signature: 'runSandboxed(code, tests, timeoutS?): Promise<{ok; output}>', file: 'verify/sandbox.ts', status: '已落地', note: '接口占位；代码族验证未启用，调用即抛错' },
  { name: 'plan_bfs', signature: 'planBfs(task, graph, nodeBudget?): string[] | null', file: 'teacher/search.ts', status: '待 Phase 0', note: 'BFS 最短解（去重键复用 data/conflict_bfs.ts 的 stateDigest，C.4 同源）；不进训练集' },
  { name: 'featurize_* / OBS_DIM / ACT_DIM', signature: 'featurizeInstr/State/Action; OBS_DIM=724; ACT_DIM=83', file: 'controller/features.ts', status: '待 Phase 0', note: '白名单只读 instruction/state' },
  { name: 'Policy.forward/backward/act/save/load', signature: 'Policy', file: 'controller/policy.ts', status: '待 Phase 0', note: 'pointer 打分；数值梯度校验' },
  { name: 'val_ce / batches / snapshot', signature: 'valCe(policy, D): number; batches(D, n); snapshot(policy)', file: 'controller/train.py', status: '待 Phase 0', note: '训练器内层；仅 numpy' },
  { name: 'trainPython / loadWeights', signature: 'trainPython(D, valD): string; loadWeights(path): Policy', file: 'controller/train.py', status: '待 Phase 0', note: '唯一跨语言接口 records.bin/weights.json' },
  { name: 'recordOf / samePrefix', signature: 'recordOf(st, cand, target); samePrefix(hist, plan, k)', file: 'runner/dagger.ts', status: '待 Phase 0', note: 'on-path 判定；off-prefix 不打标；samePrefix 复用 teacher/oracle.isOnPath，禁止第二份判定源' },
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
