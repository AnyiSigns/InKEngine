# DataGraphLab

程序化合成数据 + 可执行验收器 + teacher 轨迹 → SFT/蒸馏的**可微路由控制器**。
设计定稿见 `.kilo/plans/1789174413324-datagraphlab-data-engine-sft-controller.md`；
本包是其落地（Phase 0 已闭环，Phase 1 数据→训练闭环推进中）。

## 现状（本波已闭环）

世界层与合成数据生成器、可执行验收器、oracle 教师轨迹、内容寻址存储加 14 道门禁
脚本已齐备：`npm run gate` 现 **14/14 PASS**（G1.2 已转绿——全量复评
`runs/scale-20260915T00-a1-full/` 的 S_follow(10k)=1.0000 ≥ 0.80、S_goal(10k)=0.5500
≥ 0.50、单调性 checked=1，见「R7 复评全量」节；此前红因 = R5 前旧基线 0.247 → R6
冒烟 0.238 → v4 桶碰撞期 0.42 的如实证据链），每次跑批
把机器可读证据落进 `runs/gates-<stamp>/`（每门禁一份 JSON、两份 csv
明细、一份 run 级 `manifest.json`）。teacher/search（`planBfs`，R5 起 follow 沿
`spec.trace` 前缀剪枝）与 controller 三件套（features/policy/checkpoint）、数据派生层
（records v2 bin）、运行/评测（rollout/metrics/arms 五臂 + G2.2 超 oracle 判据 +
REINFORCE 臂）、DAgger 编排、Python 训练器（train.py，含 `--loss reinforce`）已落地。
全套 **450 项测试（39 个文件）可重跑复现**（`npm test`；实读口径 = `vitest list`
收集 450/39，2026-09-15。全文测试数以此处为唯一数字源）。
「完成」的定义里，run 级版本快照与实测数字回填均已闭环——快照随 `createGateContext`
给定 runId 时落盘，数字见「验证结果」节。

| 件 | 内容 | 落点 |
|---|---|---|
| 世界层 | `makeRng`(mulberry32)、`canonicalJson`/`crc32`/`hashObj`、`t`/`deepEq`、`OPS`/`NODES_BASE`/`ROUTING`/`LEX_OPS_BASE`/`MAX_REPEAT`、`buildNodeSlots`/`NODE_SLOT` | `world/`、`controller/` |
| 词表与渲染 | `LEXICON`/`GOAL_LEX`/`GOAL_TEMPLATES`、`tokens`/`mentionStats`、`renderRecipe`/`renderGoal`/`parseRecipe`，含**往返硬测试**、义项不变量审计 | `world/lexicon.ts`、`world/tokenize.ts`、`world/render.ts`、`world/lexicon_audit.ts` |
| 生成层 | 骨架全枚举 + 签名去冗余 + 恒等丢弃、分层切分、follow/goal 双风格、可产性判定（goal 适格池 + 极小性守卫） | `gen/` |
| 验收与运行 | 通道收口的可执行验收器、对抗套件（静态错件 + fuzz）、沙箱、图与候选动作 | `verify/`、`runner/` |
| 教师与数据 | on-path oracle 逐步标签、teacher 规划臂 `planBfs`（BFS 最短解，不进训练集）、内容寻址 JSONL 分片 + 索引 + 两级去重、泄漏审计、多解冲突率诊断、全员版本化 manifest | `teacher/oracle.ts`、`teacher/search.ts`、`data/` |
| 控制器三件套 | 白名单特征 `featurizeObs`/`featurizeAction`、指针式 `Policy` 前向与 f32 精确随机初始化、`weights.json` 读写 + arch fail-fast + float32 执法 | `controller/features.ts`、`controller/policy.ts`、`controller/checkpoint.ts` |
| 数据派生层 | 原始 obs（store）→ 稀疏 `records.bin` v2（header 一次性存 22 节点动作特征表 + 行内 22 位全局 ROUTING 掩码 + 进度 critic 标签），featurize CLI；`reinforce.bin` v1（采样动作本地下标 + advantage/reward） | `data/records.ts`、`data/records_bin.ts`、`data/reinforce_bin.ts` |
| 运行与评测 | C.7 贪心 rollout、DAgger 编排（on-path 干预、`maxFixes=4`）、pass@1(Wilson CI)/pathExcess/stepsOverShortest/routingAcc/ECE、五臂（heuristic/random/trained/planner/contract_route）、G2.2 超 oracle 判据、REINFORCE 臂 | `runner/rollout.ts`、`runner/dagger.ts`、`eval/` |
| Python 训练器 | numpy 前向/反向/Adam/CE+smoothing+WD+进度头（数值梯度 <1e-5、记忆自检 acc≥0.99）、bin v2 解析、val CE 早停 + `--save-last-k`；`--loss reinforce` 策略梯度（数值梯度 1.8e-9） | `controller/train.py`、`controller/train_nn.py`、`controller/train_reinforce.py`、`controller/reinforce_nn.py` |
| 门禁 | G0.1–G0.6 / G1.1–G1.3 / G2.2 / F1–F4 判据脚本 + 共享 harness（`inputs_hash` 绑定 world/manifest/fixture，失败也落盘；同时刻出 run 级 `manifest.json` 版本快照） | `conformance/gates/`、`docs/gates.md` |
| 金标 | 所有示例由参考实现生成并冻结，文档同源自动生成 | `conformance/`、`docs/helpers.md` |

