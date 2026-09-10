# run_result（core/run_result）

单次 run 的配置面与结果面纯数据契约：`RunOptions`（DI 注入字段 + 成本护栏 +
机制开关）与 `RunResult`（最终状态/终止原因/中断点/事件统计）；执行语义在
`kernel/executor`，本模块只承载形态。

## 文件
- `run_result.ts` — `RunOptions`/`RunResult` 数据契约、`MultipathAssemblySeam`
  多径组装上下文 seam 形态、`AssemblySourcesProvider` 装配源提供者协议
  （`run_result.py` 移植）。

## 依赖
- 上游（本目录实际 import）：`core/`（plan——值引 `DEFAULT_MAX_PLAN_STEPS`、
  storage、state、events、registry、assembly、workflow、edge_evidence）+
  `kernel/`（budget、interrupt、simulation——值引 `DEFAULT_MAX_SIMULATIONS`、
  tuning、settle，均 type import）。
- 下游（实际 import 本目录）：`kernel/executor`（全链 + index 转出
  `RunOptions`/`RunResult`）、`kernel/runtime`、`kernel/multipath`、
  `kernel/path_assembler`（type）、`kernel/settle`（type）、
  `core/execution_runtime`；公共面 `src/index.ts` `export *`；
  hosts/lib 经公共面消费 `RunOptions`；测试 `test/core/run_result`、
  `test/kernel/{executor,runtime,multipath,settle}`、`test/core/nodes`。
