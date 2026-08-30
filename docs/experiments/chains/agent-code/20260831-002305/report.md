# agent 代码任务实验报告（headless 端到端，单回合，工作区挂载）

- 时间（UTC）：2026-08-30T16:24:44Z
- 回合耗时：99s
- 驱动面：`inkling-headless --round`（Rust 壳 → bridge → 引擎，与桌面壳共用 EngineHost）
- 工作区：C:\Users\Anyi\Documents\test（经 INKENGINE_WS_ROOT 授权为文件工具沙箱根，提示词未告知路径）
- 工作区虚拟环境：C:\Users\Anyi\Documents\test\.venv\Scripts\python.exe（agent 跑测试用）
- git HEAD：952356f
- 模型：真实模型（INK_LLM_*）

## 回合概览

| 指标 | 值 |
|---|---|
| 耗时 | 99s |
| reason | reply |
| 事件数 | 314 |
| 工具调用数 | 18 |
| 事件类型 | input_assembly, llm_usage, plan_end, plan_start, reply_token, review_card, tool_audit, tool_end, tool_start |

## 链路观测（演化/知识集/推演/研究/端点）

| 链路 | 工具 | 调用 | 成功 | 失败 |
|---|---|---|---|---|
| 内省/装配 | request_tool, search_tools | 3 | 3 | 0 |
| 命令端点 | shell_exec | 1 | 0 | 1 |
| 推演 | parse_material, review_material, score_material, validate_material | 4 | 0 | 4 |
| 文件端点 | file_write, glob | 8 | 8 | 0 |
| 知识集 | distill_knowledge | 1 | 0 | 1 |
| 研究 | collect_material | 1 | 0 | 1 |

## 工具明细

| 工具 | 调用 | 成功 | 失败 | 失败原因 |
|---|---|---|---|---|
| collect_material | 1 | 0 | 1 | 执行被拒: MCP server inkling_exec 的 stdio 进程在 call_tool 期间崩溃（已按策略拉起并重试一次仍失败）: MCP 工具执行失败: collect_materi |
| distill_knowledge | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: distill_knowledge: 缺 signals |
| file_write | 1 | 1 | 0 |  |
| glob | 7 | 7 | 0 |  |
| parse_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: parse_material: 缺 text |
| request_tool | 2 | 2 | 0 |  |
| review_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: review_material: 缺 candidates |
| score_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: score_material: 缺 answer |
| search_tools | 1 | 1 | 0 |  |
| shell_exec | 1 | 0 | 1 | 执行被拒: 命令不在端点白名单: 'shell_exec'（SEC_007） |
| validate_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: validate_material: 缺 data（待校验对象） |

## 回合输出 content（完整，非事件）

```
我先探查工作区当前结构，确认虚拟环境位置与已有文件布局。glob 用法需调整。我改用更稳妥的检索方式确认工作区根与虚拟环境。glob 调用缺少必填参数 `operation`，我补上后重试。工作区在 `C:/Users/Anyi/Documents/test/`，虚拟环境 `.venv` 已存在（Python 3.14，且已预装 fastapi、click、pytest 等可用依赖）。我先确认工作区根目录下的现有内容与 Python/pytest 可用性。工作区根疑似 `C:/Users/Anyi/Documents/test/`，虚拟环境已就绪（Python 3.14，含 fastapi/click 等）。我确认一下写入根的位置，并核查关键测试/HTTP 依赖是否可用。写入根确认为 `C:/Users/Anyi/Documents/test/`。我逐个确认测试/HTTP 相关依赖是否在虚拟环境中（之前并行调用被中断，改串行）。关键依赖核查：pytest/uvicorn/httpx 似乎不在 venv 中。更重要的是——当前工具集没有 shell 执行能力，但任务要求"用虚拟环境运行测试"。我检索一下环境里是否注册了可绑定执行的工具（如运行测试/命令执行类）。已确认有 `run_test_python`、`shell_exec` 等执行类工具（当前未注入，需绑定）。我绑定它们以便后续运行测试与装依赖。`run_test_python` 已绑定。`shell_exec` 与 `run_typecheck` 绑定调用被中断，我重试绑定这两个，并先确认 venv 是否含 pytest/uvicorn/httpx/requests。`shell_exec` 已绑定。`run_typecheck` 绑定再次被中断，但 Python 项目我用 `run_test_python`（pytest 已绑定）即可覆盖验证需求，不强依赖 typecheck。先核实 venv 内关键依赖与 python 可执行路径。
```

## 产物文件

- 实时观测流（回合内逐行刷新）：`live.r1.log`（267 行）
- 完整事件流：`events.r1.json`（314 条）
- 输出 content：`output.r1.txt`

## 工作区产物

- csk_probe_xyz.txt

## 环境错误

- 无
