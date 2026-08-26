# 复杂项目基准 live — meituan/longcat-2.0-free

> 区域：自学习/执行闭环（复杂项目基准 live：真实 agent 改→测迭代）
> 报告日期：2026-08-26
> 仓库 HEAD：`d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`
> Python：3.14.0（`.venv\Scripts\python.exe`）

## 1. 实验/测试名称
复杂项目基准 live（SWE-bench 式简化代码任务集，真实 agent 经 file_read/file_write/file_edit 改 solution.py，框架跑测试判定）

## 2. 实验效果
| 指标 | 实测 | 达标线 | 对照 |
|---|---|---|---|
| 基线红（初始测试失败） | 20/20 | — | 全部初始红 |
| 成功率（测试全绿） | 18/20 = **90.0%** | ≥ 80% | 达标 |
| 平均轮数 | **1.00** | ≤ 8 | 达标 |
| 测试全绿率 | 90.0% | — | 与成功率一致 |
| 耗时 | 645.58s（约 10 分 46 秒） | — | — |
| live 结论 | **达标** | 成功率≥80% 且 平均轮数≤8 | 达标 |

20 个任务中 18 个在第 1 轮即修复全绿；2 个任务失败（见第 7 节）。

## 3. 实验时间
- 开始：2026-08-26 15:54:10（本地）
- 结束：2026-08-26 16:04:55（本地）
- 耗时：645.58s

## 4. 实验模型
`meituan/longcat-2.0-free`（网关免费档；不在 `.kilo/测试模型配置.txt` 的 model_name 清单内，但同端点同鉴权可用；端点与鉴权来源见第 6 节）

## 5. 相对文件路径
- 基准脚本：`tools/benchmarks/bench_complex_project.py`
- work_root（落盘 solution.py / test_solution.py）：`C:\Users\Anyi\AppData\Local\Temp\bench_complex_live_1eytgqdo`

## 6. 执行命令
端点与鉴权来源统一为仓库内 `.kilo/测试模型配置.txt`（url / key / model_name 字段），
通过以下环境变量注入（命令中仅写出变量名，不写出 url/key 值）：

```powershell
$env:INKENGINE_LIVE_BASE_URL = "<来源：.kilo/测试模型配置.txt 的 url 字段>"
$env:INKENGINE_LIVE_API_KEY  = "<来源：.kilo/测试模型配置.txt 的 key 字段>"
$env:INKENGINE_LIVE_MODEL    = "meituan/longcat-2.0-free"
& ".venv\Scripts\python.exe" -X utf8 tools\benchmarks\bench_complex_project.py --live --count 20
```

## 7. 失败明细与分类根因
- 失败任务：`multiply_2`（失败，0 轮）、`reverse_str_2`（失败，0 轮）。
- 模式：两任务均标记「失败（0 轮）」，即回合未对 solution.py 产生修改（前后 digest 一致），框架立即 break。
- 根因分类：**模型行为（偶发工具调用缺失）**。对照本模型在 18 个任务上稳定 1 轮全绿，以及探针对 stepfun 的观察（弱模型偶以纯文本回复、不触发文件工具），
  可判定这两个 0 轮失败属该免费模型偶发的工具调用遗漏，非引擎/脚本机制缺陷（脚本与引擎为只读，未改动）。引擎执行闭环与沙箱根解析均正常（18/20 全绿佐证）。

## 8. 复现方法
1. 激活 `.venv`；确认 git HEAD 为 `d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`。
2. 按第 6 节设置 3 个环境变量（值取自 `.kilo/测试模型配置.txt`，INKENGINE_LIVE_MODEL 设为本模型；该模型虽未列于配置文件的 model_name 行，但同端点可用）。
3. 执行命令；落盘工程在 work_root（%TEMP% 下 `bench_complex_live_*`）。
4. 判定口径同其他模型：成功率≥80% 且 平均轮数≤8 即达标。
