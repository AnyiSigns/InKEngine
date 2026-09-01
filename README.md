# InKEngine

InKling 的仓库：受控自进化运行时（ink_engine）+ 受控自进化智能体
InKling（inkling/）。

## 仓库构成

- **ink_engine/** — 通用 agent 机制**运行时**（受控自进化运行时，
  Controlled Self-Evolving Runtime）：图执行、checkpoint 版本链、事件流、
  interrupt、补丁链、运行时重规划、决策点推演、知识孵化、输入调配管线、
  自指演化、宿主运行时装配。一切演化（图/规则/知识/工具/界面/实体）都
  是补丁链数据——**每次变化经审批、可审计、可回退**，演化全程受控。
  核心零运行时依赖，sqlite/postgres/llm/mcp 为可选 extra。
   文档集见 `ink_engine/docs/`（概念/扩展点/架构/宿主接入/安全模型）；
   教学资产（内容中性示例领域演示完整链路，规划待建）计划落
   `ink_engine/examples/domain_template/`，建成前机制演示以
   `ink_engine/examples/e2e` 与出厂自检门禁为准。
- **inkling/** — InKling：**受控自进化智能体**（本地单机桌面产品）。
  你用得越多，它越懂你的领域，且每一次变化都经审批、可审计、可回退：
  种子数据 JSON（`inkling/seed_data/`）/ Rust 执行件（`inkling/exec/`）/
  TS 前端（`inkling/frontend/`）/ Tauri 桌面壳（`inkling/shell/`，嵌入式
  Python 引擎桥 + Rust 域层）/ 出厂自检编排（`inkling/self_check/`，
  七门禁一键矩阵化报告）。
   出厂自检命令以 `inkling/manifest.json` 的 `self_check` 为单一事实源，
   全部七门禁（schema 数据一致性 / cargo 三 crate / frontend
   typecheck+vitest / 接线 e2e / 代码纪律 / 公开评测基准 / 符号引用计数）
   经自检编排统一执行：
   `cargo run --release --manifest-path inkling/self_check/Cargo.toml -- all`。
   产品手册见 `inkling/docs/manual.md`，机制覆盖审计见
   `inkling/docs/mechanism_coverage_matrix.md`，身份登记见
   `inkling/manifest.json`。
    安全边界：**headless 无人值守模式不设人工审批，仅限可信自动化场景**
   （`--approve` 由调用方显式声明即放行 review 档；外部调用链须自证可信）。
   headless 二进制运行期需嵌入式 Python 的 `pythonXY.dll` 可加载（调用前把
   对应 CPython 安装目录加入 `PATH`，否则启动即退出码 `0xC0000135`）。


## 历史形态

本仓库原为 TextForge 仓库（含 Forge 桌面壳 `text_forge_evo/`），经
subtree split 分离，各自完整历史保留于本仓库（`git log` 可见双根）。
Forge 未来可能移除——本仓库的产品重心是 InKling 单一产品。
