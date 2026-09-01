# AGENTS.md — 项目约定

InKEngine 仓库：受控自进化运行时（`ink_engine/`）+ 受控自进化智能体
InKling（`inkling/`）。

## 定位语（勿另起文案）

- 引擎 = **受控自进化运行时**（Controlled Self-Evolving Runtime）
- 产品 = **受控自进化智能体**（Controlled Self-Evolving Agent）
- 身份文案单一事实源：`inkling/manifest.json`（name/positioning/version）；
  前端经 `inkling/frontend/src/shared/identity.ts` 取用，schema 门禁以
  `inkling/self_check/src/schema.rs` 定稿常量核对原文——改定位只改
  manifest + schema 定稿常量。

## 验证命令

- 引擎单测：`.venv\Scripts\python.exe -m pytest ink_engine\tests`
  （默认 2065 项，全量 2380 项；架构门禁随跑）
- 产品出厂自检（七门禁一键）：`cargo run --release --manifest-path
  inkling/self_check/Cargo.toml -- all`
- 前端：`npm --prefix inkling/frontend run typecheck` +
  `npm --prefix inkling/frontend run test -- --run`
- 壳 Rust：`cargo check/test --manifest-path inkling/shell/src-tauri/Cargo.toml
  --lib`（需 `PYO3_PYTHON` 指向仓库根 `.venv\Scripts\python.exe`，且 PATH
  含其 Scripts 目录）

## 维护纪律

1. **设计文档定稿须带「落地状态」栏**（设计 → 已实现/部分实现/差异，
   实现完成即回填），避免设计稿与落地长期漂移；参照
   `inkling/docs/multi_agent_design.md` 的「落地现状 vs 设计差异」节。
2. **数字先核实再写**：测试数/文件数/工具数/门禁数/字段数等表述，动文档
   前先对源码核对，勿沿用旧数字（此前多次出现 17/22、5/6、六/七门禁
   类漂移）。
3. **工具清单变更必须同步**：新增/删除/改名/数量变动须同步
   `seed_data/tools.json`（真源）及其生成物 `fixtures/tools_os.json`
   （`inkling/scripts/sync_tools_fixtures.py`）。
4. **机制层纪律由架构门禁强制**：`ink_engine/tests/test_architecture_gate.py`
   （core/ 零领域词、零宿主词、配方类型白名单、装配字段对照）；gated docs
   （api/architecture/concepts/extensions/hosts/security）改动后必须跑该门禁。
5. **演化资产写盘走受控通道**：补丁链/知识/实体/harness/事件类型等演化
   资产一律经 GuardedStorage / EvolutionWriter（补丁链 + 审计），禁止
   旁路直写。
