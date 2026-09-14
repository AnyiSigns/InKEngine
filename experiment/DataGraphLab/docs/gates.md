# DataGraphLab 门禁判定脚本规格（G0.1–G0.6、G1.1–G1.3、G2.2、F1–F4）

> 本文件是**判定口径**（输入/算法/输出/判据/落点），不是实现稿。所有门禁共享
> 一套 harness；判据只许引用冻结 fixture 与实测值，**禁止手写期望数字**。
> 门禁脚本与参考实现同仓；本规格先行，`conformance/gates/` 与 `npm run gate` 随
> Phase 0 落地，届时由 `tests/` 同步断言、`npm test` 可复算。

---

## 0. 共享 harness 契约

### 0.1 落点

| 件 | 路径 | 职责 |
|---|---|---|
| harness | `conformance/gates/harness.ts` | 统一执行、写结果、判 exit code |
| 门禁实现 | `conformance/gates/g0N_*.ts` / `g1N_*.ts` / `g2N_*.ts` | 每门禁一个 `run(ctx): GateResult`；G2.2 判定式在 `eval/beyond_oracle.ts` |
| 证据读取 | `conformance/gates/results_view.ts` | G1.2/G1.3 共享的 `results.json` 只读视图（唯一实现） |
| 结果 | `runs/<run_id>/gates/G0.N.json` | 机器可读证据（长表另存 csv） |
| 金标 | `conformance/fixtures.json` | 哈希/随机/渲染的冻结真值 |
| 断言 | `tests/gates.test.ts` | 把每个 `run()` 包成 vitest 用例 |

### 0.2 `GateResult`（唯一输出 JSON 形状，fail-fast）

```typescript
interface GateResult {
  gate: 'G0.1' | 'G0.2' | 'G0.3' | 'G0.4' | 'G0.5' | 'G0.6' | 'G1.1' | 'G1.2' | 'G1.3' | 'G2.1' | 'G2.2' | 'G2.3' | 'F1' | 'F2' | 'F3' | 'F4';
  version: number;              // 判定脚本语义版本，改动即 +1
  world_version: string;        // = world/operators 契约表 hash
  seeds: number[];              // 本次使用的全部种子
  inputs_hash: string;          // 输入指纹（hashObj，规范序列化）
  metrics: Record<string, number>;    // 判据用到的全部实测值
  thresholds: Record<string, number>; // 对应阈值，原样记录
  passed: boolean;              // 全部 metrics 满足 thresholds
  artifacts: string[];          // 证据文件（相对仓库根）
  notes?: string;               // 失败模式，不许隐藏
}
```

### 0.3 harness 规则

1. `runAll(ctx)` 依次跑 G0.1→G1.3、G2.2 与 F1→F4；任一 `passed=false` 则整体 exit 1，但**继续跑完**
   并写全部结果（失败也要报告，附录 E.7）。
2. 所有随机显式 `makeRng(seed)`；所有哈希 `hashObj`/`crc32`；禁止 `Math.random` 与
   内置 `hash()`（E.8）。
3. 门禁零网络、零 LLM；G0.6 只用公开指令特征，绝不读 `spec.goal`。
4. `inputs_hash` 必须含 `world_version` + 数据集 manifest hash + fixture hash；
   任一变化使历史结果不可复用（可追溯）。
5. 阈值写死在门禁脚本内并同步进 `thresholds`，**不达标不许改阈值**，先出失败模式
   （表示容量 / 数据覆盖 / 目标可达性三分诊断）。

---

## G0.1 生成确定性（determinism）

- **输入**：`(seed, style, family, split?)`；`world_version`；冻结 fixture 的 `rng`/`crc32`/`canonical` 三段。
- **算法**：
  1. 在两个独立进程各跑 `make_task(seed, ...)`（同参），取全部 `task_hash`；
  2. 序列化为规范 JSON（键排序），逐字节比较两进程输出；
  3. 对 fixture 中的 `makeRng(seed).next()`、`crc32(s)`、`canonicalJson(edge)` 复算比对。
