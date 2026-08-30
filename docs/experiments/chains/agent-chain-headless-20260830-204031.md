# agent 链连通性实验报告（headless 端到端，真实链逐环节验证）

- 时间（UTC）：2026-08-30T12:40:31Z
- 耗时：38s
- 驱动面：`inkling-headless --round`（Rust 壳 → bridge → 引擎，与桌面壳共用 EngineHost）
- git HEAD：aefd484
- 模型：INK_LLM_* 环境变量配置时走真实模型；缺省离线 StubLLM
- 代码：脚本仅驱动 + 断言，未改写任何链逻辑（壳/桥/引擎全真实）

## 实验效果

| 指标 | 实测 | 达标线 |
|---|---|---|
| 逐环节断言通过率 | 14/14 = 100% | 100% |
| 回合完成（reason=reply） | 3/3 | 100% |
| 环境错误 | 0 | 0 |

## 逐环节断言

| 回合 | 环节 | 结果 | 证据 |
|---|---|---|---|
| r1 | L1 回合完成（headless ok + reason=reply） | ✅ | ok=True reason=reply |
| r1 | L2 事件协议（assembly/plan/reply_token 落流） | ✅ | missing=[] types=['input_assembly', 'llm_usage', 'plan_end', 'plan_start', 'reply_token',  |
| r1 | L3 llm_decider（reply_token 流式） | ✅ | reply_token×16 |
| r1 | L4 tool_pipeline（tool_start/tool_end 配对） | ✅ | pairs=[('collect_material', False), ('parse_material', False), ('validate_material', False |
| r2 | L1 回合完成（headless ok + reason=reply） | ✅ | ok=True reason=reply |
| r2 | L2 事件协议（assembly/plan/reply_token 落流） | ✅ | missing=[] types=['input_assembly', 'llm_usage', 'plan_end', 'plan_start', 'reply_token',  |
| r2 | L3 llm_decider（reply_token 流式） | ✅ | reply_token×13 |
| r2 | L4 tool_pipeline（tool_start/tool_end 配对） | ✅ | pairs=[('collect_material', False), ('parse_material', False), ('validate_material', False |
| r3 | L1 回合完成（headless ok + reason=reply） | ✅ | ok=True reason=reply |
| r3 | L2 事件协议（assembly/plan/reply_token 落流） | ✅ | missing=[] types=['input_assembly', 'llm_usage', 'plan_end', 'plan_start', 'reply_token',  |
| r3 | L3 llm_decider（reply_token 流式） | ✅ | reply_token×5 |
| r3 | L4 tool_pipeline（tool_start/tool_end 配对） | ✅ | pairs=[('collect_material', False), ('parse_material', False), ('validate_material', False |
| L5 | L5 续链（r2 产出新事件 + reply_token） | ✅ | events=37 reply_token=True |
| L5 | L5 续链（r3 产出新事件 + reply_token） | ✅ | events=29 reply_token=True |

## 失败明细与分类

- 无失败（全部断言通过）。

## 执行命令

```powershell
# 离线桩模式（默认，确定性）
& ".venv\Scripts\python.exe" -X utf8 experiment\exp_agent_chain.py
# 真实模型模式（headless 门禁三要素）
$env:INK_LLM_BASE_URL = "<url>"
$env:INK_LLM_MODEL = "<model_id>"
$env:INK_LLM_API_KEY = "<key>"
& ".venv\Scripts\python.exe" -X utf8 experiment\exp_agent_chain.py
```
