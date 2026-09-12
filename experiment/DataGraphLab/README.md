# DataGraphLab

程序化合成数据 + 可执行验收器 + teacher 轨迹 → SFT/蒸馏的**可微路由控制器**。
设计定稿见 `.kilo/plans/1789174413324-datagraphlab-data-engine-sft-controller.md`；
本包是它的落地起点（Phase 0 的 T1/T2/T3 三件）。

## 现状（本波范围）

| 件 | 内容 | 落点 |
|---|---|---|
| T2 核心 | `makeRng`(mulberry32)、`canonicalJson`/`crc32`/`hashObj`、`t`/`deepEq`、`OPS`/`NODES_BASE`/`ROUTING`/`LEX_OPS_BASE`/`MAX_REPEAT`、`buildNodeSlots`/`NODE_SLOT` | `world/`、`controller/` |
| T1 | `LEXICON`/`GOAL_LEX`/`GOAL_TEMPLATES`、`tokens`/`mentionStats`、`renderRecipe`/`renderGoal`/`parseRecipe`，含**往返硬测试** | `world/lexicon.ts`、`world/tokenize.ts`、`world/render.ts` |
| T3 | 门禁判定脚本规格（G0.1–G0.6 + 共享 harness 契约） | `docs/gates.md` |
| 金标 | 所有示例由参考实现生成并冻结，文档同源自动生成 | `conformance/`、`docs/helpers.md` |

## 命令

```powershell
npm install
npm run typecheck          # tsc（零运行时依赖，仅 devDeps）
npm test                   # vitest：hash/rng/types/词表/往返/golden
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

## 验证结果（本次）

- `npm run typecheck`：通过。
- `npm test`：29 项通过；含穷举深度 ≤3 全部合法计划 + 3000 条深度 ≤5 随机计划的往返。
- `npm run golden:check`：fixture 与 `docs/helpers.md` 与参考实现一致。

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