- **输出 metrics**：`hash_match_ratio`、`process_case_count`、`fixture_match_count`、`fixture_case_count`。
- **通过判据**：`hash_match_ratio == 1` 且 `fixture_match_count == fixture_case_count`。
- **落点**：`conformance/gates/g01_determinism.ts`；断言于 `tests/gates.test.ts`。

## G0.2 生成可解（solvability）

- **输入**：全部 emitted task（生成器 + 公开 acceptor）。
- **算法**：对每个 task 用 hidden `plan_hidden` 回放 `run_plan`，再经 `accept(task, state)`；
  终算子只由 `make_task` 按族追加（`submit`；verify 族追加对应 `check_*`）。
- **输出 metrics**：`solvable_ratio`、`task_count`、`replay_fail_count`。
- **通过判据**：`solvable_ratio == 1`。
- **落点**：`conformance/gates/g02_solvable.ts`。

## G0.3 验收抗投喂（adversarial）

- **输入**：`verify/adversarial.ts` 的 `WRONG_ARTIFACTS`（空值、类型对语义错、旧 verdict
  复用、直接复述原题、硬编码常量）+ 固定 seed 的 fuzz 错误产物。
- **算法**：对每个错误产物构造 state 跑 `accept`；同时用**正确通道产物**跑正例确认
  验收可被正确喂饱（避免“全拒”通过）。
- **输出 metrics**：`reject_ratio`、`accept_correct_ratio`、`case_count`、`wrong_static_count`、`fuzz_count`。
- **通过判据**：`reject_ratio == 1` 且 `accept_correct_ratio == 1`。
- **落点**：`conformance/gates/g03_adversarial.ts`。

## G0.4 泄漏审计（leakage）

- **输入**：`records.jsonl` + `manifest.json`；主臂特征白名单；held-out 骨架注册表。
- **算法**：
  1. 断言 `expected`/`spec`/`plan_hidden`/`plan_hash`/`seed` 不在 `obs_snapshot` 与
     主臂 `featurize_*` 的输入（`struct` 诊断 arch 的单例外单独标注）；
  2. train/held-out 的 `composition_id`（骨架）集合交集为空；指令模板指纹（follow
     族、数字掩码后）无重叠——goal 族模板跨骨架复用是多解设计语义，不计泄漏；
  3. 抽样把 oracle 标签回放穿验收，冲突标签进 quarantine。
- **输出 metrics**：`feature_leak_count`、`skeleton_overlap_count`、`template_overlap_count`、
  `label_conflict_count`、`quarantined_count`。
- **通过判据**：前四项均为 0（`quarantined_count` 允许 >0，属正常隔离）。
- **落点**：`conformance/gates/g04_leakage.ts`；对应 `data/provenance.ts` 的 `audit()`。

## G0.5 分布对齐（KL）

> 约定必须写死，否则“KL<0.05”本身不可复算。

- **输入**：train 与 heldout 的任务流；同一 `STRATA` 定义（`(depth, has_cond)`）。
- **算法**：
  1. 统计 train/heldout 在各层的任务计数，得到 `P=train`、`Q=heldout` 两个分布；
  2. **方向**：`KL(P‖Q)`（P 在前，Q 在后）；
  3. **平滑**：两分布各加 `α=0.5`（Laplace/Lidstone），再各自归一化：`p'=(n_p+α)/(N+αK)`；
  4. **空 bin**：`K` 取并集层数；某层在两者计数都为 0 时不计入 K；某层只在单侧为 0
     由平滑处理；总计数 `N==0` 则 fail-fast（不静默返回 0）；
  5. **对数底**：自然对数（单位 nats）；
  6. sanity：另报 goal 族 **gold 骨架分布**（覆盖声明的真正证据），仅入 `metrics`
     与 `artifacts`，不作门禁。
