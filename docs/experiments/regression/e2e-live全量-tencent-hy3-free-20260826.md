# 实验报告：e2e live 套件全量重跑（全机制回归）

- 实验/测试名称：e2e live 套件全量重跑（真实模型，tencent/hy3:free）
- 实验模型：`tencent/hy3:free`（网关免费档；端点/模型来源 `.kilo/测试模型配置.txt`）
- 仓库 HEAD：`d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`
- Python：`3.14.0`（`.venv\Scripts\python.exe`）
- 套件报告（时间戳文件，非 latest.md）：`ink_engine/tests/live/report/live-report-20260826-155045.md` /
  `.json`
- 本实验报告相对路径：`docs/experiments/regression/e2e-live全量-tencent-hy3-free-20260826.md`
- 关联修复报告：`docs/experiments/regression/套件缺陷修复-20260826.md`

## 执行命令（仅环境变量名，不含 url/key 值）

```
$env:INKENGINE_LIVE_BASE_URL / INKENGINE_LIVE_API_KEY / INKENGINE_LIVE_MODEL 指向 .kilo/测试模型配置.txt
& ".venv\Scripts\python.exe" -X utf8 -m pytest ink_engine/tests/live -m live -q -p no:cacheprovider
```

## 实验时间

- 起止：约 2026-08-26 15:27 – 15:39（pytest 会话时长 705.01s / 11:45）
- 连通性探测：OK（网关可达，模型 `tencent/hy3:free` 正常应答）

## 实验效果（指标与达标线）

| 指标 | 结果 | 达标线 |
|---|---|---|
| 收集用例 | 304 | — |
| 通过 / 失败 / 跳过 | 300 / 2 / 2 | 失败最小化 |
| 真实调用轮数 | 41（熔断上限 120，未触发） | ≤120 |
| token 估算 | 14,508（熔断上限 600,000，未触发） | ≤600,000 |
| 门禁① 覆盖矩阵无孤儿模块 | ✅ | ✅ |
| 门禁② 每机制族≥1 真实用例 | 21 族全绿，**族10❌**（因 test_10 失败） | 全绿 |
| 门禁③ 叠加族(21)全绿 | ✅ | ✅ |
| 门禁④ 对抗族(22)全绿 | ✅ | ✅ |
| 门禁⑤「机制缺陷=0」（自动口径） | ❌（2 条被自动归为 mechanism） | ✅ |
| 门禁⑤「机制缺陷=0」（根因复核口径） | ✅（2 条根因为模型行为，非引擎机制） | ✅ |

> 说明：门禁⑤的自动口径在修复 `report.py` 后会将纯断言失败归入 mechanism（见关联修复报告 ③）。
> 本次 2 条失败经根因复核为**模型行为**，非引擎机制缺陷，故根因口径机制缺陷=0 达标；
> 自动口径将其「浮现待审」正是该修复的预期收益（不再漏报）。

## 失败明细与分类（根因）

### 1. `test_06_self_learning.py::test_real_llm_distiller`（族06，real）
- 分类：**model（模型行为）**
- 现象：`llm_distill` 要求模型只输出 `{"rule": {"message": <文本>}}`，真实模型返回
  `{"kind":"insight","insight":{"message":...,"context":{},"note":""}}`，未遵循输出格式约定，
  导致 `data.get("rule")` 为 None。
- 根因：模型输出格式漂移（未遵循结构化输出指令），属模型行为信号；引擎蒸馏器按约定消费模型输出，
  未见机制缺陷。

### 2. `test_10_self_evolution.py::test_real_llm_generates_self_proposal`（族10，real）
- 分类：**model（模型行为）**
- 现象：模型生成的 tool 提案 `name="lookup_example"` 含禁用字符 `_`，被命名规范校验器正确拒绝
  （`工具名 lookup_example 违反命名规范: 工具名含禁用字符 '_'`）。
- 根因：模型生成了不符合命名规范（短词自然语言、禁用下划线）的工具名，被引擎校验**正确拦截**。
  此即「模型生成违规工具名被拒」同类信号，属预期内的模型行为回归检测价值，非引擎机制缺陷。

### 跳过项（非失败，环境/配置缺失，不计入失败分类）
- `test_03_storage.py::test_postgres_when_available`：无 `POSTGRES_TEST_URL` 跳过（协议由单测覆盖）。
- `test_05_llm_full.py::test_embeddings_real`：real 标记但跳过（embedding 端点未配置）。

## 失败分类统计（根因口径）

| 类别 | 数量 | 说明 |
|---|---|---|
| mechanism（引擎机制缺陷） | 0 | 无引擎核心机制缺陷 |
| model（模型行为/输出漂移） | 2 | test_06 格式漂移、test_10 命名违规（均被正确拦截/暴露） |
| environment（环境/网络） | 0 | 连通性探测 OK |
| fuse（费用熔断） | 0 | 41/120 轮，未触发 |

## 复现

同「执行命令」。套件报告已落盘 `ink_engine/tests/live/report/live-report-20260826-155045.md`（JSON 同戳），
pytest 尾部 `[live 报告]` 行记录：通过 300 / 失败 2 / 跳过 2；真实调用 41 轮 / token 估算 14508。

## 红线遵守

- 本报告及套件报告均未出现 url / key 值；端点/模型来源统一记为 `.kilo/测试模型配置.txt`。
- 本次仅改动测试侧（test_03/test_17/report.py）3 处，引擎核心代码 `ink_engine/ink_engine/core/` 未改动。
