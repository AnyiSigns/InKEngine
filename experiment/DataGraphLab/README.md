# DataGraphLab

程序化合成数据 + 可执行验收器 + teacher 轨迹 → SFT/蒸馏的**可微路由控制器**。
设计定稿见 `.kilo/plans/1789174413324-datagraphlab-data-engine-sft-controller.md`；
本包是它的落地起点（Phase 0 的 T1/T2/T3 三件）。

## 现状（本波已闭环）

世界层与合成数据生成器、可执行验收器、oracle 教师轨迹、内容寻址存储加六个门禁脚本
已齐备：`npm run gate` 全绿（六项），每次跑批把机器可读证据落进 `runs/gates-<stamp>/`
（六份 `G0.*.json`、两份 csv 明细、一份 run 级 `manifest.json`）。teacher/search
（`planBfs`）与 controller 三件套（features/policy/checkpoint）已落地。全套 **351 项
测试（29 个文件）可重跑复现**（`npx vitest run --reporter=basic`，实测 2026-09-12）。
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
```

## 关键约束（已代码化）

- 随机一律 `makeRng(seed)`，哈希一律 `hashObj`/`crc32`；禁用 `Math.random` 与内置 `hash()`。
- 类型 `t()` 先判 Bool 再判 Int；`TYPE_LIST` 恰 6 项；`"any"` 只是 requires 通配。
- 配方族指令**必须可往返**：`render_recipe` 渲染的算子序列，`parse_recipe` 必须原样还原。
  为此义项在整条指令内全局唯一；`取反` 是 `neg`/`reverse` 的类型可判定共享义项。
- 目标族渲染只描述目标属性，绝不出现任何算子义项（否则退化成配方族）。
- 所有 helper 签名/示例见 `docs/helpers.md`（自动生成，勿手改）。

## 验证结果（收尾实测，全部读自产物）

证据 run：`runs/gates-20260912T190245/`（六门禁 `inputs_hash` 同为 `23cefb3e33f1cb8a`，
world_version `6a596090bff1b45a`；run 级 `manifest.json` 全员版本化快照：
generator `a3dd8c5b649254a0`、acceptor `88cd318470348af5`、teacher pin
`oracle@plan_hidden`、控制器代码 `918c830d335244eb`（覆盖 controller 五件源文件
slots/features/features_struct/policy/checkpoint）、签名探针集 `ff8b77568af3b6af`）。

- `npm run gate`：6/6 PASS；`npm run typecheck` 通过；全量 `npx vitest run`
  29 文件 351 项全绿（实测 2026-09-12）。
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
- 生成器池（gen 模块实读）：`SKELETONS` 4199、`HELDOUT_SKELETONS` 829、
  `VAL_SKELETONS` 160；held-out 骨架中 goal 域不适格 210 个（不可产注册表恰
  420 键 = 210 × goal/goal_verify 两族，follow 两族零不可产）。

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

- R2-P0 计划同步已落地（verdict 指纹绑定 / 恒等签名丢弃 / goal 适格池 + follow 极小性
  守卫）：实测 `SKELETONS` 4201→4199（丢 `[neg,neg]`、`[reverse,reverse]`），heldout
  830→829，goal 域不适格 211→210（注册表 422→420 键，改为 goalEligible 派生薄层）；
  判定式对计划伪代码的四处语义修正（[add3,sub1] 恒等举例、epool 漏 goal_verify、
  probe_hit 弱化式、has_shortcut 缺长度比较）待规划者复核回写计划。
- `conformance/gates/` 与 `runs/` 为 T3 规格指定的门禁落点，本文件登记，随 Phase 0
  实现落地（当前仅规格 `docs/gates.md`，未实现脚本）。
- 其余 helper（`apply_op`/`init_state`/`candidates`/`accept`/`plan_bfs`/`featurize`/
  `Policy`/`bc_train`/DAgger/arms/structure/llm_gateway）随各自 Phase 0 文件补齐。