- **输出 metrics**：`kl_nats`、`strata_count`、`train_n`、`heldout_n`、`alpha`；
  附加 `gold_skeleton_js_divergence`（sanity，不判失败）。
- **通过判据**：`kl_nats < 0.05`。
- **落点**：`conformance/gates/g05_kl.ts`；由 `gen/splits.ts` 的 `STRATA` 同源提供分布。

## G0.6 目标可分性（goal separability，Phase 0 硬门禁）

> 只用**公开指令**判定目标类别；不达标先改编码器，**不许带表示瓶颈进 Phase 1**。

- **输入**：
  - 数据：`make_split('train'|'val', per_family=...)` 的 goal / goal_verify 任务；
  - 特征：`lang` 特征集的公开子集 = `GOAL_LEX(parity/gt/len)` 命中 + `NUM` 阈值/端点
    + `hash` 词袋；**不含** `MENTION`（那是配方族主信息）、不含 `spec`/`goal`/`expected`；
  - 标签：目标类别 `{parity, gt, len, all}`（由 `task.spec.goal.kind` 取得，仅作训练标签）。
- **划分**：按 `composition_id`（骨架）分层；held-out 每类 ≥30，且与 train 骨架零重叠。
- **分类器**：同架构 pointer 的**线性 softmax**（等价于词袋 + 数值的 multinomial
  logistic regression），TS 实现、全批梯度下降、`float32`；
  超参：`lr=3e-3`、`batch=512`、`epochs≤200`、`patience=10`（val CE）、`label_smoothing=0.05`、
  `weight_decay=1e-4`，`seed ∈ {0,1,2,3,4}`。
- **算法**：分类器固定超参、`seed ∈ {0..4}` 各训练+评测一次 → 每次在 held-out 取
  argmax 类别统计 top-1 准确率 → **五 seed 取均值口径**（`top1_acc_mean`，标准差
  `top1_acc_std`；与实现一致，无「单跑一次」口径）。
- **输出 metrics**：`top1_acc_mean`、`top1_acc_std`、`n_classes`、`heldout_per_class`、
  `encoder_iteration`（编码器迭代轮次 M）。
- **通过判据**：`top1_acc_mean ≥ 0.90`（首轮目标，实测后校准并原样记录）。
- **预注册升级规则**：编码器迭代上限 `M` 轮仍不达标 → 把 `struct`（含公开 `spec.goal`
  紧凑编码）提为**并列主臂**并在报告显式标注 benchmark 语义变化；**禁止静默替换主臂**。
- **落点**：`conformance/gates/g06_goal_separability.ts`。

---

## G1.1 非免费午餐（no free lunch）

> 未训练的随机权重不许白拿端到端成功；越线说明世界存在捷径/泄漏/目标过易。

- **输入**：C.8 统计集口径的 heldout 批次——
  `makeSplit('heldout', perFamily=min(max(30, |HELDOUT_SKELETONS|), 300), seed=0)`，
  经 `ctx.genTasks` 同口径缓存；`RandomArm(seed=42)`（同架构随机权重）；`GRAPH`。
- **算法**：`evaluateArm` 两 style 各评一次 greedy pass@1（每题一次，主指标走
  `passAt1`/`ci95` 唯一口径，禁本地重写）。
- **输出 metrics**：`pass1_follow`、`pass1_goal`、`n_follow`、`n_goal`、`seed`（臂 seed=42）。
- **通过判据**：`pass1_follow ≤ 0.05` **且** `pass1_goal ≤ 0.05`（同时成立）。
- **失败模式**：任一 style 越线 → FAIL（notes 报两 style 实测与 CI）。**不许改阈值**
  （A.2/E.7）；先查 G0.4 泄漏审计与 C.1 极小性守卫（`hasShortcut`/`hasOneStepSolution`），
  失败也要报告。
