# 复杂项目基准 live — tencent/hy3:free

> 区域：自学习/执行闭环（复杂项目基准 live：真实 agent 改→测迭代）
> 报告日期：2026-08-26
> 仓库 HEAD：`d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`
> Python：3.14.0（`.venv\Scripts\python.exe`）

## 1. 实验/测试名称
复杂项目基准 live（SWE-bench 式简化代码任务集，真实 agent 经 file_read/file_write/file_edit 改 solution.py，框架跑测试判定）

## 2. 实验效果
| 指标 | 实测 | 达标线 | 对照 |
|---|---|---|---|
| 基线红（初始测试失败） | 20/20 | — | 全部初始红，闭环有修复空间 |
| 成功率（测试全绿） | 20/20 = **100.0%** | ≥ 80% | 达标 |
| 平均轮数 | **1.00** | ≤ 8 | 达标 |
| 测试全绿率 | 100.0% | — | 与成功率一致 |
| 耗时 | 553.51s（约 9 分 14 秒） | — | — |
| live 结论 | **达标** | 成功率≥80% 且 平均轮数≤8 | 达标 |

20 个任务全部在第 1 轮即完成修复（均 1 轮全绿），无一失败。

## 3. 实验时间
- 开始：2026-08-26 15:34:12（本地）
- 结束：2026-08-26 15:43:25（本地）
- 耗时：553.51s

## 4. 实验模型
`tencent/hy3:free`（网关免费档；端点与鉴权来源见第 6 节）

## 5. 相对文件路径
- 基准脚本：`tools/benchmarks/bench_complex_project.py`
- 任务集构建：`tools/benchmarks/bench_complex_project.py::build_tasks`（20 道 = 8 类缺陷模板 × 3 变体）
- work_root（落盘 solution.py / test_solution.py）：`C:\Users\Anyi\AppData\Local\Temp\bench_complex_live_xb0ayt1a`

## 6. 执行命令
端点与鉴权来源统一为仓库内 `.kilo/测试模型配置.txt`（url / key / model_name 字段），
通过以下环境变量注入（命令中仅写出变量名，不写出 url/key 值）：

```powershell
$env:INKENGINE_LIVE_BASE_URL = "<来源：.kilo/测试模型配置.txt 的 url 字段>"
$env:INKENGINE_LIVE_API_KEY  = "<来源：.kilo/测试模型配置.txt 的 key 字段>"
$env:INKENGINE_LIVE_MODEL    = "tencent/hy3:free"
& ".venv\Scripts\python.exe" -X utf8 tools\benchmarks\bench_complex_project.py --live --count 20
```

## 7. 失败明细与分类根因
- 失败任务：无（20/20 全绿）。
- 分类根因：无失败，无需归因。

## 8. 复现方法
1. 激活 `.venv`；确认 git HEAD 为 `d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`。
2. 按第 6 节设置 3 个环境变量（值取自 `.kilo/测试模型配置.txt`）。
3. 执行命令；落盘工程在 work_root（%TEMP% 下 `bench_complex_live_*`）。
4. 判定口径：成功率 = 全绿任务数 / 总任务数；平均轮数 = 成功任务所用轮数均值；回合上限 30；达标线 成功率≥80% 且 平均轮数≤8。
