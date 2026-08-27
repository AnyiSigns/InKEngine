# inkling_self_check — InKling 出厂自检编排

Rust 自检编排（零重依赖：仅 serde/serde_json + std 进程 spawn；不依赖壳
crate，避免 tauri/pyo3/ort 编译地狱）。六门禁一键矩阵化报告，命令事实源
= `inkling/manifest.json` 的 `self_check` 表——`all` 聚合模式**真正执行**
表内声明的命令（单一事实源不名不副实），子命令直调 = 同一门禁本进程快速
复验。

## 子命令

| 子命令 | 门禁内容 | 超时 |
| --- | --- | --- |
| `schema` | seed_data 21 文件逐文件 schema 校验 + 跨文件一致性 + 工具声明跨注册表一致性闸门 + manifest 身份定稿（含 contracts.seed_files 全量登记）+ boot_prompt 定稿 + 引擎源码事实核对（AssemblyRecipe 字段数/引擎版本）+ 工具名长度 ≤ 24 全量 + 校验器自检夹具 | 秒级 |
| `cargo` | 三 crate cargo test：`inkling/exec` / `inkling/shell/src-tauri` / 本 crate | exec 600s / shell 1800s / 自身 300s |
| `frontend` | `npm run typecheck` + `npm run test`（vitest） | 900s |
| `e2e` | 壳 crate 集成测试全量（pyo3 内嵌引擎 stub 回合）；运行前校验解释器与引擎可导入并给出修复指引；`--live` 追加 `tools/probe_reasoning_clean.py`（需 LLM key） | 2400s（探针 900s） |
| `discipline` | 代码纪律（B2 零计划痕迹）：注释/文案含计划编号或推进字眼即违例 | 秒级 |
| `benchmark` | 公开评测基准：`tools/benchmarks/run_benchmarks.py`（引擎基准 + 自举回归硬门禁；OS/复杂基准离线冒烟口径） | 900s |
| `all`（默认） | 六门禁一键矩阵化报告：**按 manifest `self_check` 表命令逐一真实执行**，任一失败非零退出 | — |

## 用法（仓库根）

```powershell
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- all
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- schema
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- cargo
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- frontend
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- e2e
cargo run --release --manifest-path inkling/self_check/Cargo.toml -- e2e --live
```

选项：`--full`（失败门禁打印完整输出尾部）、`--json`（机器可读报告）、
`--root <路径>`（仓库根覆盖；默认按编译期清单目录/工作目录逐级上溯）、
`--live`（e2e 追加推理清洁度实弹探针）。

## 本机 e2e 前置（Windows）

壳 crate 测试内嵌 Python 引擎，运行前须：

1. 仓库根 `.venv` 就绪（worktree 可建 junction 指向主仓 `.venv`：
   `New-Item -ItemType Junction -Path .venv -Target <主仓 .venv>`）；
2. `PYO3_PYTHON` 指向该 venv 的解释器（`inkling/shell/src-tauri/.cargo/config.toml`
   已按相对路径声明，环境变量显式设置时优先）；
3. Python 运行时 DLL 目录加入 PATH（如 `...\Programs\Python\Python314`；
   e2e 门禁会自动附加解释器所在目录到子进程 PATH）。

## 设计要点

- **schema 校验器**：JSON Schema 子集检查器（type 联合/properties/required/
  additionalProperties/items/minItems/maxItems/uniqueItems/enum/const/
  pattern/minLength/minimum/maximum/$ref#/definitions），schema 定义内嵌
  `schemas/*.schema.json`（随二进制打包，自包含）；内置正/反例自检夹具，
  门禁运行即验证校验器自身行为。
- **工具名校验口径**：长度 ≤ 24 全量强制（25 个出厂工具现状全过）；
  「无下划线」仅新增/自写工具经引擎侧 `validate_tool_name` 强制
  （出厂工具与 MCP 豁免，见引擎 `schema_validator.py` 命名规范事实来源）。
- **输出解码**：UTF-8 优先，GBK（代码页 936）降级（Windows 系统库
  MultiByteToWideChar），替换符兜底。
- **超时终止**：按进程树终止（Windows taskkill /T），不留孤儿编译进程。