- **落点**：`conformance/gates/g11_no_free_lunch.ts`；断言于 `tests/gates.test.ts`
  （真实 held-out 全量，timeout 240 s）。

## G1.2 主目标（A.1 判定式）

> 判据全部来自 C.8 scaling 产物 `results.json` 长表，本门禁是**证据复核者**，
> 不自己评测；读取/聚合唯一口径在 `results_view.ts`。

- **输入**：`ctx.resultsPath` 指向 `runs/scale-<stamp>/results.json`（`createGateContext`
  可显式注入 `{resultsPath}`——测试合成 fixture 走这道口；缺省自动扫 `runs/` 下
  `scale-*`/`scale_*` 目录名最大 stamp 者，最新目录缺 `results.json` **不回退旧 run**）。
  行契约（与 scale 侧同源）：`rows: [{N, seed, style, arm, metric, value, ci_lo, ci_hi, n}]`。
- **算法与判据**（主指标 = `arm==trained`、`metric==pass1` 行的跨 seed 均值，
  C.8 均值口径）：
  1. `S_goal(10_000) ≥ 0.50`（目标式主指标）；
  2. `S_follow(10_000) ≥ 0.80`（配方式）；
  3. `S_follow(10k) − S_heur_follow(10k)` 为**报告列**（R5 预注册修订：`≥ 0.05`
     阈值条款在 R5 轨迹语义下结构性不可满足，已降为报告列 + 失败集重叠诊断，
     计划 §10 R5；主门槛 2. 不动）。`heuristic` 行仍必须存在以供给报告值，
     缺行即 FAIL（不许删基线）；
  4. 单调性 `S_goal(30_000) ≥ S_goal(1_000)`（种子噪声内非降）；网格缺 30000 点
     时该项**跳过**（notes 标 `monotonicity: skipped(no 30k)`，`monotonicity_checked=0`），
     不把缺证当通过也不当失败。
- **输出 metrics**：`S_goal_10k`、`S_follow_10k`、`S_heur_follow_10k`、
  `follow_minus_heur`、`monotonicity_ok`（1/0；跳过时按 1 记但不判分）、
  `monotonicity_checked`（1/0）、`grid_has_10k`、`grid_has_30k`。缺数据切片以 `-1`
  占位（min 阈值必红），归因写在 notes。
- **失败模式**（不许改阈值、不许删基线，A.1/E.7）：
  - 文件缺失/未注入且扫不到 → FAIL，notes `results.json not found: run C.8 scale first`；
  - 网格缺 10000 点 → FAIL，notes 含 `grid missing N=10000`；
  - heuristic 行被删 → FAIL，notes 点名基线缺失；
  - 判据不达标 → FAIL，notes 逐项点名，报告须附「表示容量 / 数据覆盖 / 目标可达性」
    三分诊断；
  - `results.json` 破坏（坏 JSON/坏行）→ 按缺失处理并 FAIL（证据文件不许静默进门禁）。
- **落点**：`conformance/gates/g12_main_target.ts`；合成 fixture 断言于
  `tests/gates.test.ts`。

## G1.3 三臂齐全

> 同一份 `results.json`（输入注入与缺省扫描口径同 G1.2）。

- **判据**：`follow` 行须出现 `arm ∈ {heuristic, random, trained}`；
  `goal` 行须出现 `arm ∈ {random, planner, trained}`（`contract_route` 为可选
  对照列，缺席不红）；任一必含臂缺失即 FAIL，缺一不可（A.2）。文件缺失 → FAIL
  （notes 同 G1.2 引导先跑 C.8 scale）——「没跑」不是「齐全」。
- **输出 metrics**：`follow_required_present`、`goal_required_present`（各 /3）、
  `follow_arms_reported`、`goal_arms_reported`（实报臂数，含可选列）、
  `complete`（1/0，唯一阈值 `complete:eq=1`）。臂名清单在 notes（`GateResult.metrics`
  钉死为数值表，数组不入门禁 JSON 面）。
