# 复杂项目基准 live — stepfun/step-3.7-flash:free

> 区域：自学习/执行闭环（复杂项目基准 live：真实 agent 改→测迭代）
> 报告日期：2026-08-26
> 仓库 HEAD：`d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`
> Python：3.14.0（`.venv\Scripts\python.exe`）

## 1. 实验/测试名称
复杂项目基准 live（SWE-bench 式简化代码任务集，真实 agent 经 file_read/file_write/file_edit 改 solution.py，框架跑测试判定）

## 2. 实验效果

### 运行 1
| 指标 | 实测 | 达标线 | 对照 |
|---|---|---|---|
| 基线红（初始测试失败） | 20/20 | — | 全部初始红 |
| 成功率（测试全绿） | 3/20 = **15.0%** | ≥ 80% | 未达标 |
| 平均轮数 | 1.00 | ≤ 8 | 达标 |
| 测试全绿率 | 15.0% | — | — |
| 耗时 | 195.72s | — | — |
| live 结论 | **未达标** | 成功率≥80% | 未达标 |

### 运行 2（复跑评估方差）
| 指标 | 实测 | 达标线 | 对照 |
|---|---|---|---|
| 基线红 | 20/20 | — | — |
| 成功率 | 2/20 = **10.0%** | ≥ 80% | 未达标 |
| 平均轮数 | 1.00 | ≤ 8 | 达标 |
| 测试全绿率 | 10.0% | — | — |
| 耗时 | 155.76s | — | — |
| live 结论 | **未达标** | 成功率≥80% | 未达标 |

两次运行成功率 10%–15%，稳定偏低（非偶发坏抽签），均未达线。

## 3. 实验时间
- 运行 1：2026-08-26 15:43:55 → 15:47:11（本地），耗时 195.72s
- 运行 2：2026-08-26 15:50:45 → 15:53:21（本地），耗时 155.76s

## 4. 实验模型
`stepfun/step-3.7-flash:free`（网关免费档；端点与鉴权来源见第 6 节）

## 5. 相对文件路径
- 基准脚本：`tools/benchmarks/bench_complex_project.py`
- work_root 运行 1：`C:\Users\Anyi\AppData\Local\Temp\bench_complex_live_fd79s94w`
- work_root 运行 2：`C:\Users\Anyi\AppData\Local\Temp\bench_complex_live_fwf64dks`

## 6. 执行命令
端点与鉴权来源统一为仓库内 `.kilo/测试模型配置.txt`（url / key / model_name 字段），
通过以下环境变量注入（命令中仅写出变量名，不写出 url/key 值）：

```powershell
$env:INKENGINE_LIVE_BASE_URL = "<来源：.kilo/测试模型配置.txt 的 url 字段>"
$env:INKENGINE_LIVE_API_KEY  = "<来源：.kilo/测试模型配置.txt 的 key 字段>"
$env:INKENGINE_LIVE_MODEL    = "stepfun/step-3.7-flash:free"
& ".venv\Scripts\python.exe" -X utf8 tools\benchmarks\bench_complex_project.py --live --count 20
```

## 7. 失败明细与分类根因

### 失败模式（两次合并）
几乎所有失败任务均标记为「失败（0 轮）」——即 `fix_round` 当轮未对 solution.py 产生任何修改（前后 digest 一致），框架立即 break，未进入第 2 轮。
- 运行 1 成功：boundary_2、count_even_2、add_two_3（3 个，均 1 轮）
- 运行 2 成功：sum_range_1、add_two_1（2 个，均 1 轮）
- 其余 17 / 18 个任务均为「0 轮失败」

### 佐证调查（探针，%TEMP% 内临时脚本，未改动仓库代码）
针对单个任务复刻真实基准沙箱根解析后抓取引擎事件，观察到 stepfun 的两种行为：
1. **不调用工具，直接文本回复**：多数回合 reason=`reply`、无任何 `tool_start` 事件，solution.py 保持缺陷原样未改（0 轮根因）。
2. **偶发调用工具但后继失败**：曾观察到它正确发出 file_read，但随后网关返回
   `LLM 服务端错误（Service temporarily unavailable. Please try again shortly.）`（HTTP 503），
   导致回合在写入修复前中止。

### 根因分类
- **主因：模型行为（工具调用不可靠）**。`stepfun/step-3.7-flash:free` 在给定工具集下经常以纯文本回复、不触发 file_read/file_write/file_edit，
  致使 solution.py 全程未被修改；仅少数回合成功发起工具调用并修复。对比同一引擎下 `tencent/hy3:free`（100%）与 `meituan/longcat-2.0-free`（90%）
  均稳定达标，可排除引擎机制缺陷（脚本/引擎为只读，未改动）。
- **次因：环境错误（网关偶发 503）**。探针中捕获到 `Service temporarily unavailable`，属网关免费档容量/限流不稳定，会偶发中断本就脆弱的工具链，
  对成功率有叠加负面影响。
- **加剧因素：任务集/机制（宿主 system prompt 领域错配）**。基准 live 驱动复用 `ReferenceHost` 的 Forge 自进化人格系统提示
  （见 `ink_engine/examples/e2e/host.py` 中 resolve_llm / 引擎注入的系统词），与「修 solution.py 测试」任务无直接关联，
  弱模型更易被该系统词带偏而只做文本应答。能力强的模型（tencent/meituan）可忽略错配、遵循用户指令完成任务。

### 责任归属
未达线主责属 **模型行为**（stepfun 免费模型工具调用能力不足），次责属 **环境错误**（网关 503）+ **任务集/机制**（Forge 系统词错配放大弱模型偏差）。
非引擎/脚本机制缺陷。

## 8. 复现方法
1. 激活 `.venv`；确认 git HEAD 为 `d936d1a91743b3518d3a9e3f42e7ca7bd2ee4bf8`。
2. 按第 6 节设置 3 个环境变量（值取自 `.kilo/测试模型配置.txt`，INKENGINE_LIVE_MODEL 设为本模型）。
3. 执行命令；多次运行可复现 10%–15% 的低成功率与「0 轮失败」主导模式。
4. 佐证探针（只读、置于 %TEMP%）：复刻 `LiveAgentDriver.boot` + 单任务 `run_round`，打印 `events` 可见「无 tool_start 直接 reply」或「503 中断」。
