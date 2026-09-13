# DataGraphLab

程序化合成数据 + 可执行验收器 + teacher 轨迹 → SFT/蒸馏的**可微路由控制器**。
设计定稿见 `.kilo/plans/1789174413324-datagraphlab-data-engine-sft-controller.md`；
本包是其落地（Phase 0 已闭环，Phase 1 数据→训练闭环推进中）。

## 现状（本波已闭环）

世界层与合成数据生成器、可执行验收器、oracle 教师轨迹、内容寻址存储加六个门禁脚本
已齐备：`npm run gate` 全绿（六项），每次跑批把机器可读证据落进 `runs/gates-<stamp>/`
（六份 `G0.*.json`、两份 csv 明细、一份 run 级 `manifest.json`）。teacher/search
（`planBfs`）与 controller 三件套（features/policy/checkpoint）、数据派生层（records v2
bin）、运行/评测（rollout/metrics/arms 五臂）、Python 训练器（train.py）已落地。全套
**369 项测试（30 个文件）可重跑复现**（`npm test`，实测 2026-09-12）。
「完成」的定义里，run 级版本快照与实测数字回填均已闭环——快照随 `createGateContext`
给定 runId 时落盘，数字见「验证结果」节。

| 件 | 内容 | 落点 |
|---|---|---|
| 世界层 | `makeRng`(mulberry32)、`canonicalJson`/`crc32`/`hashObj`、`t`/`deepEq`、`OPS`/`NODES_BASE`/`ROUTING`/`LEX_OPS_BASE`/`MAX_REPEAT`、`buildNodeSlots`/`NODE_SLOT` | `world/`、`controller/` |
| 词表与渲染 | `LEXICON`/`GOAL_LEX`/`GOAL_TEMPLATES`、`tokens`/`mentionStats`、`renderRecipe`/`renderGoal`/`parseRecipe`，含**往返硬测试**、义项不变量审计 | `world/lexicon.ts`、`world/tokenize.ts`、`world/render.ts`、`world/lexicon_audit.ts` |
| 生成层 | 骨架全枚举 + 签名去冗余 + 恒等丢弃、分层切分、follow/goal 双风格、课程难度、可产性判定（goal 适格池 + 极小性守卫） | `gen/` |
| 验收与运行 | 通道收口的可执行验收器、对抗套件（静态错件 + fuzz）、沙箱、图与候选动作 | `verify/`、`runner/` |
| 教师与数据 | on-path oracle 逐步标签、teacher 规划臂 `planBfs`（BFS 最短解，不进训练集）、内容寻址 JSONL 分片 + 索引 + 两级去重、泄漏审计、多解冲突率诊断、全员版本化 manifest | `teacher/oracle.ts`、`teacher/search.ts`、`data/` |
| 控制器三件套 | 白名单特征 `featurizeObs`/`featurizeAction`、指针式 `Policy` 前向与 f32 精确随机初始化、`weights.json` 读写 + arch fail-fast + float32 执法 | `controller/features.ts`、`controller/policy.ts`、`controller/checkpoint.ts` |
| 数据派生层 | 原始 obs（store）→ 稀疏 `records.bin` v2（header 一次性存 22 节点动作特征表 + 行内 22 位全局 ROUTING 掩码 + 进度 critic 标签），featurize CLI | `data/records.ts`、`data/records_bin.ts` |
| 运行与评测 | C.7 贪心 rollout、pass@1(Wilson CI)/pathExcess/stepsOverShortest/routingAcc/ECE、五臂（heuristic/random/trained/planner/contract_route） | `runner/rollout.ts`、`eval/` |
| Python 训练器 | numpy 前向/反向/Adam/CE+smoothing+WD+进度头（数值梯度 <1e-5、记忆自检 acc≥0.99）、bin v2 解析、val CE 早停 + `--save-last-k` | `controller/train.py`、`controller/train_nn.py` |
| 门禁 | G0.1–G0.6 判据脚本 + 共享 harness（`inputs_hash` 绑定 world/manifest/fixture，失败也落盘；同时刻出 run 级 `manifest.json` 版本快照） | `conformance/gates/`、`docs/gates.md` |
| 金标 | 所有示例由参考实现生成并冻结，文档同源自动生成 | `conformance/`、`docs/helpers.md` |

