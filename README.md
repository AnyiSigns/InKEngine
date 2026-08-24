# InKEngine

自学习 agent 引擎、种子生态仓库与 Forge 桌面壳的仓库。

## 仓库构成

- **ink_engine/** — 通用 agent 机制引擎内核（Self-Evolving Runtime）：
  图执行、checkpoint 版本链、事件流、interrupt、补丁链、运行时重规划、
  决策点推演、知识集孵化、输入调配管线、自指演化、宿主运行时装配。
  核心零运行时依赖，sqlite/postgres/llm/mcp 为可选 extra。
  文档集见 `ink_engine/docs/`（概念/扩展点/架构/宿主接入/安全模型）。
- **seeds/** — 种子生态仓库（目录即清单）：产品种子身份登记
  （text_forge_evo 等产品形态保持独立应用目录，在此登记）；领域深度
  归宿主产品层（领域规则/样例/谓词由产品自写并成对维护），引擎只带
  通用种子与 boot 自举基线。登记明细见 `seeds/README.md`。
  - 登记明细见 `seeds/README.md`。
- **inkling/** — InKling：自进化认知伙伴（本地单机桌面产品）。你用得
  越多，它越懂你的领域：种子数据 JSON（`inkling/seed_data/`）/
  Rust 执行件（`inkling/exec/`）/ TS 前端（`inkling/frontend/`）/
  Tauri 桌面壳（`inkling/shell/`，嵌入式 Python 引擎桥 + Rust 域层）/
  出厂自检编排（`inkling/self_check/`，四门禁一键矩阵化报告）。
  出厂自检命令以 `inkling/manifest.json` 的 `self_check` 为单一事实源，
  全部四门禁（schema 数据一致性 / cargo 三 crate / frontend
  typecheck+vitest / 接线 e2e）经自检编排统一执行：
  `cargo run --release --manifest-path inkling/self_check/Cargo.toml -- all`。
  机制覆盖审计见 `inkling/docs/mechanism_coverage_matrix.md`，身份登记见
  `inkling/manifest.json`。
- **text_forge_evo/** — Forge：AI 桌面壳（Tauri 前端 + FastAPI 后端 +
  SSE 传输 + 审批容器）。通过 `[tool.uv.sources]` 以 `../ink_engine`
  路径依赖本仓库的引擎源码，editable 开发。

## 历史形态

两项目原同居 TextForge 仓库，经 subtree split 分离至此，各自完整历史
保留于本仓库（`git log` 可见双根），互不侵入。