## 命令

```powershell
npm install
npm run typecheck          # tsc（零运行时依赖，仅 devDeps）
npm test                   # vitest：hash/rng/types/词表/往返/生成/验收/门禁单测全量
npm run gate               # 跑全部 14 门禁（G0.1–G0.6 / G1.1–G1.3 / G2.2 / F1–F4），证据+manifest.json 落 runs/gates-<stamp>/
npm run golden             # 重新生成 conformance/fixtures.json 与 docs/helpers.md
npm run golden:check       # 断言二者与参考实现逐字一致（文档漂移即红）
npx tsx data/records.ts --split train --out runs/train.bin       # 原始 obs → records.bin v2
C:\...\.venv\Scripts\python.exe controller/train.py --train runs/train.bin --val runs/val.bin --out runs/weights.json   # 唯一 Python 训练器
```

## 关键约束（已代码化）

- 随机一律 `makeRng(seed)`，哈希一律 `hashObj`/`crc32`；禁用 `Math.random` 与内置 `hash()`。
- 类型 `t()` 先判 Bool 再判 Int；`TYPE_LIST` 恰 6 项；`"any"` 只是 requires 通配。
- 配方族指令**必须可往返**：`render_recipe` 渲染的算子序列，`parse_recipe` 必须原样还原。
  为此义项在整条指令内全局唯一；`取反` 是 `neg`/`reverse` 的类型可判定共享义项。
- 目标族渲染只描述目标属性，绝不出现任何算子义项（否则退化成配方族）。
- 所有 helper 签名/示例见 `docs/helpers.md`（自动生成，勿手改）。

## 验证结果（收尾实测，全部读自产物）

证据 run（R5 落地后）：`runs/gates-20260914T120355/`（14 门禁 **13/14 PASS**，
仅 G1.2 如实红——R5 前旧数据基线，R5 后 follow 数据重生成重训结果见「R5 落地」
节；`inputs_hash` 以该 run 的 manifest.json 为准；该 run 当时 world_version
`6a596090bff1b45a`——P1-A 词法组成漂移修正后随代码现值为 `72e89963282d35f9`，
下列引用 run 均早于该漂移、其磁盘 manifest.json 原值不改（门禁重跑与数字回填交
规划者终验）；run 级 `manifest.json` 全员版本化快照）。R5 前基线证据：
`runs/gates-20260913T175716/`（12/14，G1.2/G2.2 红，`inputs_hash`
`23cefb3e33f1cb8a`）。
C.8 第二跑证据（R5 前基线）：`runs/scale-20260913T094845/`（grid {1000,10000,30000}
× seeds {0..4}，弱扫描口径，210 行长表 + 15 checkpoint + k% 覆盖度副轴）。

- `npm run gate`：**14/14 PASS**（G1.2 已转绿——R7 冒烟 `runs/scale-20260914T23-r7b-smoke/`
  S_follow(10k)=1.0000 ≥ 0.80，证据见「待决」R7 复评节）；`npm run typecheck` 通过；
  全量 `npm test`
  39 文件 450 项全绿（数字源见「现状」行，2026-09-15 实读）。
- G0.1 确定性：跨进程 + 进程内复算逐字节一致，一致率 1.000（12 例 makeTask，
  fixture 复算 15/15 命中）。
- G0.2 可解性：728 任务 solvable 比例 1.000，hidden plan 回放穿验收失败 0。
- G0.3 验收抗投喂：61 例（静态错件 37 + fuzz 24，含 R5 轨迹不符 3 条）拒绝率
  1.000，正确通道喂饱率 1.000。
- G0.4 泄漏审计：主臂特征泄漏 / 骨架重叠 / 模板重叠 / 标签冲突四指标全 0
  （5094 条记录全链检查、720 任务 join、720 回放穿验收，隔离区 0 条）。
- G0.5 分布对齐：KL(train‖heldout)=0.023291 nats < 0.05 阈值（Lidstone 平滑 α=0.5，
  N=1000/1000，9 个分层；gold 骨架 JS 散度 0.007174 仅 sanity）。
- G0.6 目标可分性：4 类 top1 准确率均值 0.9852、标准差 0.0127（5 seed：
  0.9900/0.9620/0.9900/0.9840/1.0000；每类 held-out 54 条；编码器第 2 轮）。
- G1.1 非免费午餐：random 臂 pass@1 follow=0.0000 / goal=0.0000（各 n=600，≤0.05；
  臂 seed=42——R7 arch v3 后 seed 123 抽签 submit 偏置票 0.0850 越线，G0.4 仍全绿
  非泄漏，只换抽样参数阈值不动；v5 桶位重排后 goal 票 0.0017→0.0000 如实更新）。
