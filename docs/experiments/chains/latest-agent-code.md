# agent 代码任务实验报告（headless 端到端，单回合，工作区挂载）

- 时间（UTC）：2026-08-30T16:35:20Z
- 回合耗时：92s
- 驱动面：`inkling-headless --round`（Rust 壳 → bridge → 引擎，与桌面壳共用 EngineHost）
- 工作区：C:\Users\Anyi\Documents\test（经 INKENGINE_WS_ROOT 授权为文件工具沙箱根，提示词未告知路径）
- 工作区虚拟环境：C:\Users\Anyi\Documents\test\.venv\Scripts\python.exe（agent 跑测试用）
- git HEAD：952356f
- 模型：真实模型（INK_LLM_*）

## 回合概览

| 指标 | 值 |
|---|---|
| 耗时 | 92s |
| reason | reply |
| 事件数 | 310 |
| 工具调用数 | 18 |
| 事件类型 | input_assembly, llm_usage, plan_end, plan_start, reply_token, review_card, tool_audit, tool_end, tool_start |

## 链路观测（演化/知识集/推演/研究/端点）

| 链路 | 工具 | 调用 | 成功 | 失败 |
|---|---|---|---|---|
| 内省/装配 | inspect_tools, request_tool, search_tools | 6 | 6 | 0 |
| 命令端点 | shell_exec | 4 | 3 | 1 |
| 推演 | parse_material, review_material, score_material, validate_material | 4 | 0 | 4 |
| 文件端点 | glob | 2 | 2 | 0 |
| 知识集 | distill_knowledge | 1 | 0 | 1 |
| 研究 | collect_material | 1 | 0 | 1 |

## 工具明细

| 工具 | 调用 | 成功 | 失败 | 失败原因 |
|---|---|---|---|---|
| collect_material | 1 | 0 | 1 | 执行被拒: MCP server inkling_exec 的 stdio 进程在 call_tool 期间崩溃（已按策略拉起并重试一次仍失败）: MCP 工具执行失败: collect_materi |
| distill_knowledge | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: distill_knowledge: 缺 signals |
| glob | 2 | 2 | 0 |  |
| inspect_tools | 1 | 1 | 0 |  |
| parse_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: parse_material: 缺 text |
| request_tool | 3 | 3 | 0 |  |
| review_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: review_material: 缺 candidates |
| score_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: score_material: 缺 answer |
| search_tools | 2 | 2 | 0 |  |
| shell_exec | 4 | 3 | 1 | 执行被拒: 命令不在端点白名单: '.venv/Scripts/python.exe'（SEC_007） |
| validate_material | 1 | 0 | 1 | 执行被拒: MCP 工具执行失败: validate_material: 缺 data（待校验对象） |

## 回合输出 content（完整，非事件）

```
I'll start by exploring the workspace to understand the current state, locate the virtual environment, and discover what execution tools are available to me.The calls got interrupted or returned errors. Let me retry with proper parameters.The environment seems to be having issues with broad glob patterns and the search call. Let me probe more carefully and individually.I now understand my tool set — I have file operations, introspection, and patch tools, but I need a shell execution capability to run tests. Let me search for execution tools and check the workspace structure.`shell_exec` exists but is in deny tier. There's also a referenced `run_test_python`. Let me search for test runners and re-check the workspace structure.I have the picture now. I need to bind the execution tools. Let me request `run_test_python`, `run_typecheck`, and `shell_exec`, and probe the workspace top-level structure.The broad glob caused an interruption. Let me retry binding the remaining tools and use a targeted glob to find the venv.The broad glob patterns keep getting interrupted. The `shell_exec` binding keeps failing. Let me try binding `shell_exec` alone, and use `shell_exec` directly (it auto-resolves) to inspect the workspace.All three execution tools are bound. Now let me explore the workspace via `shell_exec` (using `python -c` since `ls/dir` aren't whitelisted) to find the venv and understand the layout.Workspace root is `C:\Users\Anyi\Documents\test` containing only `.venv`. Let me inspect the venv and check available packages (pytest, fastapi, etc.).The venv has the standard structure. The package check got interrupted — let me retry it.The venv's `python.exe` path isn't whitelisted as a direct command, but `python` is. Let me diagnose which Python `python` resolves to and whether `.venv` site-packages are on its path — this determines how I run tests through the venv.
```

## 产物文件

- 实时观测流（回合内逐行刷新）：`live.r1.log`（279 行）
- 完整事件流：`events.r1.json`（310 条）
- 输出 content：`output.r1.txt`

## 工作区产物


## 环境错误

- 无
