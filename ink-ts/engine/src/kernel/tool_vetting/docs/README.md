# tool_vetting（kernel/tool_vetting）

工具可信度闸门：清单校验（来源/签名/哈希/权限声明）→ 静态审查钩子 → 判定
（verified/review/rejected），附观察模式（影子运行：独立工作区副本 + 写
虚拟化快照 diff，结果恒 untrusted）——fail-closed，零 IO（FsSeam 注入）。

## 文件
- `_types.ts` — 数据面：`ToolSource`/`VettingVerdict` 值面枚举类、`ToolManifest`（frozen，`from_dict` 逐项校验）、`VettingCheck`/`ShadowWrite`/`ShadowRunResult`/`VettingResult`、`StaticHook`/`ShadowExecutor`/`FsSeam`（os/shutil/tempfile 注入面 12 原语）、`pyRepr`（跨域契约模块）。
- `tool_vetting.ts` — `ToolVetting`：`vet()`（清单闸门 fail-closed + 静态审查 ENG6-7 默认 `code_files_exist` 前置钩子 + strict 降级语义）、`shadow_run()`（mkdtemp 影子区 + `_copy_tree` symlink 按链接复制 + 前后快照 diff → 写操作清单 + finally rmtree）；`unavailableFs()` 兜底 seam（未注入即抛）。
- `contract.ts` — 机制契约：id `tool_vetting`、effects 空（纯判定 + 注入 FsSeam）、depends `['permissions']`。

## 依赖
- 上游（本目录实际 import）：`core/errors`（`GraphDefinitionError`）、`core/json`（`isRecord`/`typeName`）、`kernel/permissions`（`parse_permission`）、`kernel/registry/contract_types`。
- 下游（实际 import 本目录）：`adapters/mcp`（`_fs_seam.ts` FsSeam node:fs 真实装；`convert.ts` 构造 `ToolManifest`；`manager.ts` vetting 闸门调用面；`registry.ts`/`config.ts` 用 `ToolSource`）；`kernel/runtime`（`_runtime_assemble` 构造 `new ToolVetting()`、`_runtime_base` 持有 vetting 字段、runtime contract depends 含本机制）；`kernel/registry/contracts`；公共面零导出（grep 核验）；测试 `test/kernel/tool_vetting`。