- G1.2 主目标：**14/14 全绿（首次全量证据转绿）**——`S_follow(10k)=1.0000≥0.80`、
  `S_goal(10k)=0.5500≥0.50`、单调性 `S_goal(30k)=0.7377≥S_goal(1k)=0.4437` ✅
  （证据 `runs/scale-20260915T00-a1-full/results.json`，monotonicity_checked=1；
  历史红链：R5 前第二跑基线 0.247 → R6 冒烟 0.238 → R7 v4 桶碰撞期 0.42 → v5 全量 1.0）
  （R5 前基线；R5 后冒烟/全量见「R5 落地」节）、
  `S_follow−S_heur=−0.736<0.05` ❌（R5 预注册修订：差额条款降为报告列 + 失败集
  重叠诊断，见计划 §10 R5）。
- G1.3 三臂齐全：follow=[heuristic, random, trained, contract_route]、
  goal=[random, planner, trained, contract_route]，必含 ⊆ 成立。
- G2.2 超 oracle 率：**R5 轨迹约束后按定义归零**——门禁 4 条筛查小样 hits=0/4、
  rate=0.0000 ≤ 0.02 转绿（完整 120 条统计量同口径归零，`tests/beyond_oracle.test.ts`
  钉死全批零命中；R5 前基线：守卫修正后 99/120≈0.825、R4 108/120≈0.90，见「待决」）。
- F1–F4 防漂移：前向一致 max|Δ|=2.78e-17 < 1e-6；往返一致 3/3；特征单源零命中；
  规范序列化 6 例冻结期望逐字一致。
- 生成器池（gen 模块实读）：`SKELETONS` 4199、`HELDOUT_SKELETONS` 829、
  `VAL_SKELETONS` 160；held-out 骨架中 goal 域不适格 210 个——不可产注册表
  **420 键 = 210×2 goal 两族**（R5 后 follow 键清空，原 80 结构性非最小骨架全部
  恢复可产，held-out follow 可产域恢复 829）。

### C.8 第二跑结果（A.1 判定 + 三分诊断）

第二跑证据：`runs/scale-20260913T094845/`（grid {1000,10000,30000} × seeds {0..4}，
弱扫描口径；10k 保留以续 G1.2 判定、30k 新增以验单调性）。统计集 4×300、两 style
各 600/run，trained 臂跨 5 seed 均值：

| 指标 | N=1000 | N=10000 | N=30000 | A.1 目标 |
|---|---|---|---|---|
| S_goal (trained pass@1) | 0.336 | **0.585** | **0.775** | ≥ 0.50 ✅ 且单调 ✅ |
| S_follow (trained pass@1) | 0.050 | **0.247** | **0.300** | ≥ 0.80 ❌ |
| S_heur_follow（弱词法基线） | 0.983 | 0.983 | 0.983 | 对照列 |
| S_follow − S_heur | −0.933 | −0.736 | −0.683 | ≥ 0.05 ❌ |
| S_planner_goal（公开 BFS 上界） | 1.000 | 1.000 | 1.000 | 报告列 |
| S_rand（follow / goal） | 0.0003 / 0.017 | — | — | ≤ 0.05 ✅ |
| ContractRoute（两 style） | 0.000 | 0.000 | 0.000 | 廉价对照列 |

幂律拟合（trained pass@1，3 点）：goal `S∞≈0.99, α≈0.30`（CI S∞ 0.93–1.05）；
follow `S∞≈0.65, α≈0.17`（CI S∞ 0.52–0.78）。

诊断列：routing_acc follow 0.668→0.848→0.875；goal 停滞 0.361→0.365→0.383；
path_excess follow −0.385→−0.007→−0.003（收敛到 ≈0）；steps_over_shortest goal
2.03→2.05→2.24；**safe_action_conflict_rate goal 恒 ≈0.999（n=200/run）**——按 §6
预注册 P75 规则阈值=1.0，Phase 2 标签软化开启条件满足（软化仍属 Phase 2 动作）。
k% 覆盖度副轴：goal 0.56/0.43/0.33/0.41（k=10/25/50/75，非单调属单 seed 噪声），
follow ≈0.06 平台；k=100 余池空按契约报 n=0。

**G1.2 判定（如实红，不许改阈值，A.1/E.7）**：`S_goal(10k)=0.585 ≥ 0.50` ✅；
单调性 `S_goal(30k)=0.775 ≥ S_goal(1k)=0.336` ✅（`monotonicity_checked=1`）；
`S_follow(10k)=0.247 < 0.80` ❌；`S_follow−S_heur=−0.736 < 0.05` ❌。

**三分诊断（更新）**：
- **数据覆盖**：follow 0.050→0.247→0.300 仍爬升但增量骤减（10k→30k 仅 +0.05），幂律
  外推 `S∞≈0.65`（CI 上界 0.78 < 0.80）——数据量是有效杠杆，但**单靠扩 N 达不到 0.80
  门槛**；goal 对照 `S∞≈0.99` 说明容量/标签对 goal 不构成瓶颈。N=30k 已近触顶。