## 命令

```powershell
npm install
npm run typecheck          # tsc（零运行时依赖，仅 devDeps）
npm test                   # vitest：hash/rng/types/词表/往返/生成/验收/门禁单测全量
npm run gate               # 跑 G0.1–G0.6 六门禁，证据+manifest.json 落 runs/gates-<stamp>/
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

证据 run：`runs/gates-20260913T093016/`（13 门禁 12/13，`inputs_hash` 以该 run 的
manifest.json 为准；world_version `6a596090bff1b45a`；run 级 `manifest.json` 全员版本
化快照：generator `a3dd8c5b649254a0`、acceptor `88cd318470348af5`、teacher pin
`oracle@plan_hidden`、控制器代码 `918c830d335244eb`（覆盖 controller 五件源文件
slots/features/features_struct/policy/checkpoint）、签名探针集 `ff8b77568af3b6af`）。
C.8 首跑证据：`runs/scale-20260913T083337/`（grid {1000,10000} × seeds {0,1,2}，
弱扫描口径，完整 results.json/csv + 每次训练 weights + k% 覆盖度副轴）。

- `npm run gate`：12/13 PASS（G1.2 如实红态，判据不达标不改阈值，见下）；`npm run
  typecheck` 通过；全量 `npm test` 34 文件 392 项全绿（实测 2026-09-13）。
- G0.1 确定性：跨进程 + 进程内复算逐字节一致，一致率 1.000（12 例 makeTask，
  fixture 复算 15/15 命中）。
- G0.2 可解性：728 任务 solvable 比例 1.000，hidden plan 回放穿验收失败 0。
- G0.3 验收抗投喂：58 例（静态错件 34 + fuzz 24）拒绝率 1.000，正确通道喂饱率 1.000。
- G0.4 泄漏审计：主臂特征泄漏 / 骨架重叠 / 模板重叠 / 标签冲突四指标全 0
  （5094 条记录全链检查、719 任务 join、718 回放穿验收，隔离区 8 条如实入册）。
- G0.5 分布对齐：KL(train‖heldout)=0.019958 nats < 0.05 阈值（Lidstone 平滑 α=0.5，
  N=1000/1000，9 个分层；gold 骨架 JS 散度 0.007174 仅 sanity）。
- G0.6 目标可分性：4 类 top1 准确率均值 0.9612、标准差 0.0211（5 seed：
  0.9700/0.9380/0.9520/0.9480/0.9980；每类 held-out 54 条；编码器第 2 轮）。
- G1.1 非免费午餐：random 臂 pass@1 follow=0.0000 / goal=0.0267（各 n=600，≤0.05）。
- G1.3 三臂齐全：follow=[heuristic, random, trained, contract_route]、
  goal=[random, planner, trained, contract_route]，必含 ⊆ 成立。
- F1–F4 防漂移：前向一致 max|Δ|=2.78e-17 < 1e-6；往返一致 3/3；特征单源零命中；
  规范序列化 6 例冻结期望逐字一致。
- 生成器池（gen 模块实读）：`SKELETONS` 4199、`HELDOUT_SKELETONS` 829、
  `VAL_SKELETONS` 160；held-out 骨架中 goal 域不适格 210 个（不可产注册表恰
  420 键 = 210 × goal/goal_verify 两族，follow 两族零不可产）。

### C.8 首跑结果（A.1 判定 + 三分诊断）

统计集（4×300 任务、两 style 各 600/run）：trained 臂跨 3 seed 均值——

| 指标 | N=1000 | N=10000 | A.1 目标 |
|---|---|---|---|
| S_goal (trained pass@1) | 0.370 | **0.589** | ≥ 0.50 ✅（单调上升） |
| S_follow (trained pass@1) | 0.051 | **0.256** | ≥ 0.80 ❌ |
| S_heur_follow（弱词法基线） | 0.983 | 0.983 | 对照列 |
| S_follow − S_heur | −0.932 | −0.728 | ≥ 0.05 ❌ |
| S_planner_goal（公开 BFS 上界） | 1.000 | 1.000 | 报告列 |
| S_rand（follow / goal） | 0.001 / 0.013 | — | ≤ 0.05 ✅ |
| ContractRoute（两 style） | 0.000 | 0.000 | 廉价对照列 |

诊断列：routing_acc follow 0.66→0.85（N 上升）、goal 停滞 ≈0.36；path_excess follow
N=10k ≈ −0.006（≈0，多算子巧合捷径已收敛）；steps_over_shortest goal ≈2.0–2.3；
**safe_action_conflict_rate goal 族恒 1.0（n=200/run）**——按 §6 预注册 P75 规则，
阈值=1.0，Phase 2 标签软化开启条件已满足（软化本身是 Phase 2 门禁内动作，Phase 1
不改 one-hot 标签）。k% 覆盖度副轴：goal 随 k 升高 0.56→0.33→0.41（10/25/50/75，非
单调属单 seed 噪声），follow 0.06 平台；k=100 余池空按契约报 n=0。

**G1.2 不达标如实红 + 三分诊断初判（不许改阈值，A.1/E.7）**：
- 判定式：`S_goal(10k)=0.589 ≥ 0.50` 达标；`S_follow(10k)=0.256 < 0.80`、
  `S_follow−S_heur=−0.728 < 0.05` 不达标；单调性 `S_goal(30k)≥S_goal(1k)` 因网格缺
  30000 点跳过（`monotonicity_checked=0`）。
- 失败模式归因：follow trained 端到端 ≈ routing_acc^链长（0.85^8≈0.27 ≈ 实测 0.256）=
  **逐步误差累积**，且 N=10k 时 follow 侧仅 5k 任务 / 4199 骨架 ≈ 1.2 实例/骨架——
  深度 5 骨架实例极度稀疏 → **数据覆盖** 初判为主瓶颈（N=1000→10000 follow 0.05→0.26
  仍在爬升支持此判）；表示容量侧 G0.6 已证可分、goal 0.59 可学，标签口径 on-path oracle
  精确无冲突（conflict 噪音只在 goal 族、且已预注册软化口径）。
- 下一杠杆（按计划 §7 课程序）：扩 N 至 30000 复测单调性；若仍触顶且诊断命中数据覆盖
  → 先开自模仿过滤（纯数据量手段），再考虑 KD（标签口径变化，Phase 2 门禁内）。

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
  条目全拒（G0.3 静态错件 34 类含此项）。

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
- follow 族多算子巧合捷径实测存在（极小性守卫只挡单算子+收尾捷径）：G2.2 期望非严格
  0，阈值 0.02 不变，非零如实报告作自检证据（计划 G2.2 行已同步）。
- **R3 核销（HeuristicArm 弱词法扫描，C.7 规格）**：committed 版曾用类型感知
  `parseRecipe`，实测 follow held-out pass@1=1.0，A.1 的 `S_follow−S_heur ≥ 0.05`
  结构上不可满足；已改 `weakLexicalPlan`（义项首现升序、同位命中按 LEX_OPS_BASE 固定
  序取最小、放弃类型消歧），tests 钉 seed 59/77/150 验 `取反` 恒判 neg。**S_heur 校准
  列**（N=1000 seed 0 冒烟实测）：parseRecipe 版 1.0000 vs 弱扫描版 0.9833——门禁只用
  弱扫描口径，首份正式 scale 报告须重测并附两值。
- **goal 族安全动作集冲突率（§6 预注册 P75 规则）**：首轮 N=1000 冒烟实测
  `safe_action_conflict_rate=1.0`（n=200）——按预注册规则「取首轮 conflict rate 分布
  的 P75」→ 阈值=1.0，**Phase 2 标签软化开启条件已满足**（软化本身是 Phase 2 门禁内
  动作，Phase 1 不改 one-hot 标签）；正式首跑须在统计集（4×300、多 seed）上重测确认。
- **G2.3 初始化口径降级**：计划已从「同 seed 同架构随机权重」降为「同分布同架构随机
  初始化」——TS `Policy.random`（makeRng+float32）与 Python `params_from_json`
  （default_rng+float64）逐位不同属既定实现；BC/REINFORCE 同侧同 seed 一致即可。
- 其余（DAgger/REINFORCE 臂/KD/结构进化/llm_gateway）属 Phase 2+，不提前实现。