- **落点**：`conformance/gates/g13_three_arms.ts`。

---

## G2.2 超 oracle 率（配方族 only）

> 配方式 gold 计划应当就是最短验收解；held-out 上若被搜出**严格更短**且过验收的
> 算子序列，说明生成端守卫有漏。仅配方族——goal 族多解是设计语义（accept 只读
> 公开 spec），不参评本门。
>
> **R5 轨迹约束（2026-09-14）后按定义归零**：follow 族验收要求 `hist ==
> spec.trace` 精确匹配，`plan_bfs` 沿 trace 前缀剪枝，唯一解即金计划（等长），
> "严格更短"按定义不存在 ⇒ `hits` 恒 0、门禁恒绿。本节的"失败模式"登记为
> R5 前（A 落地后 0.825、门禁小样 4/4 恒红）的历史基线；`beyondOracleRate` 的
> BFS 口径边界（等长不算超/补冗余命中/超预算/退化 gold）仍由手工无 trace 任务
> 在 `tests/beyond_oracle.test.ts` 钉死。

- **输入**：`makeSplit('heldout', 2, 13)` 的 **follow 子集**（value/verify 各 2、
  共 4 条），批常量 `G22_SAMPLE_BATCH` 导出自门禁脚本，经 `ctx.genTasks` 按批次
  哈希共享缓存。R5 后 plan_bfs 对 follow 为 O(goldLen) 前缀回溯（无全深球展开），
  小样与完整批都是瞬时的；批内退化 gold（`goldLen−1 < 1`）恒判未命中但仍计
  分母。
- **判定式**（计划 A.2 原文口径）：逐任务取 `goldLen = len(plan_hidden)`（含
  `submit(+check_*)`，不含 EXIT；plan_bfs 返回值同样不含 EXIT，两边同口径按
  算子步数比较）。`plan_bfs(task, graph, maxDepth=goldLen−1)` 非 null ⇔ 存在
  严格更短验收解 ⇒ 命中（等长不算超——gold 本身不算捷径；早停深度恰差一步）。
  `goldLen−1 < 1` 的任务结构上不可能更短：恒未命中但**留在分母**。
  `plan_bfs` 超预算抛 `search budget exceeded`：按保守未命中计入分母，另以
  `over_budget` 单列上报，绝不静默吞掉，其余异常当场暴露。
- **输出 metrics**：`beyond_oracle_rate`、`tasks_total`、`hits`、`over_budget`、
  `n_value`、`n_verify`。
- **通过判据**：`beyond_oracle_rate ≤ 0.02`（A.2 固定值，**禁止改动**；样本量
  下限阈只做哨兵，防子集萎缩造成假通过）。
- **历史失败模式（R5 前）**：期望≈0 的前提是恒等签名去冗余与 follow 极小性守卫。
  实测 >0 的来源是 Str 探针/代数碰撞或**多算子巧合捷径**（多算子组合值碰撞不在
  守卫覆盖内，极小域 mod7 上尤密）——非零一律如实报告作自检证据；R5 轨迹约束
  后该类命中按定义不存在。
- **落点**：判定式 `eval/beyond_oracle.ts`（`beyondOracleRate(tasks, graph, opts?)`
  → `{total, hits, overBudget, rate}`）；门禁 `conformance/gates/g22_beyond_oracle.ts`；
  断言于 `tests/beyond_oracle.test.ts` 与 `tests/gates.test.ts`。

---

## F1 前向一致

- **输入**：`conformance/ffixtures/f1_forward.json`（冻结权重子集 + obs/候选动作特征，
  arch `v5:lang:867:83:128:none`，无时间戳、git 跟踪）。