- **逐步误差累积**：follow routing_acc 0.875（30k），端到端 ≈ `routing_acc^链长`；goal
  routing_acc 停滞 ≈0.38（多解 one-hot 标签噪音，见下）。
- **标签口径 / 数据质量**：goal 族 `safe_action_conflict_rate≈0.999`——多解下 one-hot
  oracle 标签近乎任选（P75 预注册阈值=1.0，Phase 2 软化条件满足）；follow 标签 on-path
  精确，但生成端 gold **非极小**（G2.2 实测 0.90，见「待决」）——冗余步在具体 witness
  上恒等/值碰撞，属数据质量项，会抬 `path_excess` 基线并放宽考核。
- **下一杠杆（按 §7 课程序）**：N=30k 已近触顶且幂律上界 <0.80 → 应先开**自模仿过滤**
  （纯数据量手段，本轮登记待决），KD（标签口径变化）在其后。

### R7 复评全量（A.1 最终判定，2026-09-15，arch v5）

全量证据：`runs/scale-20260915T00-a1-full/`（grid {1000,10000,30000} × seeds {0..4}，
coverageN=1000——R7 复评 P0 桶修复后全量，脚本 `scripts/a1_full.ts`）。统计集 4×300、
两 style 各 600/run，trained 臂跨 5 seed 均值：

| 指标 | N=1000 | N=10000 | N=30000 | A.1 目标 |
|---|---|---|---|---|
| S_follow (trained pass@1) | 0.9990 | **1.0000** | **1.0000** | ≥ 0.80 ✅ 且单调 ✅ |
| S_goal (trained pass@1) | 0.4437 | **0.5500** | **0.7377** | ≥ 0.50 ✅ 且单调 ✅ |
| S_heur_follow（弱词法基线） | 0.9750 | 0.9750 | 0.9750 | 对照列 |
| S_follow − S_heur | +0.0240 | **+0.0250** | +0.0250 | 报告列（R5 降阈值）✅ 转正 |
| S_rand (follow / goal) | 0.0000 / 0.0000 | — | — | ≤ 0.05 ✅ |
| ContractRoute（两 style） | 0.0000 | 0.0000 | 0.0000 | 廉价对照列 |

routing_acc follow：0.9999 / 1.0000 / 1.0000（全步，10k/30k 五 seed 全 600/600）。
k% 覆盖度副轴（coverageN=1000）：follow 0.9886/0.9944/0.9869/1.0000（k=10/25/50/75，
k=100 余池空按契约报 n=0）；goal 0.5254/0.4717/0.4732/0.4030。

**G1.2 判定（门禁 14/14 全绿，首次全量证据转绿）**：`S_follow(10k)=1.0000 ≥ 0.80` ✅、
`S_goal(10k)=0.5500 ≥ 0.50` ✅、单调性 `S_goal(30k)=0.7377 ≥ S_goal(1k)=0.4437` ✅
（`monotonicity_checked=1`）、`S_follow(30k)=1.0000 ≥ S_follow(1k)=0.9990` ✅。
`S_follow−S_heur` 报告列 +0.0250 首次转正（A.1 差额语义通道 = 并列义项类型消歧，
trained 反超弱扫描，见「待决」R7 复评节）。

### Phase 2 搜证（G2.3 REINFORCE 同预算对照，2026-09-15）

证据 `runs/phase2-g23-20260914T232039/`（脚本 `scripts/g23_reinforce.ts`）。白手起家
随机初始化策略、单遍采样（budgetSteps = BC N×8 = 80000，§7 口径）→ reinforce.bin →
`train.py --loss reinforce`（5 epoch、β_ent=0.01、lr=1e-3）→ held-out 评测；与 BC
trained（a1-full 10k s0）同预算对照：

| 指标 | REINFORCE | BC trained | 对照解读 |
|---|---|---|---|
| S_follow (pass@1) | **0.0000** | 1.0000 | 稀疏终局奖励 + 精确轨迹：随机策略 0 解决 ⇒ 零学习信号，RL 完全失败 |
| S_goal (pass@1) | **0.3617** | 0.5700 | 多解 goal 给随机策略 1.7% 命中 ⇒ 微弱信号，RL 学到 BC 的 ~64%，仍不及密集监督 |

采集统计：10246 rollouts / 80011 env 步 / 174 解决（meanReward 0.0170）/ 80011 行；
训练 785 batch（5 epoch）。

**预注册解读（§10 G2.3 行）**：同预算样本效率对照——稀疏终局奖励下 RL 不及密集监督
BC，follow（精确轨迹、零信号）尤甚；goal（多解、微弱信号）RL 可部分学习但仍 < BC。
赢/输均按效率报告，禁止升格为路线裁决（§0 关于真实域信号稀疏/信用分配，不因本
玩具域结果存废）。

### Phase 2 搜证（G2.1 DAgger 偏离诊断，2026-09-15）

证据 `runs/phase2-g21-20260914T233614/`（脚本 `scripts/g21_dagger.ts`）。从 BC s0
（a1-full 10k，oracle 基 57357 行 = cellSeed(10000,0) 复刻）起步，3 迭代 × 2000 任务
× maxFixes=4，偏离处收 on-path gold 修正并入基重训（correctGold 唯一口径）：

