# Forge · 站在 AI 上的 AI

Forge 是一个自举式全领域产品壳：引擎是骨骼，种子是基因，补丁链是
成长史。当前形态 = 对话面板 + SSE 传输 + 审批容器，围绕「AI 先观察
自身，再提案补丁」的自指层演进。

## 启动

```bash
uv run forge        # 后端单端口 8010（含前端静态托管，需先 pnpm build）
```

数据目录：`~/.textforge/sets/default/`（引擎存储/设置/进程锁），
密钥独立存放 `~/.textforge/secrets.db`；`TEXTFORGE_HOME` 可整体迁移。

## 结构

- `backend/app/` — 开局装配（boot 11 步）、进程锁、SSE 传输桥、
  自举回合循环（LLM 工具循环图）、模型三挡配置 API
- `backend/tests/` — 装配/锁/模型/回合/SSE 端到端（pytest）
- `frontend/` — Vite + React 18 + Tailwind v4；对话面板为 remastered
  Agent 面板同款资产迁移（agentStore/MessageItem/ReviewCard/SSE 系）
- `ink_engine` — 引擎内核（本目录依赖 `../ink_engine` 可编辑安装）

## 元工具

`inspect_graph / inspect_rules / inspect_knowledge / inspect_ui /
inspect_tools` 五个只读内省工具注册进引擎工具表，走标准工具流水线
（权限门禁 fail-closed / 审计留痕 / 结果截断）。
