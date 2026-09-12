# DataGraphLab 门禁判定脚本规格（G0.1–G0.6）

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
| 门禁实现 | `conformance/gates/g0N_*.ts` | 每门禁一个 `run(ctx): GateResult` |
| 结果 | `runs/<run_id>/gates/G0.N.json` | 机器可读证据（长表另存 csv） |
| 金标 | `conformance/fixtures.json` | 哈希/随机/渲染的冻结真值 |
| 断言 | `tests/gates.test.ts` | 把每个 `run()` 包成 vitest 用例 |

### 0.2 `GateResult`（唯一输出 JSON 形状，fail-fast）

```typescript
interface GateResult {
  gate: 'G0.1' | 'G0.2' | 'G0.3' | 'G0.4' | 'G0.5' | 'G0.6';
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

1. `runAll(ctx)` 依次跑 G0.1→G0.6；任一 `passed=false` 则整体 exit 1，但**继续跑完**
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

- **输入**：`(seed, style, family, split?)`；`world_version`；冻结 `nodeSlots`/`rng`/`crc32`。
- **算法**：
  1. 在两个独立进程各跑 `make_task(seed, ...)`（同参），取全部 `task_hash`；
  2. 序列化为规范 JSON（键排序），逐字节比较两进程输出；
  3. 对 fixture 中的 `makeRng(seed).next()`、`crc32(s)`、`canonicalJson(edge)` 复算比对。
- **输出 metrics**：`hash_match_ratio`、`fixture_match_count`、`fixture_case_count`。
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
- **输出 metrics**：`reject_ratio`、`accept_correct_ratio`、`case_count`。
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
- **算法**：训练 → 在 held-out 取 argmax 类别 → 统计 top-1 准确率（分类器固定、只跑一次）。
- **输出 metrics**：`top1_acc_mean`、`top1_acc_std`、`n_classes`、`heldout_per_class`、
  `encoder_iteration`（编码器迭代轮次 M）。
- **通过判据**：`top1_acc_mean ≥ 0.90`（首轮目标，实测后校准并原样记录）。
- **预注册升级规则**：编码器迭代上限 `M` 轮仍不达标 → 把 `struct`（含公开 `spec.goal`
  紧凑编码）提为**并列主臂**并在报告显式标注 benchmark 语义变化；**禁止静默替换主臂**。
- **落点**：`conformance/gates/g06_goal_separability.ts`。

---

## 附：fixture 复用与非目标

- G0.1 读取 `conformance/fixtures.json` 的冻结值复算（G0.3 的真值在
  `verify/adversarial.ts` 套件本体、G0.5 的分层在 `gen/splits.ts` 的 `STRATA`，
  不经 fixture）；文档示例同源（`docs/helpers.md` 亦由 `conformance/gen_golden.ts` 生成）。
- `npm run golden:check` 保证 fixture 与文档未漂移；门禁脚本不得内联期望数字。
- 本文件只覆盖 Phase 0 门禁；G1.x/G2.x/G4.x 沿用同一 `GateResult` 形状，在各自阶段
  补 `g1x_*`/`g2x_*`/`g4x_*`，阈值与口径以 `1789174413324-datagraphlab-data-engine-sft-controller.md`
  附录 A.2 为准。