- **偏离分布**：deviatedRollouts 3006/6000（50.1%）、deviatedSteps 9003；首次偏离
  步位直方图 **k0:2270 / k1:578 / k2:126 / k3:27 / k4:4 / k5:1**（75.5% 在首步、
  94.7% 在前两步——goal 首步路由是最大偏离点，与 A.1 诊断一致）；rowsAdded 每迭代
  [1938, 2728, 2890]。
- **BC vs DAgger held-out 差**：goal DAgger=0.5800 vs BC=0.5700（+0.010，迭代内
  goal pass@1 = [0.6350, 0.5350, 0.5800] 不单调——修正不复合，符合登记预期）；follow
  双侧 1.0000 无偏离无增益。
- **预注册解读（§10 G2.1 行）**：诊断项不作晋级门槛——首次偏离之前未经过的
  off-path 状态始终无监督（即便老师干预后亦然），故 DAgger 增益有限属结构预期，
  偏离分布与 BC−DAgger 差如实报告。

### 失败模式与修正

- **门禁前移拦截表示瓶颈**：目标可分性首轮编码器实测 top1 均值仅 0.7856（阈值
  0.90），失败模式是 `all` 合取类欠拟合；迭代编码器特征（目标属性词表 + 数字 +
  hash 词袋，265 维）后第 2 轮才转绿（上表 `encoder_iteration=2` 如实留痕）。若没有
  这道前移的门禁，表示瓶颈要等到控制器训练失败才暴露。
- **goal 适格池审查修正**：长度不变类骨架（upper/lower/reverse 组合）在旧探针判式
  「只看终值可达」下被误判 goal 适格，但初始已达标的目标做不出「改变达标性」的
  合法任务，实例化环节永远找不到 witness，覆盖构造随之报错——根因是探针判式弱于
  witness 条件，改为「初始不达标 ∧ 终值达标」合取后不适格计数如实上报（210 个）。
- **follow 极小性守卫缺长度比较**：捷径判定原来只要「单算子+收尾能过验收」就拒采，
  而深度 1 骨架的这个「捷径」正是金计划本身（等长并非更短），导致整个深度 1 follow
  域被清空、held-out 覆盖构造报错；补上「捷径总长必须严格小于金计划」后恢复。
- **verdict 指纹绑定堵旧 verdict 复用**：verify/goal_verify 两生产者族的 verdict
  不再是布尔旗标，而是指纹承诺 `pass:` + hash8(answer)——「先 check 通过、再改值、
   后 submit」这类旧 verdict 复用攻击因指纹配不上新终值被验收拒掉，对抗套件里对应
   条目全拒（G0.3 静态错件 37 类含此项）。

## 待决（先登记后扩展）

- R2-P0 计划同步**已闭环**：verdict 指纹绑定 / 恒等签名丢弃 / goal 适格池 + follow 极小性
  守卫全部落地；判定式对计划伪代码的四处语义修正（[add3,sub1] 恒等举例、epool 漏
  goal_verify、probe_hit 弱化式、has_shortcut 缺长度比较）**已由规划者回写计划**。
- `records.bin` 已升级 v2 契约并与计划 F.2 同步：header 一次性存 22 节点动作特征表
  （「候选特征由 node id 确定、不重复存」的唯一落地，F.3 禁 Python 复刻特征）、行内
  cand_mask 为 22 位全局 ROUTING 掩码、target_idx 仍为本地下标。旧 v1 bin 读侧 fail-fast。
- `docs/helpers.md` 登记滞后：`plan_bfs` 行已改「已落地」；featurize/Policy/bc_train/
  records/rollout/arms 等 Phase 1 helper 行已由 P1e 批次补齐（helpers_doc 为真源，
  golden 再生成）；HeuristicArm 行已按 R3 弱词法扫描口径同步。
- `audit_features()` 静态执法未落地：G0.4 现只审 record obs 面；对 featurize 输出做
  键/来源静态审计列为 Phase 1 数据集冻结前必开项（现由签名级隔离 + 注入测试兜底）。
- F2「1e-4 并列窗口」属 conformance 比对侧职责（届时实现）；TS 推理侧口径 = 精确并列
  取最小下标。
- follow 族多算子巧合捷径实测**远超预期**：完整 held-out follow 120 条中 **108 条
  （0.90）** 存在严格更短验收解（极小性守卫只挡「单算子+收尾提交」，多算子冗余步与
  decoy 可达解不拦）。G2.2 阈值 0.02 不变、如实红（计划 G2.2 行已同步）。
  **核销（2026-09-14）**：守卫已扩为「单步替换 + 删任意 ≥1 骨架步」，
  120 条复跑 0.90→0.825（删步型全清，残留替换/decoy 型，见上条「A 落地后复跑」）。