- **算法**：TS 与 Python 两侧统一 **float64 累加**重算前向（TS 走 `f_math.forward64`，
  Python 走 `conformance/py_forward.py`，前向数学 `import controller/train_nn`，两侧都不
  复刻公式），比对 softmax 分布逐元素。
- **判据**：`max|Δ| < 1e-6`。Python 解释器默认仓库 `.venv`，可用环境变量 `DGL_PYTHON`
  覆盖；解释器缺失 → FAIL（不静默跳过）。
- **输出 metrics**：`max_abs_diff`、`n_groups`、`tol`。
- **落点**：`conformance/f_gates.ts`（`runF1`）、`conformance/f_math.ts`。

## F2 往返一致

- **输入**：`conformance/ffixtures/f2_roundtrip.json`（`weights_path` 指 f1 的权重 +
  若干任务 `{obs_vec, candidates_act_feats}`，fixture 生成时已保证 `top1−top2 ≥ 1e-3`）。
- **算法**：TS `Policy.actFromObs`（f32 概率首位取大）与 Python greedy 比对 action 一致率；
  并列窗口 `|top1−top2| < 1e-4` 按**索引小者**取，两侧同窗口口径。
- **判据**：一致率 `agree_rate == 1`（非并列分歧不允许）。
- **输出 metrics**：`match`、`total`、`agree_rate`、`tie_count`。
- **落点**：同 F1 模块（`runF2`）。

## F3 特征单源

- **算法**：静态扫描训练器（`controller/train.py`、`controller/train_nn.py`）与
  conformance 入口（`conformance/py_forward.py`）源码文本，banned 标识符零容忍
  （注释命中也算违规）；`extra` 可注入含脏串的伪文件，供测试验审计有效性。
- **判据**：`banned_hits == 0`。banned 清单（精确子串、大小写敏感）含
  `LEXICON/LEX_OPS_BASE/GOAL_LEX/GOAL_TEMPLATES/mentionStats/mention_stats/tokenize/
  tokens(/featurizeObs/featurizeAction/stateStats/featurize_instr/crc32/canonicalJson/
  hashObj/GOAL_STRUCT`——Python 侧若出现任一即说明特征逻辑被复刻（违反 F.3 单源）。
- **输出 metrics**：`banned_hits`、`files_scanned`、`banned_list_len`。
- **落点**：同 F1 模块（`runF3`）。

## F4 规范序列化自检（TS 单侧）

- **算法**：`canonicalJson`/`hashObj` 对边角值 `0.1 / 1e-7 / 1 vs 1.0 / -0.0 / CJK /
  嵌套`与冻结期望 `conformance/ffixtures/f4_expected.json` 逐字一致，且同对象两次
  `hashObj` 恒定（F.2.5 的 TS 独占口径，Python 侧不复刻 canonical 序列化）。
- **判据**：`all_stable == 1`。
- **输出 metrics**：`cases_checked`、`all_stable`。
- **落点**：同 F1 模块（`runF4`）。

---

## 附：fixture 复用与非目标

- G0.1 读取 `conformance/fixtures.json` 的冻结值复算（G0.3 的真值在
  `verify/adversarial.ts` 套件本体、G0.5 的分层在 `gen/splits.ts` 的 `STRATA`，
  不经 fixture）；文档示例同源（`docs/helpers.md` 亦由 `conformance/gen_golden.ts` 生成）。
- `npm run golden:check` 保证 fixture 与文档未漂移；门禁脚本不得内联期望数字。
- 本文件覆盖 Phase 0（G0.1–G0.6）、Phase 1（G1.1–G1.3，判据对应 A.1/A.2/C.8）、
  G2.2（超 oracle 率，判据对应 A.2）与防漂移（F1–F4，判据对应 F.3）；G2.1/G2.3/G4.x
  沿用同一 `GateResult` 形状，在各自阶段补 `g2x_*`/`g4x_*`，阈值与口径以
  `1789174413324-datagraphlab-data-engine-sft-controller.md` 附录 A.2 为准。
