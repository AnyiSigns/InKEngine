# TS 种子包（跨语言种子最小实现）

种子 = **数据 + 执行件 + 自检**，语言无关契约：

| 构成 | 文件 | 语言 |
|---|---|---|
| 数据（知识条目/模板） | `seed_data.json` | 纯 JSON（任何语言可生成/维护） |
| 执行件（领域工具） | `server.mjs` | TypeScript/JavaScript，MCP stdio server，**零 npm 依赖**（手写 JSON-RPC over stdio） |

装配方式（演示脚本 `examples/ts_seed_demo.py`）：

1. 数据：Python 引擎读 `seed_data.json` → 知识条目注入知识集（与语言无关）；
2. 执行件：引擎经 MCP 协议（`node server.mjs`，stdio 传输）连接，工具进工具表
   走统一流水线（权限门禁 `mcp:call:<id>` + 审计留痕）；
3. 回合：图节点经工具流水线调用 TS 执行件 → 结果回流引擎事件流。

运行（需 node）：

```bash
python -X utf8 examples/ts_seed_demo.py
```

执行件测试（免引擎）：`node examples/ts_seed_pack/server.mjs` 后按 MCP 协议
喂 JSON 行（initialize → tools/list → tools/call）。
