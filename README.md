# InKEngine

自学习 agent 引擎与 Forge 桌面壳双项目仓库。

## 仓库构成

- **ink_engine/** — 通用 agent 机制引擎内核：图执行、checkpoint 版本链、事件流、interrupt、补丁链、运行时重规划、决策点推演、知识集孵化、输入调配管线。核心零运行时依赖，llm/sqlite/postgres 为可选 extra。
- **text_forge_evo/** — Forge：AI 桌面壳（Tauri 前端 + FastAPI 后端 + SSE 传输 + 审批容器）。通过 `[tool.uv.sources]` 以 `../ink_engine` 路径依赖本仓库的引擎源码，editable 开发。

## 历史形态

两项目原同居 TextForge 仓库，经 subtree split 分离至此，各自完整历史保留于本仓库（`git log` 可见双根），互不侵入。