- **A 落地后复跑（2026-09-14，守卫修正核销）**：`hasShortcut` 删任意步守卫落地后
  复跑（证据 `runs/g22_rerun.ts`、`runs/gates-20260914T093351/`、
  `runs/scale-20260914T0936-smoke/`）：
  - **G2.2 完整 120 条：0.90 → 0.825（99/120）**——命中任务逐条复核：删步型 0 条、
    单步替换型 0 条（两类已被守卫清除），残留 99 条全为**多算子替换/decoy 组合型**
    （如 `cond_even,add3,neg` vs gold 5 算子、`branch_decoy,mod7`）；门禁 4 条小样
    4/4 恒红如实报（阈值 0.02 不动）。G0.2/G0.4/G0.5 复跑全绿（可解 1.0、泄漏四指标
    0、KL 0.0234）。
  - **scale 冒烟 {1k,10k}×3 seeds（真实 trainer）：S_follow(10k) 0.247→0.244 无提升**、
    S_goal(10k) 0.585→0.708（3 seeds 噪声区间，不作结论）、S_heur 0.9833→0.9817。
   - **结论**：删步守卫改善数据质量（G2.2 回落）但非 follow 失败主因——主因是「验收
     只查终值 ⇒ 模交换重排/替换恒合法」（R4 诊断 81% 错选=通向验收的合法替代），
     守卫按定义不覆盖替换型，Phase 2 需在验收/指标层加**轨迹约束**（计划 §10 预登记，
     独立决策不在 A 内）；冒烟判定 follow 无提升 ⇒ **不跑全量**（30k 预期仍 ≈0.25，
     不接近 0.80 门槛），下一杠杆按 §7 课程序为自模仿过滤。
- **R5 轨迹约束立项（2026-09-14，用户拍板：先轨迹约束，仍不达标再自模仿过滤）**：
  计划 §10 R5 已登记（唯一真源）。要点：仅 follow 族 `spec` 增公开字段 `trace`
  （= 含终算子的渲染序列），验收 = 原判定 ∧ `hist == trace` 精确匹配；goal 族不变。
  连锁：G2.2 定义性归零；`hasShortcut` 按定义恒 false（保留安全网）、`followUnproducible`
  同步退化 ⇒ follow 可产域恢复 829 级、覆盖集/不可产注册表重生成（580 键 → goal 侧
  420 键）；follow 数据全量重生成重训；A.1 差额条款预注册修订为报告列 + 失败集重叠
  诊断（`S_follow−S_heur ≥ 0.05` 在新语义下结构上不可满足，R3-P1-1 先例），主门槛
  `S_follow(10k) ≥ 0.80` 不动。实现与复评见后续批次。
  **✅ 已落地（2026-09-14）**：`_commit` 写 `spec.trace`；`accept` 加轨迹判定；
  对抗套件 +3 条轨迹不符必拒（终值对但 hist≠trace 的恒等绕路/等价重排）；`planBfs`
  follow 沿 trace 前缀剪枝（O(goldLen)，G2.2 归零）；`followUnproducible` 临时任务
   补 trace 后退化为"金计划回放可穿即可产"；注册表 580→420 键、follow 可产域恢复
   829；全套测试全绿（数见「现状」行数字源，单一口径不另记）；`npm run gate` 13/14（G2.2 0/4 归零转绿，G1.2 仍红为
  R5 前基线）。**R5 后 follow 重生成 + 重训冒烟 {1k,10k}×3 seeds 证据
  `runs/scale-20260914T12-r5-smoke/`：S_follow(10k)≈0.201（R5 前 0.244，不升反降），
  结果见「R5 落地」节。**
- **R6 词法顺序槽特征（2026-09-14，用户判断 + 分层诊断：表示瓶颈）**：计划 §10
  R6 已登记（唯一真源）。R5 复评未达标后分层诊断（`scripts/follow_diag.ts`）：
  首步路由仅 0.78–0.83（纯读指令即错 ~20%）、失败集 97.5% 与弱扫描不重叠（模型在
  0 参数启发式能对的任务上失败）、含恒等步组差 ~7 点非主因 ⇒ **表示瓶颈（词法
  顺序信息缺失）**，排除容量（跳过 H 256）与数据覆盖。方案：`featurizeInstr` 增
  **词法顺序槽**（义项首现升序 TOP-8 槽位 one-hot，`ORDER_DIM=120`，OBS_DIM
  732→852，arch v2）；模型在顺序槽上学习类型消歧（弱扫描不做），预期首步 →0.95+、
  差额条款（R5 已降为报告列）有机会转正。实现与复评见后续批次。
  **✅ 已落地（2026-09-14）**：`featurizeInstr` 顺序槽落地（arch v2，`ORDER_SLOTS=8`、
  `ORDER_DIM=120`、OBS_DIM 852）；F1/F2 fixtures 重生成（`Policy.random(20260914)`）；
   全套测试全绿（数见「现状」行数字源，单一口径不另记）；`npm run gate` 维持 13/14。**R6 冒烟 {1k,10k}×3 seeds
  证据 `runs/scale-20260914T22-r6-smoke/`：S_follow(10k) 均值 0.238（s0/s1/s2 =
  0.247/0.238/0.230，R5 0.201 实质提升但未达标）；首步路由 0.78–0.83 → 0.877–0.882
  （+10 点，方向正确）**——但 step1–3 仅 0.74–0.75（比 step0 低 13 点），模型无法
  对齐"顺序槽全局位置 ↔ 历史进度"，端到端未转化；失败集 ~74% 仍与弱扫描不重叠。
  ⇒ R7 进度对齐槽立项（见下条）。
