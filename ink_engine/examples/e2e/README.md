# e2e 参考宿主与评测任务集（评估闭环基线）

参考宿主（host.py / recipe.py / graph.py）+ 评测脚本（run.py）+ 评测
任务集（tasks/*.json）——「测试说明文档第八节」生态件交付。定位：**教学资产 +
评估基线**，非运行时资产：展示宿主形态如何以「数据」装配完整引擎
（图/种子/harness/事件/界面/工具三路/审批分级/活跃态应用目标），
可复制改造成产品宿主。

## 构成

| 文件 | 职责 |
|---|---|
| `graph.py` | **prebuilt 循环** `build_agent_graph`：开箱即用 agent 回合图（LLM 回合 → 工具分发 → 回环 → 收口），宿主只需注入 LLM/工具清单/流水线 |
| `recipe.py` | 装配配方 `build_reference_recipe`：boot 种子/harness/事件/界面基线 + 分级审批 + 自指工具三路 + TOOL 活跃态应用目标 |
| `host.py` | Host 五件套参考实现（内存存储 / 环境变量 LLM / 默认审批策略 / 事件收集 / 关停）+ `run_round` 回合驱动 + `apply_tool_patch` 机制路径工具注册 |
| `run.py` | 评测脚本：tasks/*.json → 指标报告（成功率/耗时/工具调用/审批卡/审计落链/LLM 回合数） |
| `tasks/` | 26 个评测任务（10 领域 + 5 工具 + 5 演化 + 3 长链 + 3 对抗） |
| `report/` | 评测报告输出（每次运行落 latest.json/md + 时间戳副本） |

## 用法

模型配置（与 tests/live 同口径）：`INKENGINE_LIVE_BASE_URL` /
`INKENGINE_LIVE_API_KEY` / `INKENGINE_LIVE_MODEL` 环境变量，或仓库根
`.kilo/测试模型配置.txt`（`url:` / `key:` / `model_name:` 行形态）。
缺配置 = 评测脚本明确报环境缺失退出（不空跑不假绿）。

```powershell
# 在 ink_engine/ 下（venv python）
..\.venv\Scripts\python.exe -m examples.e2e.run                # 全量 26 任务
..\.venv\Scripts\python.exe -m examples.e2e.run --list         # 任务清单
..\.venv\Scripts\python.exe -m examples.e2e.run --group adversarial  # 对抗组
..\.venv\Scripts\python.exe -m examples.e2e.run --limit 3      # 前 3 个任务冒烟
```

## 任务形态

- **chat 模式**（默认）：`input` 文本进参考宿主回合；挂卡自动
  accept 回流（最多 1 次）；断言 = 行为契约 DSL（结构/存在性，非文本
  相等）：`terminate` / `state` / `event` / `no_event` / `interrupt` /
  `audit_applied`。
- **direct 模式**（对抗任务）：不依赖模型行为，直接驱动宿主组件断言
  fail-closed：`deny`（权限/沙箱拒绝）、`retrieval_filtered`（检索
  注入剔除）。
- 可选断言带 `"optional": true`：不计入成败，随报告输出（模型行为
  方差容忍——如演化任务是否真的调用了自指工具）。

## 指标口径（评估闭环基线）

- 成功率：required 断言全过的任务 / 任务总数（按组统计）
- 平均耗时；工具调用数（tool_start 事件）；审批卡数（review_card
  事件）；审计落链数（自指管线 applied 数）；LLM 回合数
  （reply_token 事件代理）

## 与 tests/live 的分工

tests/live 验证**引擎承诺机制**（机制层正确性，59 模块契约清单门禁）；
本包验证**宿主形态**（装配/回合/评测闭环的参考实现）——两者互补：
机制正确性由 tests/live 保证，宿主上手路径由本包给出。
