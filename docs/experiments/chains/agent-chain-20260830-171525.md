# agent 链连通性实验报告（真实链逐环节验证）

- 时间（UTC）：2026-08-30T09:15:25Z
- 耗时：1s
- 模型：stub（离线桩）
- git HEAD：43840fd
- 链：`user 输入 → boot_inkling → build_round_graph → engine.ainvoke（assembly_orchestrator → tool_pipeline ⇄ llm_decider）→ RoundSteps → reason=reply`
- 代码：import 真实实现（`inkling_host` / `bridge` / `ink_engine`），脚本仅装配 + 驱动 + 断言，未重写链逻辑

## 实验效果

| 指标 | 实测 | 达标线 |
|---|---|---|
| 回合逐环节断言通过率 | 12/18 = 67% | 100% |
| 回合完成（reason=reply） | 3/3 | 100% |
| 环境错误 | 0 | 0 |

## 逐环节断言

| 回合 | 环节 | 结果 | 证据 |
|---|---|---|---|
| r1 | L1 装配（engine/节点类型注册） | ✅ | engine=True 节点=['assembly_orchestrator', 'llm_decider', 'research_orchestrator', 'tool_pip |
| r1 | L3 回合终态（reason=reply + reply 非空） | ✅ | reason=reply reply='（stub 回复：链已通）' |
| r1 | L4 llm_decider（reply_token + round_input 开篇） | ✅ | reply_token=True opener=round_input:r1=True |
| r1 | L5 tool_pipeline（tool_start/tool_end 配对） | ✅ | pairs=[('collect_material', False), ('parse_material', False), ('validate_material', False |
| r1 | L6 事件协议（plan/reply_token 落流） | ✅ | missing=[] types=['input_assembly', 'plan_start', 'plan_end', 'input_assembly', 'tool_star |
| r1 | L7 回合步骤（tool 卡收尾 + reply 卡） | ✅ | steps=['tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'reply_token'] running_tool=[] |
| r2 | L1 装配（engine/节点类型注册） | ✅ | engine=True 节点=['assembly_orchestrator', 'llm_decider', 'research_orchestrator', 'tool_pip |
| r2 | L3 回合终态（reason=reply + reply 非空） | ✅ | reason=reply reply='（stub 回复：链已通）' |
| r2 | L4 llm_decider（reply_token + round_input 开篇） | ❌ | reply_token=False opener=round_input:r2=False |
| r2 | L5 tool_pipeline（tool_start/tool_end 配对） | ❌ | pairs=[]（本回合期望工具=True） |
| r2 | L6 事件协议（plan/reply_token 落流） | ❌ | missing=['plan_end', 'plan_start', 'reply_token'] types=[] |
| r2 | L7 回合步骤（tool 卡收尾 + reply 卡） | ✅ | steps=['tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'reply_token'] running_tool=[] |
| r3 | L1 装配（engine/节点类型注册） | ✅ | engine=True 节点=['assembly_orchestrator', 'llm_decider', 'research_orchestrator', 'tool_pip |
| r3 | L3 回合终态（reason=reply + reply 非空） | ✅ | reason=reply reply='（stub 回复：链已通）' |
| r3 | L4 llm_decider（reply_token + round_input 开篇） | ❌ | reply_token=False opener=round_input:r3=False |
| r3 | L5 tool_pipeline（tool_start/tool_end 配对） | ❌ | pairs=[]（本回合期望工具=False） |
| r3 | L6 事件协议（plan/reply_token 落流） | ❌ | missing=['plan_end', 'plan_start', 'reply_token'] types=[] |
| r3 | L7 回合步骤（tool 卡收尾 + reply 卡） | ✅ | steps=['tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'reply_token'] running_tool=[] |

## L8 跨回合续链

- ❌ system 重复/开篇缺失
- 末回合消息 ids：['7daf52e2d822443d9d371d691980faf5', 'round_input:r1', 'ab7a237b22a5454eb5c7e9ff6a19d7b6']

## 失败明细与分类

- ❌ L4 llm_decider（reply_token + round_input 开篇）：reply_token=False opener=round_input:r2=False（分类：链机制待核实）
- ❌ L5 tool_pipeline（tool_start/tool_end 配对）：pairs=[]（本回合期望工具=True）（分类：链机制待核实）
- ❌ L6 事件协议（plan/reply_token 落流）：missing=['plan_end', 'plan_start', 'reply_token'] types=[]（分类：链机制待核实）
- ❌ L4 llm_decider（reply_token + round_input 开篇）：reply_token=False opener=round_input:r3=False（分类：链机制待核实）
- ❌ L5 tool_pipeline（tool_start/tool_end 配对）：pairs=[]（本回合期望工具=False）（分类：链机制待核实）
- ❌ L6 事件协议（plan/reply_token 落流）：missing=['plan_end', 'plan_start', 'reply_token'] types=[]（分类：链机制待核实）

## 执行命令

```powershell
$env:INKENGINE_LIVE_BASE_URL = "<来源：.kilo/测试模型配置.txt 的 url 字段>"
$env:INKENGINE_LIVE_API_KEY  = "<来源：.kilo/测试模型配置.txt 的 key 字段>"
# 可选：$env:INKENGINE_EXP_MODEL = "<模型 id>"
# 离线确定性：$env:INKENGINE_EXP_STUB = "1"
& ".venv\Scripts\python.exe" -X utf8 experiment\exp_agent_chain.py
```