- **R7 进度对齐槽特征（2026-09-14，R6 复评证据：缺口在进度对齐）**：计划 §10
  R7 已登记（唯一真源）。R6 顺序槽把首步路由提到 0.88（方向正确），但 step1–3
  只有 0.74–0.75——模型要自己学"hist 里已执行的算子跳过、选下一个未执行"的两步
  推理（H=128 MLP 做不到）。方案：obs 增**「下一个待执行算子」one-hot 15 维**
  （`NEXT_OP_DIM=15`，段位紧随指令段）：派生源 = 逐位置义项命中组
  （`occurrencePlan`，与弱扫描同源口径，枚举义项全部命中位置、含重复算子）`+
  obs.hist` 公开面——hist 按序逐次消耗匹配位置、取第一个未消耗位置（组内最小
  算子）；历史耗尽/ goal 族 → 全零。OBS_DIM 852→867、struct 满宽 860→875、
  hash_only 不变（671）；arch **v4**（初版 v3 按 op 身份去重跳过、重复算子步
  68.6% 骨架与 oracle 标签冲突，审查后改 occurrence 指针语义直接 bump，v3 未
  训练无证据污染；修复后 train 池 3052 步仅余 17 步冲突全为登记的并列义项
  tie-break 简化；`weakLexicalPlan` 同步统一走 occurrencePlan，统计集 S_heur
   实测仍 0.9750）。预期：step1–3 路由追平 step0、S_follow(10k) 冒烟 > 0.40。
  实现与复评见后续批次。
- **R7 复评 + P0 修复（2026-09-14，动作哈希桶碰撞）**：冒烟 {1k,10k}×3（arch v4，
  证据 `runs/scale-20260914T23-r7-smoke/`）：S_follow(10k) 三 seed 全 = 0.4200（N=1000
  亦 0.4200，S_heur 0.9750）；首步路由 0.8900 < 0.90 判定线；step1–3 = 0.8433/0.8633/
  0.8356（R6 0.74–0.75 实质提升但未追平 step0）。**关键证据：三 seed 行为逐位一致**
  （step0 动作 600/600 相同、1k/10k 同值）→ 结构性而非学习噪声；逐步分解 step0 错例
  66/66 全为 gold=mod7 且一律错选 add3，其余算子 100% 命中。**根因**：动作特征哈希桶
  `crc32(id)%64` 碰撞 bucket=51 [add3, mod7]（二者契约 kind+Int→Int 全同）→ 动作特征
  逐位相同 → 指针得分恒等 → 贪心按候选序 tie-break 恒选 add3 → **mod7 结构性不可学**
  （R5/R6 期已存在，被其他误差掩盖）。**修复**：动作桶改「同签名类内无碰撞」分配
  （类 = kind+provides+requires_types+out_type，类内线性探测；其余节点桶位不变），
  arch v4→v5（特征语义变化，F.2 fail-fast），回归测试钉全 ROUTING 动作特征两两不同；
  fixtures f1/f2 重生成（dims 不变 867）。**修复后冒烟 `runs/scale-20260914T23-r7b-smoke/`
  （arch v5）达标：S_follow 六格全 1.0000（1k/10k × 3 seed，600/600）、routing_acc
  1.0、分层诊断全 step 1.0000（含 len7 深链组、恒等冗余步组）、S_heur 0.9750 不变、
  S_follow−S_heur = +0.0250 首次转正（并列义项类型消歧通道兑现）**；门禁 14/14 全绿
  （G1.2 首次转绿：S_follow(10k)=1.0000≥0.8）。**全量复评（`runs/scale-20260915T00-a1-full/`，
  2026-09-15）A.1 达成**：S_follow 0.9990/1.0000/1.0000（1k/10k/30k）、S_goal
  0.4437/0.5500/0.7377 全达标且单调（G1.2 monotonicity_checked=1 首次以全量证据转绿），
  详见「R7 复评全量」节。
- **R3 核销（HeuristicArm 弱词法扫描，C.7 规格）**：committed 版曾用类型感知
  `parseRecipe`，实测 follow held-out pass@1=1.0，A.1 的 `S_follow−S_heur ≥ 0.05`
  结构上不可满足；已改 `weakLexicalPlan`（义项首现升序、同位命中按 LEX_OPS_BASE 固定
  序取最小、放弃类型消歧），tests 钉 seed 59/77/150 验 `取反` 恒判 neg。**S_heur 校准
  列**（N=1000 seed 0 冒烟实测）：parseRecipe 版 1.0000 vs 弱扫描版 0.9833——门禁只用
  弱扫描口径；第二跑已重测弱扫描版 `S_heur=0.9833`（follow 三档恒等），parseRecipe 校准
  值仍只取 R3 冒烟、未入报告长表（如需并入须另立列，登记为待决）。
- **goal 族安全动作集冲突率（§6 预注册 P75 规则）**：第二跑统计集（4×300、5 seed）
  实测 `safe_action_conflict_rate≈0.999`（n=200/run）——按预注册规则「取首轮 conflict
  rate 分布的 P75」→ 阈值=1.0，**Phase 2 标签软化开启条件已满足**（软化本身是 Phase 2
  门禁内动作，Phase 1 不改 one-hot 标签）。
- **G2.3 初始化口径降级**：计划已从「同 seed 同架构随机权重」降为「同分布同架构随机
  初始化」——TS `Policy.random`（makeRng+float32）与 Python `params_from_json`
  （default_rng+float64）逐位不同属既定实现；BC/REINFORCE 同侧同 seed 一致即可。
- **C.8 第二跑网格口径（本轮登记，先登记后扩展）**：第二跑 grid 定为
  `{1000, 10000, 30000}` × seeds `{0,1,2,3,4}`，`coverageN=1000`——非字面
  `{1000,30000}`。原因：`harness.findLatestScaleResults()` 只认最新 `scale-*` 目录
  且**不回退旧 run**，而 G1.2 判定式硬要求 N=10000 行、单调性又需 1000/30000 两端；
  若第二跑缺 10k，新目录一旦成为最新证据，G1.2 立即以 `grid missing N=10000` 变红并
  丢失 10k 跨 seed 均值。10k 行保留是为 G1.2 连续性，30k 行新增是为单调性判定。
- **本轮落地（A.2）**：G2.2 门禁（超 oracle 率，如实红）；DAgger 编排 `runner/dagger.ts`
  + G2.1 诊断统计（诊断项不作晋级门槛，BC−DAgger held-out 差随实验批次回填）；G2.3
  REINFORCE 臂 `eval/reinforce.ts` + `reinforce.bin` v1 + `controller/reinforce_nn.py`
  （数值梯度 1.8e-9）+ `train.py --loss reinforce`（lr=1e-3/β_ent=0.01/batch=512、
  预算=BC 总步数≈N×8、白手起家不从 BC 热启）。trained vs REINFORCE 的同预算对照实验与
  G2.1 的 BC 差值属实验批次，未在本轮跑。
- **自模仿过滤（§7 已触发，待实现）**：第二跑 N=30k 仍触顶（S_follow=0.300<0.80，
  幂律 S∞≈0.65<0.80）→ 按课程序应开**自模仿过滤**（控制器自身验收通过的 rollout 入
  BC 池，标签=自身动作、过 accept 过滤、与 oracle 冲突照 quarantine）；须先补门禁与
  数据口径登记再实现，本轮只触发不改数据管线。KD 在其后（标签口径变化）。
- 其余（结构进化/llm_gateway）属 Phase 2+，不提前实现。
- **G2.2 首测（本轮，如实红）**：`eval/beyond_oracle.ts` 按 A.2 口径实测——完整
  held-out follow 统计集（`makeSplit('heldout',60,13)`，120 条）中 **108 条存在严格更短
  验收解（率 0.90）**，远超阈值 0.02。门禁 G2.2 因 BFS 重尾（全批约 4 分钟、会越
  vitest worker 心跳）改用 4 条确定性筛查小样（见 `docs/gates.md` G2.2），实测同样
  全命中 → **红线如实**。根因：生成端 `hasShortcut` 极小性守卫只挡「单算子+收尾提交」
  捷径；多算子组合下「某冗余步在该 witness 上恒等/值碰撞」（如 `cond_long`/`mod7` 在
  具体值上恒等）与 decoy 可达解不被拦。**阈值 0.02 未动**（A.1/E.7）。修守卫（扩到多步
  或带预算的搜索过滤）会改动 held-out 任务、作废现有 S_follow 数据，属需决策项，本轮
  只登记不改。**核销（2026-09-14）**：已决策并落地「删任意 ≥1 骨架步」扩守卫
  （`hasShortcut` ② 段，只换 witness 不换骨架池），作废历史 follow 数据已在「A 落地后
  复跑」条如实登记（G2.2 0.90→0.825；S_follow 冒烟 0.244 无提升，替换型残留待 Phase 2
  轨迹约束）。
- **DAgger 编排落地（本轮）**：`runner/dagger.ts` 按 C.5 实现 on-path 干预（off-prefix
  不打标、老师干预后续跑、`maxFixes=4`、训练/评估出口回调注入，不 spawn Python）；
  `tests/dagger.test.ts` 13 项；偏离步/首次偏离步位统计供 G2.1 消费。G2.1 为**诊断项**
  （不作晋级门槛），「与纯 BC 的 held-out 差」需 BC+DAgger 双模型训练批次，门禁接线随
  Phase 2 实验批次回填。
- **`runScale` 断点续跑（本轮工具）**：新增 `resume?: boolean`（缺省 false，全新 run
  行为不变）——bin 与 weights 均已存在时跳过重构建/重训，供长跑被外部资源竞争中断后
  复用已落盘确定性产物；第二跑首轮于 N=30000 s2 训练被中断即以此续跑。
